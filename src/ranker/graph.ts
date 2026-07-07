import { AppContext } from '../config'
import { Ranker, ContentFilter } from './types'
import { finalize } from './finalize'

// Ranker backed by the in-memory like graph. The seed (the viewer's recent
// likes) is read from Postgres — cheap, fresh, includes backfilled history —
// while curator discovery and candidate generation run in memory.
export class GraphRanker implements Ranker {
  async rank(
    ctx: AppContext,
    viewerDid: string | null,
    content: ContentFilter,
  ): Promise<string[]> {
    if (!viewerDid) return []
    const graph = ctx.graph
    if (!graph || !graph.ready) return [] // building → caller falls back to popularity
    const cfg = ctx.cfg.ranking

    const seedRows = await ctx.db
      .selectFrom('likes')
      .select('subject_uri')
      .where('liker_did', '=', viewerDid)
      .orderBy('created_at', 'desc')
      .limit(cfg.seedLimit)
      .execute()

    const seen = new Set<string>()
    const seedUris: string[] = []
    for (const r of seedRows) {
      if (!seen.has(r.subject_uri)) {
        seen.add(r.subject_uri)
        seedUris.push(r.subject_uri)
      }
    }
    if (seedUris.length === 0) {
      console.log(`[foryou] viewer=${viewerDid} seed=0 → no personalization (will fall back)`)
      return []
    }

    // Content feeds over-generate so enough candidates survive the media filter.
    const candidateLimit =
      content === 'all'
        ? cfg.maxCandidates
        : cfg.maxCandidates * cfg.mediaCandidateMultiplier
    const raw = graph.score(viewerDid, seedUris, cfg, candidateLimit)

    // Authoritative already-liked exclusion: drop every post the viewer has
    // liked recently (from Postgres — covers likes beyond the capped seed and
    // anything not yet folded into the graph). Candidates are ≤ freshnessHours
    // old, so the viewer's like of any candidate is within this window.
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

    return raw.size === 0
      ? []
      : finalize(ctx, raw, { applyPopularityPenalty: true, content, viewerDid })
  }
}
