import { AppContext } from '../config'
import { ScoreOptions } from '../graph/types'
import { Ranker, ContentFilter } from './types'
import { finalize } from './finalize'

// Ranker backed by the in-memory like graph. The seed (the viewer's recent
// likes) is read from Postgres — cheap, fresh, includes backfilled history —
// while curator discovery and candidate generation run in memory.
//
// Curator selection is also persisted per viewer in the `curators` table and
// fed back into the graph (see ScoreOptions). The like graph only holds likes
// within the retention window, so once a co-like ages out the curator stops
// being discovered live — even if they are still active and their other recent
// likes would make good candidates. The durable selection survives that
// cutoff: the ranker loads it (decayed by age), the graph merges the curators
// the live pass missed back into the candidate walk, and the ranker upserts
// the curators the graph actually used so active ones stay fresh.
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
    const persist = ctx.cfg.persistCurators

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

    // Load the viewer's durable curator selection and decay each weight by age
    // since it was last refreshed. The graph merges curators the live pass
    // missed back in with this decayed weight (see ScoreOptions.durableCurators).
    let opts: ScoreOptions | undefined
    let liveCurators: Map<string, number> | undefined
    if (persist) {
      const durableCurators = await loadDurableCurators(ctx, viewerDid)
      liveCurators = new Map()
      opts = { durableCurators, onCurators: (m) => mergeInto(liveCurators!, m) }
    }

    // Content feeds over-generate so enough candidates survive the media filter.
    const candidateLimit =
      content === 'all'
        ? cfg.maxCandidates
        : cfg.maxCandidates * cfg.mediaCandidateMultiplier
    const raw = graph.score(viewerDid, seedUris, cfg, candidateLimit, opts)

    // Persist the curator selection the graph just used (live + merged durable,
    // post-cut). Fire-and-forget: it must not extend the feed request's latency,
    // and a failed write only means a curator decays a little more next time.
    if (persist && liveCurators && liveCurators.size > 0) {
      void persistCurators(ctx, viewerDid, liveCurators).catch((err) =>
        console.error('[foryou] curator persist failed', err),
      )
    }

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

// Loads the viewer's durable curator selection, decaying each weight by age
// since updated_at (exponential, half-life = curatorDecayHalfLifeHours). A
// curator not seen live for a while fades, so a stale co-like from long ago
// matters less than a recent one. 0 half-life = no decay.
const loadDurableCurators = async (
  ctx: AppContext,
  viewerDid: string,
): Promise<Map<string, number>> => {
  const rows = await ctx.db
    .selectFrom('curators')
    .select(['curator_did', 'weight', 'updated_at'])
    .where('viewer_did', '=', viewerDid)
    .execute()
  const halfLifeHours = ctx.cfg.curatorDecayHalfLifeHours
  const now = Date.now()
  const out = new Map<string, number>()
  for (const r of rows) {
    const ageHours = (now - Date.parse(r.updated_at)) / (60 * 60 * 1000)
    const decay = halfLifeHours > 0 ? Math.pow(0.5, ageHours / halfLifeHours) : 1
    out.set(r.curator_did, r.weight * decay)
  }
  return out
}

// Upserts the graph's selected curators for this viewer into the durable table,
// refreshing updated_at (and so the decay clock) for every active curator.
const persistCurators = async (
  ctx: AppContext,
  viewerDid: string,
  curators: Map<string, number>,
): Promise<void> => {
  const now = new Date().toISOString()
  const rows = [...curators.entries()].map(([curator_did, weight]) => ({
    viewer_did: viewerDid,
    curator_did,
    weight,
    updated_at: now,
  }))
  await ctx.db
    .insertInto('curators')
    .values(rows)
    .onConflict((oc) =>
      oc.columns(['viewer_did', 'curator_did']).doUpdateSet({
        weight: (eb) => eb.ref('excluded.weight'),
        updated_at: (eb) => eb.ref('excluded.updated_at'),
      }),
    )
    .execute()
}

const mergeInto = (dst: Map<string, number>, src: Map<string, number>): void => {
  for (const [k, v] of src) dst.set(k, v)
}
