import dotenv from 'dotenv'
import FeedGenerator from './server'
import { RankingConfig, FeedDef } from './config'

// The main feed plus optional image/video variants (all share one graph).
const buildFeeds = (): FeedDef[] => {
  const feeds: FeedDef[] = [
    { rkey: maybeStr(process.env.FEEDGEN_FEED_SHORTNAME) ?? 'for-you', content: 'all' },
  ]
  const image = maybeStr(process.env.FEEDGEN_IMAGE_FEED_RKEY)
  if (image) feeds.push({ rkey: image, content: 'image' })
  const video = maybeStr(process.env.FEEDGEN_VIDEO_FEED_RKEY)
  if (video) feeds.push({ rkey: video, content: 'video' })
  return feeds
}

const run = async () => {
  dotenv.config()
  const hostname = maybeStr(process.env.FEEDGEN_HOSTNAME) ?? 'example.com'
  const serviceDid =
    maybeStr(process.env.FEEDGEN_SERVICE_DID) ?? `did:web:${hostname}`

  const ranking: RankingConfig = {
    seedLimit: maybeInt(process.env.FEEDGEN_SEED_LIMIT) ?? 400,
    // Curator/per-curator caps bound traversal work; raise on larger datasets.
    maxCurators: maybeInt(process.env.FEEDGEN_MAX_CURATORS) ?? 1000,
    maxLikesPerCurator:
      maybeInt(process.env.FEEDGEN_MAX_LIKES_PER_CURATOR) ?? 100,
    candidateLikeWindowHours:
      maybeInt(process.env.FEEDGEN_CANDIDATE_WINDOW_HOURS) ?? 24,
    freshnessHours: maybeInt(process.env.FEEDGEN_FRESHNESS_HOURS) ?? 24,
    halfLifeHours: maybeInt(process.env.FEEDGEN_HALF_LIFE_HOURS) ?? 6,
    smoothing: maybeFloat(process.env.FEEDGEN_SMOOTHING) ?? 0.5,
    popularityPenalty:
      maybeFloat(process.env.FEEDGEN_POPULARITY_PENALTY) ?? 0.3,
    curatorBranchingPower:
      maybeFloat(process.env.FEEDGEN_CURATOR_BRANCHING_POWER) ?? 1,
    itemBranchingPower:
      maybeFloat(process.env.FEEDGEN_ITEM_BRANCHING_POWER) ?? 1,
    coraterDecay: maybeFloat(process.env.FEEDGEN_CORATER_DECAY) ?? 0,
    seedRecencyMinWeight:
      maybeFloat(process.env.FEEDGEN_SEED_RECENCY_MIN_WEIGHT) ?? 0.1,
    minEligibleRaters: maybeInt(process.env.FEEDGEN_MIN_ELIGIBLE_RATERS) ?? 0,
    maxCandidates: maybeInt(process.env.FEEDGEN_MAX_CANDIDATES) ?? 500,
    mediaCandidateMultiplier:
      maybeInt(process.env.FEEDGEN_MEDIA_CANDIDATE_MULTIPLIER) ?? 8,
    maxFeedSize: maybeInt(process.env.FEEDGEN_MAX_FEED_SIZE) ?? 1000,
    includeReplies: process.env.FEEDGEN_INCLUDE_REPLIES === 'true',
    perAuthorCap: maybeInt(process.env.FEEDGEN_PER_AUTHOR_CAP) ?? 3,
    cacheTtlSeconds: maybeInt(process.env.FEEDGEN_CACHE_TTL_SECONDS) ?? 600,
  }

  const server = FeedGenerator.create({
    port: maybeInt(process.env.FEEDGEN_PORT) ?? 3000,
    listenhost: maybeStr(process.env.FEEDGEN_LISTENHOST) ?? 'localhost',
    databaseUrl:
      maybeStr(process.env.FEEDGEN_DATABASE_URL) ??
      'postgres://postgres:postgres@localhost:5432/foryou',
    redisUrl:
      maybeStr(process.env.FEEDGEN_REDIS_URL) ?? 'redis://localhost:6379',
    jetstreamEndpoint:
      maybeStr(process.env.FEEDGEN_JETSTREAM_ENDPOINT) ??
      'wss://jetstream2.us-west.bsky.network/subscribe',
    publicAppviewUrl:
      maybeStr(process.env.FEEDGEN_PUBLIC_APPVIEW_URL) ??
      'https://public.api.bsky.app',
    publisherDid:
      maybeStr(process.env.FEEDGEN_PUBLISHER_DID) ?? 'did:example:alice',
    subscriptionReconnectDelay:
      maybeInt(process.env.FEEDGEN_SUBSCRIPTION_RECONNECT_DELAY) ?? 3000,
    rankerEngine:
      maybeStr(process.env.FEEDGEN_RANKER) === 'postgres' ? 'postgres' : 'graph',
    graph: {
      layout:
        maybeStr(process.env.FEEDGEN_GRAPH_LAYOUT) === 'arrays' ? 'arrays' : 'csr',
      windowHours:
        maybeInt(process.env.FEEDGEN_GRAPH_WINDOW_HOURS) ??
        (maybeInt(process.env.FEEDGEN_RETENTION_HOURS) ?? 72),
      rebuildIntervalMs:
        maybeInt(process.env.FEEDGEN_GRAPH_REBUILD_INTERVAL_MS) ?? 2 * 60 * 60 * 1000,
      seedLikerScanCap:
        maybeInt(process.env.FEEDGEN_GRAPH_SEED_LIKER_SCAN_CAP) ?? 20000,
      maxEdgeVisits:
        maybeInt(process.env.FEEDGEN_GRAPH_MAX_EDGE_VISITS) ?? 3000000,
    },
    feeds: buildFeeds(),
    retentionHours: maybeInt(process.env.FEEDGEN_RETENTION_HOURS) ?? 72,
    backfillTtlSeconds:
      maybeInt(process.env.FEEDGEN_BACKFILL_TTL_SECONDS) ?? 21600, // 6h
    colikerBackfill: {
      enabled: process.env.FEEDGEN_COLIKER_BACKFILL !== 'false',
      seedPosts:
        maybeInt(process.env.FEEDGEN_COLIKER_BACKFILL_SEED_POSTS) ?? 50,
      maxPages: maybeInt(process.env.FEEDGEN_COLIKER_BACKFILL_MAX_PAGES) ?? 3,
    },
    hostname,
    serviceDid,
    ranking,
  })
  await server.start()
  console.log(
    `🤖 running For You feed generator at http://${server.cfg.listenhost}:${server.cfg.port}`,
  )
}

const maybeStr = (val?: string) => {
  if (!val) return undefined
  return val
}

const maybeInt = (val?: string) => {
  if (!val) return undefined
  const int = parseInt(val, 10)
  if (isNaN(int)) return undefined
  return int
}

const maybeFloat = (val?: string) => {
  if (!val) return undefined
  const num = parseFloat(val)
  if (isNaN(num)) return undefined
  return num
}

run()
