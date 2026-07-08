import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext, FeedDef } from '../config'
import { CollaborativeFilterRanker } from '../ranker/collaborative'
import { GraphRanker } from '../ranker/graph'
import { PopularityRanker } from '../ranker/popularity'
import { Ranker, ContentFilter } from '../ranker/types'
import {
  ensureViewerBackfilled,
  backfillSeedColikers,
} from '../ranker/backfill'
import {
  cacheRankedList,
  recacheRankedList,
  getRankedList,
  rankedListKey,
  getSeen,
} from '../redis'

const cfRanker: Ranker = new CollaborativeFilterRanker()
const graphRanker: Ranker = new GraphRanker()
// Concrete type (not Ranker): its rank() takes an extra cold-start language arg.
const popularityRanker = new PopularityRanker()

// Pre-compute the shared cold-start popularity set so the first cold-start
// request after boot doesn't pay the heavy GROUP-BY (see PopularityRanker).
export const prewarmColdStart = (ctx: AppContext): Promise<void> =>
  popularityRanker.warm(ctx)

// Compute-on-request with a per-(feed, viewer) Redis cache of the ranked list.
// The cached list is an IMMUTABLE snapshot: a seen-aware order is baked in once
// at compute time (unseen first, already-seen demoted to the tail as filler),
// and serving is a pure offset slice into it. That keeps pagination stable —
// the cursor offset can't desync as `seen` grows or the list is recomputed
// between requests — and stops the feed collapsing to a few/zero posts once the
// viewer has seen most of it (seen posts become filler, never dropped).
export const handler = async (
  ctx: AppContext,
  params: QueryParams,
  viewerDid: string | null,
  feed: FeedDef,
  // Normalized primary language subtags from the viewer's Accept-Language,
  // in preference order; [] when the header is absent. Used only to bias the
  // cold-start feed (see computeRanked).
  viewerLangs: string[],
) => {
  const cacheKey = rankedListKey(feed.rkey, viewerDid)
  const offset = parseCursor(params.cursor)

  let ranked = await getRankedList(ctx.redis, cacheKey)
  if (!ranked) {
    // Backfill the viewer's like history so a viewer who already has likes is
    // personalized rather than dropped to popularity. ensureViewerBackfilled runs
    // two stages (once per backfill TTL): a small inline first slice we AWAIT here
    // so the first load can personalize, plus a background top-up to the full seed
    // for later loads. We bound the wait by wall-clock (inlineBackfillDeadlineMs)
    // in addition to the inline slice's own size cap, so a slow PDS can never trip
    // the AppView's feed-fetch timeout ("feed unavailable" / "upstream
    // unreachable"): on a timeout we serve the cold-start feed now and the
    // backfill invalidates the cache when it lands, personalizing the next load.
    // Anonymous / no-history viewers get the cold-start popularity feed.
    if (viewerDid) {
      await raceDeadline(
        ensureViewerBackfilled(ctx, viewerDid),
        ctx.cfg.ranking.inlineBackfillDeadlineMs,
      )
    }
    const scored = await computeRanked(ctx, viewerDid, feed.content, viewerLangs)
    // Bake the seen-aware order in now so every page is a plain offset slice.
    ranked = await orderBySeen(ctx, viewerDid, scored)
    await cacheRankedList(
      ctx.redis,
      cacheKey,
      ranked,
      ctx.cfg.ranking.cacheTtlSeconds,
    )
    // Densify the co-liker graph for this viewer's seed posts in the background
    // (never blocks the skeleton response). On completion it invalidates this
    // viewer's cached lists so the next load reflects the denser graph.
    if (viewerDid) void backfillSeedColikers(ctx, viewerDid)
  } else if (offset === 0 && viewerDid) {
    // A no-cursor request is a refresh: re-demote posts seen since this snapshot
    // was built so the reload surfaces the next unseen posts. Cheap — reuses the
    // cached set and preserves the TTL, so the periodic recompute still brings in
    // genuinely-new graph content on schedule.
    ranked = await orderBySeen(ctx, viewerDid, ranked)
    await recacheRankedList(ctx.redis, cacheKey, ranked)
  }

  const slice = ranked.slice(offset, offset + params.limit)
  const nextOffset = offset + slice.length
  const cursor = nextOffset < ranked.length ? String(nextOffset) : undefined
  return { cursor, feed: slice.map((post) => ({ post })) }
}

// Partition the scored list into unseen-then-seen (order preserved within each
// group). A refresh surfaces fresh content first, but nothing is ever dropped —
// the seen tail is filler that keeps the feed full once the viewer has worked
// through the unseen posts, instead of collapsing to empty.
const orderBySeen = async (
  ctx: AppContext,
  viewerDid: string | null,
  scored: string[],
): Promise<string[]> => {
  if (!viewerDid) return scored
  const seen = await getSeen(ctx.redis, viewerDid)
  if (seen.size === 0) return scored
  const unseen: string[] = []
  const seenList: string[] = []
  for (const uri of scored) (seen.has(uri) ? seenList : unseen).push(uri)
  return unseen.concat(seenList)
}

const computeRanked = async (
  ctx: AppContext,
  viewerDid: string | null,
  content: ContentFilter,
  viewerLangs: string[],
): Promise<string[]> => {
  // Personalized first; fall back to popularity for anonymous / no-history
  // viewers and while the graph is still building.
  const engine = ctx.cfg.rankerEngine === 'graph' ? graphRanker : cfRanker
  let personalized: string[] = []
  try {
    personalized = await engine.rank(ctx, viewerDid, content)
  } catch (err) {
    // A personalization failure (ranker/redis/db hiccup) must never surface as a
    // feed error; degrade to the cold-start popularity feed below so the viewer
    // always gets content.
    console.error(
      `[foryou] personalized rank failed for viewer=${viewerDid}; falling back to popularity`,
      err,
    )
  }
  if (personalized.length > 0) return personalized
  // Bias the cold-start feed by the viewer's Accept-Language — but only for
  // authenticated viewers, whose ranked list is cached per-DID. Anonymous
  // viewers share one cache entry (viewerDid = null), so applying a per-request
  // header there would let one viewer's language poison every other viewer's
  // shared list; they stay global.
  const langs = viewerDid ? viewerLangs : []
  return popularityRanker.rank(ctx, viewerDid, content, langs)
}

// Awaits `p` but gives up after `ms`, resolving either way and never rejecting.
// If `p` loses the race it keeps running in the background (ensureViewerBackfilled
// handles its own errors and invalidates the viewer's cache on completion), so a
// slow backfill lands on the next load instead of blocking this response.
const raceDeadline = (p: Promise<unknown>, ms: number): Promise<void> => {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    void p
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer)
        resolve()
      })
  })
}

const parseCursor = (cursor?: string): number => {
  if (!cursor) return 0
  const n = parseInt(cursor, 10)
  return isNaN(n) || n < 0 ? 0 : n
}
