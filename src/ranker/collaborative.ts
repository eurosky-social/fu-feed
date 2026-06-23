import { sql } from 'kysely'
import { AppContext } from '../config'
import { Ranker, ContentFilter } from './types'
import { finalize } from './finalize'

// Collaborative-filter ranker computed in Postgres (one CTE so the millions of
// candidate like-edges never reach the app process):
//   1. seed     = the viewer's recent likes, weighted (recent ones down-weighted
//                 via seedRecencyMinWeight to reduce over-reactivity).
//   2. curators = users who liked the seed posts, with incoming weight
//                 W_c = Σ_i w_i / deg(i)^itemBranchingPower.
//   3. paths    = each curator's top-N recent likes j, receiving
//                 W_c / deg(c)^curatorBranchingPower · coraterDecay(rank).
//   4. score(j) = (Σ paths to j)^smoothing, kept if ≥ minEligibleRaters distinct
//                 curators; time-decay / popularity / filters applied in finalize.
export class CollaborativeFilterRanker implements Ranker {
  async rank(
    ctx: AppContext,
    viewerDid: string | null,
    content: ContentFilter,
  ): Promise<string[]> {
    if (!viewerDid) return []
    const cfg = ctx.cfg.ranking
    // Content feeds over-generate so enough survive the media filter in finalize.
    const candidateLimit =
      content === 'all'
        ? cfg.maxCandidates
        : cfg.maxCandidates * cfg.mediaCandidateMultiplier

    // 1. seed: viewer's recent likes (deduped, ordered recent → old)
    const seedRows = await ctx.db
      .selectFrom('likes')
      .select(['subject_uri'])
      .where('liker_did', '=', viewerDid)
      .orderBy('created_at', 'desc')
      .limit(cfg.seedLimit)
      .execute()

    const seedSeen = new Set<string>()
    const seedOrder: string[] = []
    for (const r of seedRows) {
      if (!seedSeen.has(r.subject_uri)) {
        seedSeen.add(r.subject_uri)
        seedOrder.push(r.subject_uri)
      }
    }
    if (seedOrder.length === 0) return []

    // seed weights: most-recent (index 0) → seedRecencyMinWeight, oldest → 1.0
    const n = seedOrder.length
    const minW = cfg.seedRecencyMinWeight
    const seedValues = sql.join(
      seedOrder.map((uri, idx) => {
        const w = n === 1 ? 1 : minW + (1 - minW) * (idx / (n - 1))
        return sql`(${uri}, ${w}::float8)`
      }),
      sql`, `,
    )
    const seedUris = seedOrder
    const candidateCutoff = new Date(
      Date.now() - cfg.candidateLikeWindowHours * 60 * 60 * 1000,
    ).toISOString()

    // 2–4. all graph work in Postgres: seed-item degrees → curator incoming
    // weight (top maxCurators) → each curator's top-N recent likes → per-post
    // path-weight sum + distinct rater count.
    const result = await sql<{
      subject_uri: string
      score_acc: number
      raters: number
    }>`
      WITH seed(uri, w) AS (VALUES ${seedValues}),
      degs AS (
        SELECT l.subject_uri, count(*)::float8 AS deg
        FROM likes l JOIN seed ON l.subject_uri = seed.uri
        GROUP BY l.subject_uri
      ),
      curators AS (
        SELECT l.liker_did,
               sum(seed.w / power(degs.deg, ${cfg.itemBranchingPower})) AS wc
        FROM likes l
        JOIN seed ON l.subject_uri = seed.uri
        JOIN degs ON degs.subject_uri = l.subject_uri
        WHERE l.liker_did <> ${viewerDid}
        GROUP BY l.liker_did
        ORDER BY wc DESC
        LIMIT ${cfg.maxCurators}
      ),
      cand AS (
        SELECT l.liker_did, l.subject_uri,
               ROW_NUMBER() OVER (
                 PARTITION BY l.liker_did ORDER BY l.created_at DESC
               ) AS rn
        FROM likes l
        JOIN curators c ON c.liker_did = l.liker_did
        WHERE l.created_at > ${candidateCutoff}
      ),
      capped AS (
        SELECT liker_did, subject_uri, rn FROM cand WHERE rn <= ${cfg.maxLikesPerCurator}
      ),
      degc AS (
        SELECT liker_did, count(*)::float8 AS dc FROM capped GROUP BY liker_did
      )
      SELECT capped.subject_uri,
             sum(
               (c.wc / power(degc.dc, ${cfg.curatorBranchingPower}))
               * power(${1 - cfg.coraterDecay}::float8, capped.rn - 1)
             )::float8 AS score_acc,
             count(DISTINCT capped.liker_did)::int AS raters
      FROM capped
      JOIN curators c ON c.liker_did = capped.liker_did
      JOIN degc ON degc.liker_did = capped.liker_did
      WHERE capped.subject_uri <> ALL(${seedUris})
      GROUP BY capped.subject_uri
      ORDER BY score_acc DESC
      LIMIT ${candidateLimit}
    `.execute(ctx.db)

    // eligibility + num_paths^smoothing (monotonic, so SQL's ordering holds)
    const rawScores = new Map<string, number>()
    for (const row of result.rows) {
      if (row.raters < cfg.minEligibleRaters) continue
      rawScores.set(row.subject_uri, Math.pow(row.score_acc, cfg.smoothing))
    }
    if (rawScores.size === 0) return []

    return finalize(ctx, rawScores, { applyPopularityPenalty: true, content })
  }
}
