import { sql } from 'kysely'
import { Database } from '../db'
import { GraphConfig, RankingConfig } from '../config'
import { ILikeGraph } from './types'

const EPOCH_MS = Date.UTC(2020, 0, 1)
const FUTURE_SKEW_MS = 5 * 60000 // clamp clock-skewed / spoofed createdAt to ~now
// Minutes since EPOCH_MS, clamped to [0, now]. Clamping future timestamps keeps
// every value a small int (so V8 holds fwd[] as a packed-SMI array) and keeps
// the recency-sorted early-break in score() correct against spoofed createdAt.
const toTsMin = (ms: number): number => {
  const cap = Date.now() + FUTURE_SKEW_MS
  const clamped = ms > cap ? cap : ms
  const m = Math.floor((clamped - EPOCH_MS) / 60000)
  return m > 0 ? m : 0
}
const BUILD_PAGE = 100000

// In-memory like graph: the user↔post bipartite graph held in RAM so the
// traversal runs in-process (tens of ms) instead of as a multi-second Postgres
// aggregation per request. Postgres is the durable store + boot loader.
//
// Map-based representation:
//   - interning: Map<DID,int> (ingest only) and Map<URI,int> + string[] (output)
//   - forward (user → likes): fwd[userInt] = [postInt, tsMin, postInt, tsMin, …]
//     in chronological order (newest at the end) — all SMIs, so V8 keeps it as a
//     packed 4-byte element array.
//   - reverse (post → likers): rev[postInt] = [userInt, …]
// The seed (the viewer's recent likes) is read from Postgres by GraphRanker, so
// the graph only powers curator discovery + candidate generation.
//
// The CsrLikeGraph layout is more compact for large retention windows; this one
// is simpler. Both implement ILikeGraph.
export class LikeGraph implements ILikeGraph {
  ready = false
  private building = false

  private userId = new Map<string, number>()
  private postId = new Map<string, number>()
  private postUri: string[] = []
  private fwd: number[][] = []
  private rev: number[][] = []
  // While a rebuild is in progress (and a graph is already live), live creates
  // are buffered here and replayed onto the freshly-built arrays after the swap,
  // so likes ingested during the (minutes-long) build aren't dropped until the
  // next rebuild. Null when no rebuild is running.
  private pending: Array<[string, string, number]> | null = null

  constructor(private readonly cfg: GraphConfig) {}

  // --- live updates (called by the firehose ingester once ready) ---

  applyCreate(likerDid: string, subjectUri: string, createdAtMs: number): void {
    if (!this.ready) return // pre-build likes are loaded from Postgres instead
    const u = internUser(this.userId, this.fwd, likerDid)
    const p = internPost(this.postId, this.postUri, this.rev, subjectUri)
    this.fwd[u].push(p, toTsMin(createdAtMs))
    this.rev[p].push(u)
    this.pending?.push([likerDid, subjectUri, createdAtMs])
  }

  // --- (re)build the whole graph from Postgres (boot + periodic refresh) ---

  // Returns true on a successful (re)build + swap, false on error or if a build
  // is already running. Callers use the result to drive boot-time retries.
  async buildFromPostgres(db: Database): Promise<boolean> {
    if (this.building) {
      console.warn('🧠 like-graph rebuild skipped: a build is already in progress')
      return false
    }
    this.building = true
    // capture live creates during the build (only meaningful for a rebuild,
    // when a graph is already serving); replayed onto the new arrays post-swap
    if (this.ready) this.pending = []
    const startedAt = Date.now()
    try {
      const userId = new Map<string, number>()
      const postId = new Map<string, number>()
      const postUri: string[] = []
      const fwd: number[][] = []
      const rev: number[][] = []

      // Retention is keyed on indexed_at (server-generated, canonical) — same as
      // the Postgres retention sweep — so a spoofed/backdated record createdAt
      // can't pull a row into or out of the window.
      const windowCutoff = new Date(
        Date.now() - this.cfg.windowHours * 60 * 60 * 1000,
      ).toISOString()

      let lastLiker = ''
      let lastCreated = ''
      let lastUri = ''
      let first = true
      let edges = 0

      // Keyset pagination ordered by (liker_did, created_at, uri) — uses the
      // existing (liker_did, created_at) index and delivers each user's likes
      // grouped + chronological, so forward rows append in recency order with
      // no per-user sort. Self-consistent (same comparator for ORDER BY and
      // cursor), so non-canonical createdAt strings can't skip/duplicate rows.
      for (;;) {
        let q = db
          .selectFrom('likes')
          .select(['liker_did', 'subject_uri', 'created_at', 'uri'])
          .where('indexed_at', '>', windowCutoff)
          .orderBy('liker_did')
          .orderBy('created_at')
          .orderBy('uri')
          .limit(BUILD_PAGE)
        if (!first) {
          q = q.where(
            sql<boolean>`(liker_did, created_at, uri) > (${lastLiker}, ${lastCreated}, ${lastUri})`,
          )
        }
        const rows = await q.execute()
        if (rows.length === 0) break

        for (const r of rows) {
          const ms = Date.parse(r.created_at)
          if (isNaN(ms)) continue
          const u = internUser(userId, fwd, r.liker_did)
          const p = internPost(postId, postUri, rev, r.subject_uri)
          fwd[u].push(p, toTsMin(ms))
          rev[p].push(u)
          edges++
        }

        const last = rows[rows.length - 1]
        lastLiker = last.liker_did
        lastCreated = last.created_at
        lastUri = last.uri
        first = false
        if (rows.length < BUILD_PAGE) break
        // yield to the event loop so the build never blocks request serving
        await new Promise((res) => setImmediate(res))
      }

      // atomic swap (single-threaded → no torn reads)
      this.userId = userId
      this.postId = postId
      this.postUri = postUri
      this.fwd = fwd
      this.rev = rev
      this.ready = true

      // replay live creates buffered during the build onto the new arrays
      // (synchronous → no applyCreate interleaves). Re-adding a like the build
      // already loaded is harmless: forward dedupes per curator in score().
      let replayed = 0
      if (this.pending) {
        for (const [d, u, ms] of this.pending) {
          const ui = internUser(this.userId, this.fwd, d)
          const pi = internPost(this.postId, this.postUri, this.rev, u)
          this.fwd[ui].push(pi, toTsMin(ms))
          this.rev[pi].push(ui)
          replayed++
        }
      }

      console.log(
        `🧠 like-graph built: ${userId.size} users, ${postUri.length} posts, ` +
          `${edges} edges (+${replayed} live) in ` +
          `${Math.round((Date.now() - startedAt) / 1000)}s`,
      )
      return true
    } catch (err) {
      console.error('like-graph build failed', err)
      return false
    } finally {
      this.pending = null
      this.building = false
    }
  }

  // --- the path-counting traversal ---
  // Returns Map<postUri, rawScore = num_paths^smoothing>; finalize() does the
  // time-decay / popularity / freshness / diversity pass.
  score(
    viewerDid: string,
    seedUris: string[],
    r: RankingConfig,
    candidateLimit = r.maxCandidates,
  ): Map<string, number> {
    const out = new Map<string, number>()
    const n = seedUris.length
    if (n === 0 || !this.ready) return out
    const viewerInt = this.userId.get(viewerDid)

    const minW = r.seedRecencyMinWeight
    const seedPostInts = new Set<number>()
    for (const uri of seedUris) {
      const p = this.postId.get(uri)
      if (p !== undefined) seedPostInts.add(p)
    }
    // also exclude every post the viewer has liked in-graph (not just the
    // top-N seed) so already-liked posts never resurface as candidates
    if (viewerInt !== undefined) {
      const arr = this.fwd[viewerInt]
      if (arr) for (let i = 0; i < arr.length; i += 2) seedPostInts.add(arr[i])
    }

    let visits = 0
    const budget = this.cfg.maxEdgeVisits

    // 1–2. curators: every user who liked a seed post → incoming weight
    //      W_c = Σ_i seedWeight(i) / deg(i)^itemBranchingPower
    const incoming = new Map<number, number>()
    for (let idx = 0; idx < n; idx++) {
      const p = this.postId.get(seedUris[idx])
      if (p === undefined) continue
      const likers = this.rev[p]
      if (!likers || likers.length === 0) continue
      const w = n === 1 ? 1 : minW + (1 - minW) * (idx / (n - 1))
      const contrib = w / Math.pow(likers.length, r.itemBranchingPower)
      const scan = Math.min(likers.length, this.cfg.seedLikerScanCap)
      for (let k = 0; k < scan; k++) {
        const u = likers[k]
        incoming.set(u, (incoming.get(u) ?? 0) + contrib)
      }
      visits += scan
      if (visits > budget) break
    }
    // exclude the viewer from the curator set (they liked every seed post)
    if (viewerInt !== undefined) incoming.delete(viewerInt)
    if (incoming.size === 0) return out

    // top maxCurators by incoming weight
    const curators =
      incoming.size <= r.maxCurators
        ? [...incoming.entries()]
        : [...incoming.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, r.maxCurators)

    // 3–4. candidates: each curator's top-N recent likes within the window.
    //      deg(c) = count of those (incl. seed posts, matching the SQL).
    const cutoffMin = toTsMin(
      Date.now() - r.candidateLikeWindowHours * 60 * 60 * 1000,
    )
    const scoreAcc = new Map<number, number>()
    const raters = new Map<number, number>()
    const cand: number[] = [] // postInt
    const candRn: number[] = [] // 1-based recency rank
    for (const [c, wc] of curators) {
      const arr = this.fwd[c]
      if (!arr) continue
      cand.length = 0
      candRn.length = 0
      const seenPosts = new Set<number>()
      let rn = 0
      // walk recent-first (from the end); arr = [postInt, tsMin, …]
      for (
        let i = arr.length - 2;
        i >= 0 && seenPosts.size < r.maxLikesPerCurator;
        i -= 2
      ) {
        const ts = arr[i + 1]
        if (ts < cutoffMin) break // chronological → everything earlier is older
        const post = arr[i]
        if (seenPosts.has(post)) continue
        seenPosts.add(post)
        rn++
        cand.push(post)
        candRn.push(rn)
        if (++visits > budget) break
      }
      const deg = cand.length
      if (deg === 0) continue
      const norm = wc / Math.pow(deg, r.curatorBranchingPower)
      for (let t = 0; t < cand.length; t++) {
        const post = cand[t]
        if (seedPostInts.has(post)) continue // don't recommend already-liked
        const factor =
          r.coraterDecay > 0 ? Math.pow(1 - r.coraterDecay, candRn[t] - 1) : 1
        scoreAcc.set(post, (scoreAcc.get(post) ?? 0) + norm * factor)
        raters.set(post, (raters.get(post) ?? 0) + 1)
      }
      if (visits > budget) break
    }

    // 5. eligibility + num_paths^smoothing, take top maxCandidates
    const scored: { post: number; raw: number }[] = []
    for (const [post, acc] of scoreAcc) {
      if ((raters.get(post) ?? 0) < r.minEligibleRaters) continue
      scored.push({ post, raw: Math.pow(acc, r.smoothing) })
    }
    scored.sort((a, b) => b.raw - a.raw)
    const top = scored.slice(0, candidateLimit)
    for (const { post, raw } of top) out.set(this.postUri[post], raw)
    return out
  }

  stats() {
    return {
      ready: this.ready,
      users: this.userId.size,
      posts: this.postUri.length,
    }
  }
}

const internUser = (
  map: Map<string, number>,
  fwd: number[][],
  did: string,
): number => {
  let id = map.get(did)
  if (id === undefined) {
    id = map.size
    map.set(did, id)
    fwd[id] = []
  }
  return id
}

const internPost = (
  map: Map<string, number>,
  uris: string[],
  rev: number[][],
  uri: string,
): number => {
  let id = map.get(uri)
  if (id === undefined) {
    id = uris.length
    map.set(uri, id)
    uris.push(uri)
    rev[id] = []
  }
  return id
}
