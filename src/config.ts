import { Database } from './db'
import { DidResolver } from '@atproto/identity'
import { Redis } from 'ioredis'
import { AtpAgent } from '@atproto/api'
import type { ILikeGraph } from './graph/types'
import type { ContentFilter } from './ranker/types'

// A published feed: its record rkey and the content it restricts to.
export type FeedDef = { rkey: string; content: ContentFilter }

export type AppContext = {
  db: Database
  redis: Redis
  didResolver: DidResolver
  // Unauthenticated agent against the public AppView, used to hydrate post
  // metadata (createdAt / likeCount / labels) for ranking candidates.
  publicAgent: AtpAgent
  // In-memory like-graph engine (present when rankerEngine === 'graph').
  graph?: ILikeGraph
  cfg: Config
}

export type Config = {
  port: number
  listenhost: string
  hostname: string
  serviceDid: string
  publisherDid: string
  // DID of the "picker" account that hosts the onboarding interest posts. Likes
  // on its posts are exempt from the retention sweep so those posts stay durable
  // hubs connecting interest-aligned users (see startRetentionSweep). Unset
  // disables the exemption.
  pickerDid?: string
  // Postgres connection string (pg-style URL).
  databaseUrl: string
  // Redis connection string used for the per-viewer ranked-list cache.
  redisUrl: string
  // Jetstream websocket endpoint (lightweight JSON firehose, ~1/10 the size).
  jetstreamEndpoint: string
  // Public AppView used for lazy post-metadata hydration.
  publicAppviewUrl: string
  subscriptionReconnectDelay: number
  // Which ranker computes personalized results: the in-memory graph engine
  // (fast) or the per-request Postgres CTE (simpler, slower).
  rankerEngine: 'graph' | 'postgres'
  graph: GraphConfig
  // Published feeds: the main feed plus optional content-typed variants. All
  // share the one in-memory graph; only their content filter differs.
  feeds: FeedDef[]
  // How long like edges + post metadata are retained, in hours.
  retentionHours: number
  // How long a viewer is considered "backfilled" before we re-import their
  // like history, in seconds. Doubles as the stampede lock duration.
  backfillTtlSeconds: number
  // Background densification of the co-liker graph for a viewer's seed posts
  // via app.bsky.feed.getLikes (see ranker/backfill.ts).
  colikerBackfill: ColikerBackfillConfig
  ranking: RankingConfig
}

export type ColikerBackfillConfig = {
  // master switch
  enabled: boolean
  // top-N most-recent seed posts to densify per viewer
  seedPosts: number
  // getLikes pages fetched per under-covered post (×100 likers); also a depth cap
  maxPages: number
}

// Knobs for the in-memory like-graph engine (src/graph/).
export type GraphConfig = {
  // 'arrays' = Map + number[][] adjacency (simple); 'csr' = typed-array CSR +
  // arena interners (more compact, larger windows). Both rank identically.
  layout: 'arrays' | 'csr'
  // hours of like history held in RAM (≤ Postgres retentionHours)
  windowHours: number
  // periodic full rebuild from Postgres — refreshes + applies retention/deletes
  rebuildIntervalMs: number
  // max likers scanned per seed post during curator discovery (viral guard)
  seedLikerScanCap: number
  // hard ceiling on edge visits per request (pathological-viewer guard)
  maxEdgeVisits: number
}

// Tunable knobs for the path-counting collaborative-filter ranker. All
// overridable via env (see .env.example).
export type RankingConfig = {
  // viewer's N most-recent likes used as the personalization seed
  seedLimit: number
  // cap on distinct curators (users who liked the seed posts)
  maxCurators: number
  // top-N most-recent likes considered per curator
  maxLikesPerCurator: number
  // a candidate post's like must be within this many hours
  candidateLikeWindowHours: number
  // a candidate post must have been created within this many hours
  freshnessHours: number
  // exponential time-decay half-life on post age, in hours
  halfLifeHours: number
  // exponential decay half-life on a candidate's most-recent co-liker like, in
  // hours — applied at candidate SELECTION so fresh, lightly-corroborated posts
  // compete for the top-N instead of being cut before the post-age decay runs.
  // 0 = off (pure corroboration ordering).
  candidateRecencyHalfLifeHours: number
  // path-count exponent — boosts posts reached via many independent paths
  smoothing: number
  // popularity penalty exponent: score divided by likeCount^penalty
  popularityPenalty: number
  // normalization exponents (1 = full, 0 = none)
  curatorBranchingPower: number // divide a curator's credit by their out-degree
  itemBranchingPower: number // divide a seed item's credit by its popularity
  // discounts a curator's older likes by recency rank (0 = off; 1 = only their
  // most-recent like counts)
  coraterDecay: number
  // seed weighting: most-recent like gets this weight, oldest gets 1.0, linearly
  // scaled — reduces over-reactivity to the latest likes
  seedRecencyMinWeight: number
  // a candidate needs at least this many distinct curators (0 = off)
  minEligibleRaters: number
  // how many top-scoring candidates to hydrate + finalize
  maxCandidates: number
  // content-typed feeds (image/video) over-generate to maxCandidates × this so
  // enough survive the media filter (media is a fraction of all posts). Applied
  // only when content !== 'all'; 1 = off.
  mediaCandidateMultiplier: number
  // maximum length of the ranked list cached per viewer
  maxFeedSize: number
  // include reply posts? Default false — top-level posts only
  includeReplies: boolean
  // diversification: max posts from a single author in the final list
  perAuthorCap: number
  // diversification: minimum number of slots between two posts by the same
  // author, so an author's capped posts are spread out instead of clustered.
  // Best-effort — relaxed when no other author is available (0 = off).
  authorMinGap: number
  // TTL of the cached per-viewer ranked list, in seconds
  cacheTtlSeconds: number
  // On a viewer's first request, how many of their most-recent likes to import
  // inline (a single listRecords page) so that first load can already be
  // personalized. Kept small so the crawl fits inside the AppView's feed-fetch
  // timeout; the rest of the seed accrues from the live firehose.
  inlineBackfillLimit: number
  // Wall-clock budget for that inline backfill. If the viewer's PDS is slower
  // than this, we stop waiting and serve the cold-start feed; the backfill keeps
  // running in the background and invalidates the viewer's cache when done, so
  // the next load is personalized. Must stay below the AppView's feed timeout.
  inlineBackfillDeadlineMs: number
  // How long a hydrated post_meta row is trusted before re-fetching it from the
  // AppView, in ms. Most cached fields are immutable (createdAt/author/media/
  // langs); this mainly bounds like_count staleness. Env: FEEDGEN_HYDRATION_TTL_HOURS.
  hydrationTtlMs: number
  // TTL (seconds) of the in-process cold-start popularity cache. The popularity
  // fallback is a heavy GROUP-BY over recent likes and is viewer-independent, so
  // it is computed at most once per TTL and shared across all cold-start viewers
  // (stale-while-revalidate). Env: FEEDGEN_POPULARITY_CACHE_TTL_SECONDS.
  popularityCacheTtlSeconds: number
}
