import { AtpAgent } from '@atproto/api'
import { AppContext } from '../config'
import { invalidateViewerCache, resolvePds } from './backfill'

// The follows feed's audience definition. Unlike the like graph, follow edges
// are not ingested from the firehose: network-wide follow traffic would be
// carried for the handful of viewers who actually use the feed. Instead each
// viewer's list is crawled from their own PDS on demand and re-crawled once per
// TTL. Follow records are public and listable without auth.

export const FOLLOW_COLLECTION = 'app.bsky.graph.follow'

type FollowRow = {
  viewer_did: string
  subject_did: string
  created_at: string
  indexed_at: string
}

// Imports a viewer's follow list at most once per TTL, guarded by a Redis SET NX
// flag that doubles as a stampede lock — the same two-stage shape as
// ensureViewerBackfilled, and for the same reason:
//
// Stage 1 (inline): one listRecords page of their most-recent follows, which the
// feed handler awaits up to a deadline so the very first load is already about
// the people they follow rather than the cold-start popularity list. Additive
// only — a partial list cannot tell a stale row from an unfollow.
//
// Stage 2 (background, detached): the full crawl up to maxFollows, written
// authoritatively so unfollows disappear. Invalidates the viewer's cached lists
// on completion, so the next load reflects the full list.
//
// Degrades to a no-op (cold-start) if Redis or the viewer's PDS is unavailable.
export const ensureFollowsSynced = async (
  ctx: AppContext,
  viewerDid: string,
): Promise<void> => {
  const cfg = ctx.cfg.follows
  const key = `foryou:follows-synced:${viewerDid}`
  let won: string | null = null
  try {
    won = await ctx.redis.set(key, '1', 'EX', cfg.syncTtlSeconds, 'NX')
  } catch (err) {
    console.error('follows sync flag check failed', err)
    return
  }
  if (won !== 'OK') return // synced recently (or in progress)

  // Stage 1 (inline).
  try {
    const first = await crawlFollows(ctx, viewerDid, cfg.inlineLimit)
    const written = await writeFollows(ctx, viewerDid, first, false)
    console.log(`⤓ inline-synced ${written} follows for ${viewerDid}`)
    // A no-op on a genuinely first request (nothing is cached yet); it matters
    // when the handler hit its deadline, served the cold-start feed and cached
    // it — dropping that so the next load uses the follow list.
    if (written > 0) await invalidateViewerCache(ctx, viewerDid, ['follows'])
  } catch (err) {
    console.error(`inline follows sync failed for ${viewerDid}`, err)
    try {
      await ctx.redis.del(key) // release so a later request can retry
    } catch {
      /* ignore */
    }
    return
  }

  // Stage 2 (background top-up + authoritative replace).
  if (cfg.maxFollows > cfg.inlineLimit) {
    void (async () => {
      const all = await crawlFollows(ctx, viewerDid, cfg.maxFollows)
      const written = await writeFollows(ctx, viewerDid, all, true)
      console.log(`⤓ synced ${written} follows (full) for ${viewerDid}`)
      await invalidateViewerCache(ctx, viewerDid, ['follows'])
    })().catch((err) =>
      console.error(`full follows sync failed for ${viewerDid}`, err),
    )
  }
}

// Pages the viewer's follow records (listRecords is newest-first) up to
// `maxFollows`. Exported for tooling/tests.
export const crawlFollows = async (
  ctx: AppContext,
  viewerDid: string,
  maxFollows: number,
): Promise<FollowRow[]> => {
  const pds = await resolvePds(ctx, viewerDid)
  if (!pds) {
    console.warn(`no PDS endpoint for ${viewerDid}; skipping follows sync`)
    return []
  }

  const agent = new AtpAgent({ service: pds })
  const pageSize = 100
  const nowIso = new Date().toISOString()
  const bySubject = new Map<string, FollowRow>()
  let cursor: string | undefined

  while (bySubject.size < maxFollows) {
    const res = await agent.com.atproto.repo.listRecords({
      repo: viewerDid,
      collection: FOLLOW_COLLECTION,
      limit: pageSize,
      cursor,
    })
    const records = res.data.records
    if (records.length === 0) break

    for (const rec of records) {
      const value = rec.value as any
      // app.bsky.graph.follow's subject is a bare DID string, not a strongRef.
      const subject = value?.subject
      if (typeof subject !== 'string' || !subject.startsWith('did:')) continue
      if (subject === viewerDid) continue // self-follows are not content
      const rawCreatedAt = value?.createdAt
      const createdAt =
        typeof rawCreatedAt === 'string' && !isNaN(Date.parse(rawCreatedAt))
          ? rawCreatedAt
          : nowIso
      bySubject.set(subject, {
        viewer_did: viewerDid,
        subject_did: subject,
        created_at: createdAt,
        indexed_at: nowIso,
      })
      if (bySubject.size >= maxFollows) break
    }

    cursor = res.data.cursor
    if (!cursor) break
  }

  return [...bySubject.values()]
}

// Writes a crawled list. `authoritative` means `rows` is the viewer's complete
// follow list, so anything else we hold for them is an unfollow and is deleted;
// a partial (inline) list only ever adds. Returns the number of rows written.
const writeFollows = async (
  ctx: AppContext,
  viewerDid: string,
  rows: FollowRow[],
  authoritative: boolean,
): Promise<number> => {
  if (authoritative) {
    let del = ctx.db.deleteFrom('follows').where('viewer_did', '=', viewerDid)
    // `not in ()` is not valid SQL, so an empty list means "they follow nobody".
    if (rows.length > 0) {
      del = del.where(
        'subject_did',
        'not in',
        rows.map((r) => r.subject_did),
      )
    }
    await del.execute()
  }
  if (rows.length === 0) return 0

  const CHUNK = 500
  for (let i = 0; i < rows.length; i += CHUNK) {
    await ctx.db
      .insertInto('follows')
      .values(rows.slice(i, i + CHUNK))
      // Refresh indexed_at rather than doing nothing: it is what the retention
      // sweep reads to decide a follow list belongs to a viewer who has stopped
      // using the feed, and a re-crawl is exactly the proof that they have not.
      .onConflict((oc) =>
        oc
          .columns(['viewer_did', 'subject_did'])
          .doUpdateSet({ indexed_at: rows[0].indexed_at }),
      )
      .execute()
  }
  return rows.length
}

// The viewer's follow list as stored, newest follows first so the maxFollows cap
// keeps the most recent ones when it bites.
export const loadFollows = async (
  ctx: AppContext,
  viewerDid: string,
): Promise<string[]> => {
  const rows = await ctx.db
    .selectFrom('follows')
    .select('subject_did')
    .where('viewer_did', '=', viewerDid)
    .orderBy('created_at', 'desc')
    .limit(ctx.cfg.follows.maxFollows)
    .execute()
  return rows.map((r) => r.subject_did)
}
