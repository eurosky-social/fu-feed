import { sql } from 'kysely'
import { AppContext } from '../config'
import { Ranker, ContentFilter } from './types'
import { finalize } from './finalize'

// Cold-start ranker for anonymous viewers and users with no likes yet: the
// most-liked recent posts, still subject to time-decay and freshness.
export class PopularityRanker implements Ranker {
  async rank(
    ctx: AppContext,
    _viewerDid: string | null,
    content: ContentFilter,
  ): Promise<string[]> {
    const cfg = ctx.cfg.ranking
    const cutoff = new Date(
      Date.now() - cfg.freshnessHours * 60 * 60 * 1000,
    ).toISOString()

    const rows = await sql<{ subject_uri: string; likes: number }>`
      SELECT subject_uri, count(*)::int AS likes
      FROM likes
      WHERE indexed_at > ${cutoff}
      GROUP BY subject_uri
      ORDER BY likes DESC
      LIMIT ${cfg.maxCandidates}
    `.execute(ctx.db)

    const rawScores = new Map<string, number>()
    for (const row of rows.rows) rawScores.set(row.subject_uri, row.likes)

    // No popularity penalty for cold start — popular posts should win.
    return finalize(ctx, rawScores, { applyPopularityPenalty: false, content })
  }
}
