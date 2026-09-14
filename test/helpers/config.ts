import { FollowsConfig, GraphConfig, RankingConfig } from '../../src/config'

// Deterministic ranking config: recency/corater decays are off so a test's
// expected scores depend only on the graph structure under test.
export const rankingConfig = (
  overrides: Partial<RankingConfig> = {},
): RankingConfig => ({
  seedLimit: 400,
  maxCurators: 1000,
  maxLikesPerCurator: 100,
  candidateLikeWindowHours: 48,
  freshnessHours: 48,
  halfLifeHours: 6,
  candidateRecencyHalfLifeHours: 0,
  smoothing: 0.5,
  popularityPenalty: 0.3,
  curatorBranchingPower: 1,
  itemBranchingPower: 1,
  coraterDecay: 0,
  seedRecencyMinWeight: 0.1,
  minEligibleRaters: 1,
  maxCandidates: 1500,
  mediaCandidateMultiplier: 16,
  mediaUnknownHydrationLimit: 1500,
  maxFeedSize: 300,
  includeReplies: false,
  perAuthorCap: 2,
  authorMinGap: 5,
  cacheTtlSeconds: 900,
  inlineBackfillLimit: 100,
  inlineBackfillDeadlineMs: 1500,
  hydrationDeadlineMs: 4000,
  hydrationTtlMs: 60 * 60 * 1000,
  popularityCacheTtlSeconds: 300,
  ...overrides,
})

export const graphConfig = (overrides: Partial<GraphConfig> = {}): GraphConfig => ({
  layout: 'csr',
  // wide enough that fixtures are never cut by the retention window
  windowHours: 24 * 365,
  rebuildIntervalMs: 2 * 60 * 60 * 1000,
  seedLikerScanCap: 10000,
  maxEdgeVisits: 1_000_000,
  ...overrides,
})

const HOUR = 60 * 60 * 1000

// ISO timestamp `hours` in the past — matches the varchar format the app writes.
export const hoursAgo = (hours: number, from = Date.now()): string =>
  new Date(from - hours * HOUR).toISOString()

// Follows-feed config with the tuning knobs off, so a test's expected order
// depends only on the like counts in its fixture.
export const followsConfig = (
  overrides: Partial<FollowsConfig> = {},
): FollowsConfig => ({
  windowHours: 48,
  compactIntervalMs: 30 * 60 * 1000,
  syncTtlSeconds: 21600,
  inlineLimit: 100,
  inlineDeadlineMs: 1500,
  maxFollows: 2000,
  maxPostsPerAuthor: 200,
  minEngagement: 1,
  authorNormalization: 0,
  includeReplies: false,
  repostWeight: 2,
  includeReposts: true,
  maxRepostsPerReposter: 200,
  ...overrides,
})
