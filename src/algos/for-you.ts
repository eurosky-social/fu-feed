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
import { cacheRankedList, getRankedList, rankedListKey, getSeen } from '../redis'

const cfRanker: Ranker = new CollaborativeFilterRanker()
const graphRanker: Ranker = new GraphRanker()
const popularityRanker: Ranker = new PopularityRanker()

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
) => {
  const cacheKey = rankedListKey(feed.rkey, viewerDid)

  let ranked = await getRankedList(ctx.redis, cacheKey)
  if (!ranked) {
    // On a cache miss, import the viewer's like history so the first request is
    // already personalized (runs at most once per backfill TTL).
    if (viewerDid) await ensureViewerBackfilled(ctx, viewerDid)
    const scored = await computeRanked(ctx, viewerDid, feed.content)
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
  }

  const offset = parseCursor(params.cursor)
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
): Promise<string[]> => {
  // Personalized first; fall back to popularity for anonymous / no-history
  // viewers and while the graph is still building.
  const engine = ctx.cfg.rankerEngine === 'graph' ? graphRanker : cfRanker
  const personalized = await engine.rank(ctx, viewerDid, content)
  if (personalized.length > 0) return personalized
  return popularityRanker.rank(ctx, viewerDid, content)
}

const parseCursor = (cursor?: string): number => {
  if (!cursor) return 0
  const n = parseInt(cursor, 10)
  return isNaN(n) || n < 0 ? 0 : n
}
