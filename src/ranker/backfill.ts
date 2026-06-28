import { sql } from 'kysely'
import { createHash } from 'crypto'
import { AtpAgent } from '@atproto/api'
import { AppContext } from '../config'
import { LIKE_COLLECTION, POST_PATH } from '../subscription'
import { rankedListKey } from '../redis'

// One-time import of an account's like history so personalization works on a
// user's first request, instead of only from likes observed on the firehose
// going forward. Like records are public and listable without auth
// (com.atproto.repo.listRecords).

type BackfilledLike = {
  uri: string
  liker_did: string
  subject_uri: string
  created_at: string
  indexed_at: string
}

// Ensures a viewer's history has been backfilled at most once per TTL, using a
// Redis SET NX flag both as a one-shot guard and a stampede lock. Degrades to a
// no-op (cold-start) if Redis or the viewer's PDS is unavailable.
export const ensureViewerBackfilled = async (
  ctx: AppContext,
  viewerDid: string,
): Promise<void> => {
  const key = `foryou:backfilled:${viewerDid}`
  let won: string | null = null
  try {
    won = await ctx.redis.set(
      key,
      '1',
      'EX',
      ctx.cfg.backfillTtlSeconds,
      'NX',
    )
  } catch (err) {
    console.error('backfill flag check failed', err)
    return
  }
  if (won !== 'OK') return // already backfilled recently (or in progress)

  try {
    const n = await backfillViewerLikes(ctx, viewerDid)
    console.log(`⤓ backfilled ${n} likes for ${viewerDid}`)
  } catch (err) {
    console.error(`backfill failed for ${viewerDid}`, err)
    // release the flag so a later request can retry
    try {
      await ctx.redis.del(key)
    } catch {
      /* ignore */
    }
  }
}

// Pages the viewer's most-recent likes (default listRecords order is
// newest-first) up to the seed limit and inserts them into the like graph.
// Returns the number of rows written. Exported for tooling/tests.
export const backfillViewerLikes = async (
  ctx: AppContext,
  viewerDid: string,
): Promise<number> => {
  const pds = await resolvePds(ctx, viewerDid)
  if (!pds) {
    console.warn(`no PDS endpoint for ${viewerDid}; skipping backfill`)
    return 0
  }

  const agent = new AtpAgent({ service: pds })
  const seedLimit = ctx.cfg.ranking.seedLimit
  const pageSize = 100
  const nowIso = new Date().toISOString()

  const byUri = new Map<string, BackfilledLike>()
  let cursor: string | undefined
  while (byUri.size < seedLimit) {
    const res = await agent.com.atproto.repo.listRecords({
      repo: viewerDid,
      collection: LIKE_COLLECTION,
      limit: pageSize,
      cursor,
    })
    const records = res.data.records
    if (records.length === 0) break

    for (const rec of records) {
      const value = rec.value as any
      const subjectUri = value?.subject?.uri
      if (typeof subjectUri !== 'string' || !subjectUri.includes(POST_PATH)) {
        continue
      }
      const rawCreatedAt = value?.createdAt
      const createdAt =
        typeof rawCreatedAt === 'string' && !isNaN(Date.parse(rawCreatedAt))
          ? rawCreatedAt
          : nowIso
      byUri.set(rec.uri, {
        uri: rec.uri,
        liker_did: viewerDid,
        subject_uri: subjectUri,
        created_at: createdAt,
        indexed_at: nowIso,
      })
      if (byUri.size >= seedLimit) break
    }

    cursor = res.data.cursor
    if (!cursor) break
  }

  const rows = [...byUri.values()]
  if (rows.length === 0) return 0

  // Insert in chunks; dedupe against likes already captured from the firehose.
  const CHUNK = 500
  for (let i = 0; i < rows.length; i += CHUNK) {
    await ctx.db
      .insertInto('likes')
      .values(rows.slice(i, i + CHUNK))
      .onConflict((oc) => oc.column('uri').doNothing())
      .execute()
  }
  return rows.length
}

const resolvePds = async (
  ctx: AppContext,
  did: string,
): Promise<string | undefined> => {
  try {
    const doc = await ctx.didResolver.resolve(did)
    const services = (doc as any)?.service
    if (!Array.isArray(services)) return undefined
    const pds = services.find(
      (s: any) =>
        s?.id === '#atproto_pds' ||
        (typeof s?.id === 'string' && s.id.endsWith('#atproto_pds')),
    )
    const ep = pds?.serviceEndpoint
    return typeof ep === 'string' ? ep : undefined
  } catch (err) {
    console.error(`failed to resolve PDS for ${did}`, err)
    return undefined
  }
}

// ---- co-liker backfill -------------------------------------------------------
// Densifies the reverse index (post -> its likers) for a viewer's seed posts by
// importing their historical likers from the AppView (app.bsky.feed.getLikes) —
// the only aggregate data the co-liker step reads. This is the network-graph
// twin of backfillViewerLikes (which imports the viewer's own likes for the
// seed). It runs in the background off the feed-load path.

// Skip posts that already have at least this many likers in our table: they're
// well covered by live ingestion (and tend to be recent/viral, where a backfill
// would mostly re-fetch likes we already have).
const COVERAGE_CAP = 2000
// Fetch any given post's likers at most once per this window, across all viewers.
const POST_BACKFILL_TTL_SECONDS = 24 * 60 * 60
// How many seed posts to densify concurrently.
const COLIKER_CONCURRENCY = 8

// Imports the in-window likers of a viewer's most-recent seed posts. Bounded per
// viewer (once per backfill TTL), per post (once per day, skipped when already
// well-covered), and in depth (only likes within the retention window).
// Invalidates the viewer's cached lists on completion so the next load reflects
// the denser graph. Best-effort and self-contained — safe to call un-awaited.
export const backfillSeedColikers = async (
  ctx: AppContext,
  viewerDid: string,
): Promise<void> => {
  const cfg = ctx.cfg.colikerBackfill
  if (!cfg.enabled) return

  const lockKey = `foryou:coliker-backfill:${viewerDid}`
  let won: string | null = null
  try {
    won = await ctx.redis.set(
      lockKey,
      '1',
      'EX',
      ctx.cfg.backfillTtlSeconds,
      'NX',
    )
  } catch (err) {
    console.error('coliker backfill lock failed', err)
    return
  }
  if (won !== 'OK') return // ran recently (or in progress)

  try {
    // Cold-start gate: the backfill only ever fetches likes within the retention
    // window, and live ingestion captures every like in real time — so once the
    // likes table already spans a full retention window, the firehose has every
    // in-window like and the backfill can't add anything new. Skip it. This
    // self-disables after the ramp and re-enables automatically if retention is
    // widened, since it keys on the actual span of data (also correct across
    // restarts, where the persisted table already spans the window).
    const span = await sql<{ oldest: string | null }>`
      SELECT MIN(indexed_at) AS oldest FROM likes
    `.execute(ctx.db)
    const oldest = span.rows[0]?.oldest
    if (oldest) {
      const spanHours = (Date.now() - Date.parse(oldest)) / (60 * 60 * 1000)
      if (spanHours >= ctx.cfg.retentionHours) return
    }

    const seedRows = await ctx.db
      .selectFrom('likes')
      .select('subject_uri')
      .where('liker_did', '=', viewerDid)
      .orderBy('created_at', 'desc')
      .limit(cfg.seedPosts)
      .execute()

    const seedPosts: string[] = []
    const seenPost = new Set<string>()
    for (const r of seedRows) {
      if (!seenPost.has(r.subject_uri)) {
        seenPost.add(r.subject_uri)
        seedPosts.push(r.subject_uri)
      }
    }
    if (seedPosts.length === 0) return

    const windowCutoffMs = Date.now() - ctx.cfg.retentionHours * 60 * 60 * 1000
    let inserted = 0
    let densified = 0
    for (let i = 0; i < seedPosts.length; i += COLIKER_CONCURRENCY) {
      const batch = seedPosts.slice(i, i + COLIKER_CONCURRENCY)
      const counts = await Promise.all(
        batch.map((uri) =>
          backfillPostLikers(ctx, uri, windowCutoffMs, cfg.maxPages),
        ),
      )
      for (const n of counts) {
        if (n > 0) densified++
        inserted += n
      }
    }

    if (inserted > 0) await invalidateViewerCache(ctx, viewerDid)
    console.log(
      `⤓ co-liker backfill: ${viewerDid} densified ${densified}/${seedPosts.length} ` +
        `seed posts (+${inserted} likes)`,
    )
  } catch (err) {
    console.error(`co-liker backfill failed for ${viewerDid}`, err)
    try {
      await ctx.redis.del(lockKey) // release so a later request can retry
    } catch {
      /* ignore */
    }
  }
}

// Imports the in-window likers of a single post from the AppView, skipping any
// already in our table. Returns the number of new like edges written.
const backfillPostLikers = async (
  ctx: AppContext,
  postUri: string,
  windowCutoffMs: number,
  maxPages: number,
): Promise<number> => {
  const flagKey = `foryou:post-likers:${postUri}`
  try {
    const won = await ctx.redis.set(
      flagKey,
      '1',
      'EX',
      POST_BACKFILL_TTL_SECONDS,
      'NX',
    )
    if (won !== 'OK') return 0 // fetched recently
  } catch {
    /* redis down — proceed best-effort without the per-post guard */
  }

  // Already well-covered by live ingestion? Skip — and reuse the set to dedupe
  // against likes we already hold (live-ingested or previously backfilled).
  const existingRows = await ctx.db
    .selectFrom('likes')
    .select('liker_did')
    .where('subject_uri', '=', postUri)
    .limit(COVERAGE_CAP + 1)
    .execute()
  if (existingRows.length > COVERAGE_CAP) return 0
  const have = new Set(existingRows.map((r) => r.liker_did))

  const nowIso = new Date().toISOString()
  const rows: BackfilledLike[] = []
  let cursor: string | undefined
  try {
    for (let page = 0; page < maxPages; page++) {
      const res = await ctx.publicAgent.app.bsky.feed.getLikes({
        uri: postUri,
        limit: 100,
        cursor,
      })
      const likes = res.data.likes
      if (!likes || likes.length === 0) break

      let crossedWindow = false
      for (const like of likes) {
        const createdAt =
          typeof like.createdAt === 'string' && !isNaN(Date.parse(like.createdAt))
            ? like.createdAt
            : nowIso
        if (Date.parse(createdAt) < windowCutoffMs) {
          crossedWindow = true
          continue // older than the retention window — would be swept anyway
        }
        const likerDid = like.actor?.did
        if (typeof likerDid !== 'string' || have.has(likerDid)) continue
        have.add(likerDid)
        rows.push({
          uri: syntheticLikeUri(likerDid, postUri),
          liker_did: likerDid,
          subject_uri: postUri,
          created_at: createdAt,
          indexed_at: nowIso,
        })
      }

      cursor = res.data.cursor
      // getLikes is newest-first, so once a page crosses the window we're done;
      // maxPages is the hard cap regardless of ordering.
      if (!cursor || crossedWindow) break
    }
  } catch (err) {
    console.error(`getLikes backfill failed for ${postUri}`, err)
    try {
      await ctx.redis.del(flagKey) // allow a retry
    } catch {
      /* ignore */
    }
    return 0
  }

  if (rows.length === 0) return 0

  const CHUNK = 500
  for (let i = 0; i < rows.length; i += CHUNK) {
    await ctx.db
      .insertInto('likes')
      .values(rows.slice(i, i + CHUNK))
      .onConflict((oc) => oc.column('uri').doNothing())
      .execute()
  }
  // Make the new edges usable before the next periodic graph rebuild.
  for (const row of rows) {
    ctx.graph?.applyCreate(
      row.liker_did,
      row.subject_uri,
      Date.parse(row.created_at),
    )
  }
  return rows.length
}

const invalidateViewerCache = async (
  ctx: AppContext,
  viewerDid: string,
): Promise<void> => {
  try {
    const keys = ctx.cfg.feeds.map((f) => rankedListKey(f.rkey, viewerDid))
    if (keys.length > 0) await ctx.redis.del(...keys)
  } catch (err) {
    console.error('viewer cache invalidation failed', err)
  }
}

// A deterministic, collision-safe surrogate for the like-record URI (getLikes
// doesn't return it). Deterministic per (liker, post) so repeated backfills are
// idempotent under the primary key.
const syntheticLikeUri = (likerDid: string, subjectUri: string): string =>
  `at://${likerDid}/${LIKE_COLLECTION}/bf${createHash('sha256')
    .update(subjectUri)
    .digest('hex')
    .slice(0, 16)}`
