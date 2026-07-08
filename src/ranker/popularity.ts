import { sql } from 'kysely'
import { AppContext } from '../config'
import { Ranker, ContentFilter } from './types'
import { finalize } from './finalize'

type PopRow = { subject_uri: string; likes: number }

// Cold-start candidate set (most-liked recent posts) is viewer-independent — the
// only per-viewer step is the language bias applied later in finalize. The
// underlying query is a heavy GROUP-BY over every like in the freshness window,
// so running it per request (once per viewer cache-miss) is what makes cold-start
// loads slow enough to trip the AppView timeout. Instead compute it at most once
// per popularityCacheTtlSeconds and share it across all cold-start viewers, with
// stale-while-revalidate so no request blocks on the query after the first fill.
// Module-level: the feed generator is a single process. Keyed by content filter
// (the query's LIMIT differs for the image/video over-fetch).
const popCache = new Map<ContentFilter, { rows: PopRow[]; at: number }>()
const popInflight = new Set<ContentFilter>()

const popQuery = async (
  ctx: AppContext,
  content: ContentFilter,
): Promise<PopRow[]> => {
  const cfg = ctx.cfg.ranking
  const cutoff = new Date(
    Date.now() - cfg.freshnessHours * 60 * 60 * 1000,
  ).toISOString()
  // Content feeds over-fetch so enough survive the media filter in finalize.
  const limit =
    content === 'all'
      ? cfg.maxCandidates
      : cfg.maxCandidates * cfg.mediaCandidateMultiplier

  const res = await sql<PopRow>`
    SELECT subject_uri, count(*)::int AS likes
    FROM likes
    WHERE indexed_at > ${cutoff}
    GROUP BY subject_uri
    ORDER BY likes DESC
    LIMIT ${limit}
  `.execute(ctx.db)
  popCache.set(content, { rows: res.rows, at: Date.now() })
  return res.rows
}

const refreshInBackground = (ctx: AppContext, content: ContentFilter): void => {
  if (popInflight.has(content)) return
  popInflight.add(content)
  void popQuery(ctx, content)
    .catch((err) => console.error('[foryou] popularity refresh failed', err))
    .finally(() => popInflight.delete(content))
}

// Cold-start ranker for anonymous viewers and users with no likes yet: the
// most-liked recent posts, still subject to time-decay and freshness. When the
// viewer's Accept-Language yields a non-empty `languages` allowlist, the feed is
// biased toward those languages (see finalize); [] leaves it global.
export class PopularityRanker implements Ranker {
  // Pre-compute the shared cold-start set (e.g. at server start) so the first
  // cold-start request after boot doesn't pay the query.
  async warm(ctx: AppContext): Promise<void> {
    await popQuery(ctx, 'all').catch((err) =>
      console.error('[foryou] popularity warm failed', err),
    )
  }

  async rank(
    ctx: AppContext,
    viewerDid: string | null,
    content: ContentFilter,
    languages: string[] = [],
  ): Promise<string[]> {
    const ttlMs = ctx.cfg.ranking.popularityCacheTtlSeconds * 1000
    const entry = popCache.get(content)
    let rows: PopRow[]
    if (entry && Date.now() - entry.at < ttlMs) {
      rows = entry.rows // fresh
    } else if (entry) {
      rows = entry.rows // stale: serve now, refresh in the background
      refreshInBackground(ctx, content)
    } else {
      rows = await popQuery(ctx, content) // cold: compute once, inline
    }

    const rawScores = new Map<string, number>()
    for (const row of rows) rawScores.set(row.subject_uri, row.likes)

    // No popularity penalty for cold start — popular posts should win. Bias
    // toward the viewer's languages when known (undeclared posts still pass).
    return finalize(ctx, rawScores, {
      applyPopularityPenalty: false,
      content,
      languages,
      viewerDid,
    })
  }
}
