import { ResponseType, XRPCError } from '@atproto/xrpc-server'
import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext, FeedDef } from '../config'
import { CollaborativeFilterRanker } from '../ranker/collaborative'
import { GraphRanker } from '../ranker/graph'
import { FollowsRanker } from '../ranker/follows'
import { PopularityRanker } from '../ranker/popularity'
import { Ranker } from '../ranker/types'
import {
  ensureViewerBackfilled,
  backfillSeedColikers,
} from '../ranker/backfill'
import { ensureFollowsSynced } from '../ranker/follows-backfill'
import { postUriOf, toSkeletonPost } from './feed-entry'
import {
  cacheRankedList,
  recacheRankedList,
  getRankedList,
  rankedListKey,
  getSeen,
} from '../redis'

const cfRanker: Ranker = new CollaborativeFilterRanker()
const graphRanker: Ranker = new GraphRanker()
const followsRanker: Ranker = new FollowsRanker()
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
    // Compute detached, and wait only as long as we can afford to.
    //
    // The AppView aborts a getFeedSkeleton call at 10 seconds and renders the
    // timeout as "the feed server appears to be offline" — a the-feed-is-broken
    // message, shown for a feed that is merely cold. A first load can genuinely
    // approach that: the inline import is bounded separately from hydration,
    // and if the ranker comes up empty the cold-start feed hydrates all over
    // again, each stage honouring its own deadline with nothing capping the sum.
    //
    // So losing this race means "answer now, keep working", never "abandon the
    // work": the computation runs on and caches, which is what makes telling
    // the viewer to pull again honest rather than a guess.
    const computing = prepareRanked(ctx, viewerDid, feed, viewerLangs, cacheKey)
    // A failure arriving after we stop waiting must not become an unhandled
    // rejection; while we are still waiting, the race below rethrows it.
    void computing.catch(() => {})
    const withinBudget = await raceBudget(
      computing,
      ctx.cfg.ranking.requestBudgetMs,
    )
    if (!withinBudget) {
      console.log(
        `[foryou] feed=${feed.rkey} viewer=${viewerDid ?? 'anon'} still preparing after ` +
          `${ctx.cfg.ranking.requestBudgetMs}ms; asking the client to retry`,
      )
      throw feedPreparing()
    }
    ranked = withinBudget
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
  // A cached entry is the post URI, optionally carrying the repost record that
  // put it there (see algos/feed-entry.ts).
  return { cursor, feed: slice.map(toSkeletonPost) }
}

// The cache-miss path: import whatever this feed's ranker needs to know about
// the viewer, rank, bake in the seen-aware order, and cache. Returns the list it
// cached. Runs detached from the request that started it (see handler), so it
// must own its own side effects rather than leaving any to the caller.
const prepareRanked = async (
  ctx: AppContext,
  viewerDid: string | null,
  feed: FeedDef,
  viewerLangs: string[],
  cacheKey: string,
): Promise<string[]> => {
  // Import what this feed's ranker needs about the viewer before ranking: the
  // CF feed needs their like history (its seed), the follows feed needs their
  // follow list. Both crawl the viewer's own PDS in two stages (once per TTL):
  // a small inline first slice we AWAIT here so the first load can already
  // personalize, plus a background top-up for later loads. The wall-clock bound
  // is in addition to the inline slice's own size cap, so a slow PDS cannot on
  // its own consume the request budget: on a timeout the import lands in the
  // background and invalidates this cache, personalizing the next load.
  // Anonymous / no-history viewers get the cold-start popularity feed.
  if (viewerDid) {
    await (feed.ranker === 'follows'
      ? raceDeadline(
          ensureFollowsSynced(ctx, viewerDid),
          ctx.cfg.follows.inlineDeadlineMs,
        )
      : raceDeadline(
          ensureViewerBackfilled(ctx, viewerDid),
          ctx.cfg.ranking.inlineBackfillDeadlineMs,
        ))
  }
  const scored = await computeRanked(ctx, viewerDid, feed, viewerLangs)
  // Bake the seen-aware order in now so every page is a plain offset slice.
  const ranked = await orderBySeen(ctx, viewerDid, scored)
  await cacheRankedList(
    ctx.redis,
    cacheKey,
    ranked,
    ctx.cfg.ranking.cacheTtlSeconds,
  )
  // Densify the co-liker graph for this viewer's seed posts in the background
  // (never blocks the skeleton response). On completion it invalidates this
  // viewer's cached lists so the next load reflects the denser graph. Only the
  // CF ranker traverses co-likers, so the follows feed skips this entirely.
  if (viewerDid && feed.ranker === 'cf') void backfillSeedColikers(ctx, viewerDid)
  return ranked
}

// Awaits `p` for at most `ms`, resolving to null if it loses. `p` is left
// running — the caller relies on it finishing and caching.
const raceBudget = async <T>(p: Promise<T>, ms: number): Promise<T | null> => {
  let timer: NodeJS.Timeout | undefined
  const expiry = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  try {
    return await Promise.race([p, expiry])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export const FEED_PREPARING_MESSAGE =
  'Your feed is still being prepared. Pull to refresh in a few seconds.'

// 429, deliberately, and nothing to do with rate limiting.
//
// The client chooses its headline from the error it gets back. A timeout reads
// as "the feed server appears to be offline"; every status it does not
// recognise reads as "some kind of issue occurred - please let the feed owner
// know". Both blame a feed that is merely cold, and both put a "View profile"
// button under it, which is how a cold start turns into support mail. 429 is
// the single branch that renders as "temporarily unavailable, please try again
// later" with no blame and no button — and the AppView passes any non-500
// status straight through (toDownstreamError), so the status and our own
// message both survive the hop and the message prints underneath.
const feedPreparing = (): XRPCError =>
  new XRPCError(
    ResponseType.RateLimitExceeded,
    FEED_PREPARING_MESSAGE,
    'FeedPreparing',
  )

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
  // Entries may carry a repost reason; the seen set is keyed on post URIs.
  for (const e of scored) (seen.has(postUriOf(e)) ? seenList : unseen).push(e)
  return unseen.concat(seenList)
}

const computeRanked = async (
  ctx: AppContext,
  viewerDid: string | null,
  feed: FeedDef,
  viewerLangs: string[],
): Promise<string[]> => {
  const content = feed.content
  // Personalized first; fall back to popularity for anonymous / no-history
  // viewers and while the graph or the author index is still building.
  const engine =
    feed.ranker === 'follows'
      ? followsRanker
      : ctx.cfg.rankerEngine === 'graph'
        ? graphRanker
        : cfRanker
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
