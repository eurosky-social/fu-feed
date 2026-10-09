import { sql } from 'kysely'
import { AppContext } from '../config'
import { Ranker, ContentFilter, RankOptions } from './types'
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
const popInflight = new Map<ContentFilter, Promise<PopRow[]>>()

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

// Single-flight, shared by the cold and the background-refresh paths. `popQuery`
// is a heavy GROUP BY over the whole freshness window, and nothing populates
// popCache until it finishes — so without this, every concurrent cold-start
// request for the same content ran its own copy. Client retries make that
// self-reinforcing: three retries of a request that is already too slow started
// three more full computations.
const popQueryOnce = (
  ctx: AppContext,
  content: ContentFilter,
): Promise<PopRow[]> => {
  const existing = popInflight.get(content)
  if (existing) return existing
  const p = popQuery(ctx, content).finally(() => popInflight.delete(content))
  popInflight.set(content, p)
  return p
}

const refreshInBackground = (ctx: AppContext, content: ContentFilter): void => {
  void popQueryOnce(ctx, content).catch((err) =>
    console.error('[foryou] popularity refresh failed', err),
  )
}

// The popularity ranker's options: the shared ones, plus the cold-start
// language allowlist.
export type PopularityOptions = RankOptions & {
  // When the viewer's Accept-Language yields a non-empty allowlist, the feed is
  // biased toward those languages (see FinalizeOptions.languages); absent or []
  // leaves it global.
  languages?: string[]
}

// Cold-start ranker for anonymous viewers and users with no likes yet: the
// most-liked recent posts, still subject to time-decay and freshness. Biased by
// the viewer's languages — filtered by `languages`, or ordered by
// `languageTiers` — when the caller supplies them.
export class PopularityRanker implements Ranker {
  // Pre-compute the shared cold-start set (e.g. at server start) so the first
  // cold-start request after boot doesn't pay the query.
  async warm(ctx: AppContext): Promise<void> {
    // popCache is keyed by content filter, so warming only 'all' left every
    // content-typed feed cold after each restart or deploy — and their cold
    // path is the expensive one, because it over-fetches by
    // mediaCandidateMultiplier. Warm one entry per distinct filter actually
    // served.
    const contents = [...new Set(ctx.cfg.feeds.map((f) => f.content))]
    await Promise.all(
      contents.map((content) =>
        popQueryOnce(ctx, content).catch((err) =>
          console.error(`[foryou] popularity warm failed (${content})`, err),
        ),
      ),
    )
  }

  async rank(
    ctx: AppContext,
    viewerDid: string | null,
    content: ContentFilter,
    opts: PopularityOptions = {},
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
      rows = await popQueryOnce(ctx, content) // cold: compute once, inline
    }

    const rawScores = new Map<string, number>()
    for (const row of rows) rawScores.set(row.subject_uri, row.likes)

    // No popularity penalty for cold start — popular posts should win. Bias
    // toward the viewer's languages when known (undeclared posts still pass).
    return finalize(ctx, rawScores, {
      applyPopularityPenalty: false,
      content,
      languages: opts.languages,
      languageTiers: opts.languageTiers,
      viewerDid,
    })
  }
}
