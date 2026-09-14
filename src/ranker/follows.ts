import { AppContext } from '../config'
import { Ranker, ContentFilter } from './types'
import { finalize } from './finalize'
import { loadFollows } from './follows-backfill'
import { encodeEntry } from '../algos/feed-entry'

// "The most engaging posts from the people you follow."
//
// Deliberately the inverse of the collaborative filter next door. The CF ranker
// asks who shares your taste and divides by popularity to surface niche posts;
// this one takes the audience as given (your follow list) and lets raw
// engagement win — the traditional home-feed shape. Sharing the same finalize()
// back half means both feeds get the same decay, freshness cut, adult/reply
// filters and per-author diversification for free.
//
// Candidates come from the in-memory author index, not SQL: the query is "posts
// by these ~500 authors, liked in the last 48h", and answering that from
// Postgres would need an author index over a 1.6B-row table that exists purely
// to serve a 48h window (see graph/recent-author-index.ts).
export class FollowsRanker implements Ranker {
  async rank(
    ctx: AppContext,
    viewerDid: string | null,
    content: ContentFilter,
  ): Promise<string[]> {
    if (!viewerDid) return [] // anonymous: no follow list → popularity
    const index = ctx.authorIndex
    if (!index || !index.ready) return [] // seeding → caller falls back
    const cfg = ctx.cfg.ranking
    const follows = ctx.cfg.follows

    const authors = await loadFollows(ctx, viewerDid)
    if (authors.length === 0) {
      console.log(
        `[foryou] viewer=${viewerDid} follows=0 → no follows ranking (will fall back)`,
      )
      return []
    }

    // Content feeds over-generate so enough candidates survive the media filter.
    const candidateLimit =
      content === 'all'
        ? cfg.maxCandidates
        : cfg.maxCandidates * cfg.mediaCandidateMultiplier

    const { scores, repostedBy } = index.candidates(authors, {
      windowHours: follows.windowHours,
      minEngagement: follows.minEngagement,
      maxPostsPerAuthor: follows.maxPostsPerAuthor,
      authorNormalization: follows.authorNormalization,
      repostWeight: follows.repostWeight,
      includeReposts: follows.includeReposts,
      maxRepostsPerReposter: follows.maxRepostsPerReposter,
      limit: candidateLimit,
    })
    if (scores.size === 0) return []

    // Drop what the viewer has already liked. Candidates are at most
    // freshnessHours old, so any like of theirs on one is inside this window.
    const likedCutoff = new Date(
      Date.now() - cfg.freshnessHours * 60 * 60 * 1000,
    ).toISOString()
    const liked = await ctx.db
      .selectFrom('likes')
      .select('subject_uri')
      .where('liker_did', '=', viewerDid)
      .where('created_at', '>', likedCutoff)
      .execute()
    for (const row of liked) {
      scores.delete(row.subject_uri)
      repostedBy.delete(row.subject_uri)
    }
    if (scores.size === 0) return []

    // No popularity penalty: bubbling the most-engaged posts up IS the feed.
    const ordered = await finalize(ctx, scores, {
      applyPopularityPenalty: false,
      content,
      viewerDid,
      includeReplies: follows.includeReplies,
    })
    return ordered.length === 0
      ? ordered
      : withRepostReasons(ctx, ordered, repostedBy)
  }
}

const pairKey = (reposterDid: string, postUri: string): string =>
  `${reposterDid}\u0000${postUri}`

// Attaches the repost record that put each amplified post in the feed, so
// clients render "Reposted by …" rather than presenting a stranger's post with
// no explanation. Posts the viewer's follows wrote pass through untouched.
//
// The index deliberately does not hold repost record URIs — that would be tens
// of bytes per edge across millions of edges, to answer a question only the
// handful of posts that survive ranking ever ask. So they are looked up here,
// once, for a finished list.
//
// A post we cannot attribute is DROPPED rather than served bare: an
// unattributed stranger is precisely what the reason exists to prevent, and the
// only route here is a repost row swept or deleted between ingest and now.
const withRepostReasons = async (
  ctx: AppContext,
  ordered: string[],
  repostedBy: Map<string, string>,
): Promise<string[]> => {
  const amplified = ordered.filter((uri) => repostedBy.has(uri))
  if (amplified.length === 0) return ordered

  const reposters = [
    ...new Set(amplified.map((uri) => repostedBy.get(uri) as string)),
  ]
  const rows = await ctx.db
    .selectFrom('reposts')
    .select(['uri', 'reposter_did', 'subject_uri'])
    .where('subject_uri', 'in', amplified)
    .where('reposter_did', 'in', reposters)
    .execute()

  const byPair = new Map<string, string>()
  for (const row of rows) {
    byPair.set(pairKey(row.reposter_did, row.subject_uri), row.uri)
  }

  const out: string[] = []
  let dropped = 0
  for (const uri of ordered) {
    const by = repostedBy.get(uri)
    if (by === undefined) {
      out.push(encodeEntry(uri))
      continue
    }
    const repostUri = byPair.get(pairKey(by, uri))
    if (repostUri === undefined) {
      dropped++
      continue
    }
    out.push(encodeEntry(uri, repostUri))
  }
  if (dropped > 0) {
    console.log(
      `[foryou] follows: dropped ${dropped} repost(s) we could not attribute`,
    )
  }
  return out
}
