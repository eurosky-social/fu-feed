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

// Imports a viewer's like history in two stages, at most once per TTL (guarded
// by a Redis SET NX flag that doubles as a stampede lock). Degrades to a no-op
// (cold-start) if Redis or the viewer's PDS is unavailable.
//
// Skips entirely when the graph already holds a full seed (>= seedLimit) for the
// viewer: their newest likes are already present live from the firehose, so
// crawling their newest N likes from the PDS couldn't add anything.
//
// Stage 1 (inline): a small first slice (`inlineBackfillLimit`, ~one listRecords
// page) that the feed handler AWAITS, up to a deadline, so the very first load
// can already be personalized without the full crawl tripping the AppView's feed
// timeout. The returned promise resolves when this stage is done.
//
// Stage 2 (background, detached): tops up to the full seed (`seedLimit`) so a
// later load is personalized from the viewer's whole recent history. Runs
// un-awaited; the caller returns after stage 1.
//
// Each stage invalidates the viewer's cached lists on success so the enriched
// seed lands on the next request.
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

  const inlineLimit = ctx.cfg.ranking.inlineBackfillLimit
  const fullLimit = ctx.cfg.ranking.seedLimit

  // Skip when the graph already holds a full seed for this viewer -- the PDS
  // crawl would only re-fetch likes we already have. On a count error, fall
  // through and back fill (safe default). As the 90d graph matures more viewers
  // clear this bar and stop being crawled.
  let existing = 0
  try {
    existing = await countViewerLikes(ctx, viewerDid, fullLimit)
  } catch (err) {
    console.error(`seed count failed for ${viewerDid}; proceeding with backfill`, err)
  }
  if (existing >= fullLimit) return

  // Stage 1 (inline).
  try {
    const first = await backfillViewerLikes(ctx, viewerDid, inlineLimit)
    console.log(`⤓ inline-backfilled ${first} likes for ${viewerDid}`)
    // No-op on the first request (nothing cached yet); it matters when the caller
    // hit its deadline and already served + cached the cold-start feed, dropping
    // it so the next load is personalized.
    if (first > 0) await invalidateViewerCache(ctx, viewerDid)
  } catch (err) {
    console.error(`inline backfill failed for ${viewerDid}`, err)
    // release the flag so a later request can retry
    try {
      await ctx.redis.del(key)
    } catch {
      /* ignore */
    }
    return // don't attempt the top-up if we couldn't import the first slice
  }

  // Stage 2 (background top-up). Detached so the caller returns after stage 1.
  if (fullLimit > inlineLimit) {
    void backfillViewerLikes(ctx, viewerDid, fullLimit)
      .then((total) => {
        console.log(`⤓ backfilled ${total} likes (full) for ${viewerDid}`)
        if (total > 0) return invalidateViewerCache(ctx, viewerDid)
      })
      .catch((err) =>
        console.error(`full backfill top-up failed for ${viewerDid}`, err),
      )
  }
}

// Capped count of a viewer's likes already in the graph. Bounded by `cap` (via a
// LIMITed subquery) so it never scans a prolific viewer's whole partition; uses
// the same `liker_did` index the ranker's seed query does. Returns min(actual,
// cap), so `>= cap` means "at least a full seed".
const countViewerLikes = async (
  ctx: AppContext,
  viewerDid: string,
  cap: number,
): Promise<number> => {
  const res = await sql<{ n: number }>`
    SELECT count(*)::int AS n
    FROM (
      SELECT 1 FROM likes WHERE liker_did = ${viewerDid} LIMIT ${cap}
    ) capped
  `.execute(ctx.db)
  return res.rows[0]?.n ?? 0
}

// Pages the viewer's most-recent likes (default listRecords order is
// newest-first) up to the seed limit and inserts them into the like graph.
// Returns the number of rows written. Exported for tooling/tests.
export const backfillViewerLikes = async (
  ctx: AppContext,
  viewerDid: string,
  maxLikes: number = ctx.cfg.ranking.seedLimit,
): Promise<number> => {
  const pds = await resolvePds(ctx, viewerDid)
  if (!pds) {
    console.warn(`no PDS endpoint for ${viewerDid}; skipping backfill`)
    return 0
  }

  const agent = new AtpAgent({ service: pds })
  const seedLimit = maxLikes
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
