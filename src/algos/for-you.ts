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
// Posts the viewer has already seen are filtered out at serve time so a refresh
// brings new content; the cursor is an offset into the remaining list.
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
    ranked = await computeRanked(ctx, viewerDid, feed.content)
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

  // Serve unseen posts only (seen set is shared across feeds for a viewer).
  const seen = viewerDid ? await getSeen(ctx.redis, viewerDid) : null
  const visible =
    seen && seen.size > 0 ? ranked.filter((u) => !seen.has(u)) : ranked

  const offset = parseCursor(params.cursor)
  const slice = visible.slice(offset, offset + params.limit)
  const nextOffset = offset + slice.length
  const cursor = nextOffset < visible.length ? String(nextOffset) : undefined
  return { cursor, feed: slice.map((post) => ({ post })) }
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
