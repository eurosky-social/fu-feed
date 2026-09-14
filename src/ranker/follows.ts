import { AppContext } from '../config'
import { Ranker, ContentFilter } from './types'
import { finalize } from './finalize'
import { loadFollows } from './follows-backfill'

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

    const raw = index.candidates(authors, {
      windowHours: follows.windowHours,
      minEngagement: follows.minEngagement,
      maxPostsPerAuthor: follows.maxPostsPerAuthor,
      authorNormalization: follows.authorNormalization,
      repostWeight: follows.repostWeight,
      includeReposts: follows.includeReposts,
      maxRepostsPerReposter: follows.maxRepostsPerReposter,
      limit: candidateLimit,
    })
    if (raw.size === 0) return []

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
    for (const row of liked) raw.delete(row.subject_uri)
    if (raw.size === 0) return []

    // No popularity penalty: bubbling the most-engaged posts up IS the feed.
    return finalize(ctx, raw, {
      applyPopularityPenalty: false,
      content,
      viewerDid,
      includeReplies: follows.includeReplies,
    })
  }
}
