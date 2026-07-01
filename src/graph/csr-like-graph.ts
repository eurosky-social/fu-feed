import { sql } from 'kysely'
import { Database } from '../db'
import { GraphConfig, RankingConfig } from '../config'
import { ILikeGraph } from './types'
import { ArenaInterner, isInternable } from './arena-interner'

const EPOCH_MS = Date.UTC(2020, 0, 1)
const FUTURE_SKEW_MS = 5 * 60000
const toTsMin = (ms: number): number => {
  const cap = Date.now() + FUTURE_SKEW_MS
  const clamped = ms > cap ? cap : ms
  const m = Math.floor((clamped - EPOCH_MS) / 60000)
  return m > 0 ? m : 0
}
const BUILD_PAGE = 100000

// The like graph as Compressed-Sparse-Row typed arrays + arena interners (see
// arena-interner.ts). More compact than the Map-based LikeGraph (no per-node
// array overhead, no per-key string objects), which makes large retention
// windows affordable.
//
// The frozen CSR base is immutable; live firehose creates land in a small delta
// overlay (per-node arrays) that reads union with the base, and a periodic
// rebuild folds everything into a fresh base.
export class CsrLikeGraph implements ILikeGraph {
  ready = false
  private building = false

  private userI = new ArenaInterner(16)
  private postI = new ArenaInterner(16)
  private fwdOff = new Uint32Array(1)
  private fwdPost = new Uint32Array(0)
  private fwdTs = new Uint32Array(0)
  private revOff = new Uint32Array(1)
  private revUser = new Uint32Array(0)
  private baseUsers = 0
  private basePosts = 0

  // live overlay (ids may be < baseUsers/Posts, i.e. base nodes with new edges,
  // or >= base counts, i.e. brand-new nodes since the last build)
  private deltaFwd = new Map<number, number[]>() // [post, tsMin, …] chronological
  private deltaRev = new Map<number, number[]>() // [user, …]
  private pending: Array<[string, string, number]> | null = null

  constructor(private readonly cfg: GraphConfig) {}

  applyCreate(likerDid: string, subjectUri: string, createdAtMs: number): void {
    if (!this.ready) return
    // The arena interner stores 1 byte/char; reject non-ASCII/oversized keys
    // (malformed/hostile records) so they can't truncate-and-collide.
    if (!isInternable(subjectUri) || !isInternable(likerDid)) return
    const u = this.userI.intern(likerDid)
    const p = this.postI.intern(subjectUri)
    let df = this.deltaFwd.get(u)
    if (!df) {
      df = []
      this.deltaFwd.set(u, df)
    }
    df.push(p, toTsMin(createdAtMs))
    let dr = this.deltaRev.get(p)
    if (!dr) {
      dr = []
      this.deltaRev.set(p, dr)
    }
    dr.push(u)
    this.pending?.push([likerDid, subjectUri, createdAtMs])
  }

  async buildFromPostgres(db: Database): Promise<boolean> {
    if (this.building) {
      console.warn('🧠 like-graph rebuild skipped: a build is already in progress')
      return false
    }
    this.building = true
    if (this.ready) this.pending = []
    const startedAt = Date.now()
    try {
      const windowCutoff = new Date(
        Date.now() - this.cfg.windowHours * 60 * 60 * 1000,
      ).toISOString()

      // pre-size edge staging from the actual row count to avoid power-of-two
      // over-allocation (count(*)::text avoids int overflow at 90d scale)
      const cnt = await sql<{ c: string }>`
        SELECT count(*)::text AS c FROM likes WHERE indexed_at > ${windowCutoff}
      `.execute(db)
      const approxE = Math.max(1 << 20, Math.ceil(Number(cnt.rows[0]?.c ?? 0) * 1.05))
      console.log(
        `🧠 like-graph (csr) build started: ~${Number(cnt.rows[0]?.c ?? 0)} edges to load…`,
      )

      const userI = new ArenaInterner(1 << 20)
      const postI = new ArenaInterner(1 << 21)
      // accumulate edges (single consistent pass) then counting-sort to CSR
      let edgeU = new Uint32Array(approxE)
      let edgePost = new Uint32Array(approxE)
      let edgeTs = new Uint32Array(approxE)
      let fwdDeg = new Uint32Array(1 << 20)
      let revDeg = new Uint32Array(1 << 21)
      let E = 0
      let lastLiker = ''
      let lastCreated = ''
      let lastUri = ''
      let first = true
      let nextLog = 1000000

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
          if (!isInternable(r.subject_uri)) continue // skip malformed URIs
          const u = userI.intern(r.liker_did)
          const p = postI.intern(r.subject_uri)
          if (E >= edgeU.length) {
            edgeU = growU32(edgeU, E + 1)
            edgePost = growU32(edgePost, E + 1)
            edgeTs = growU32(edgeTs, E + 1)
          }
          edgeU[E] = u
          edgePost[E] = p
          edgeTs[E] = toTsMin(ms)
          E++
          if (u >= fwdDeg.length) fwdDeg = growU32(fwdDeg, u + 1)
          if (p >= revDeg.length) revDeg = growU32(revDeg, p + 1)
          fwdDeg[u]++
          revDeg[p]++
        }

        if (E >= nextLog) {
          console.log(
            `🧠 like-graph (csr) building… ${E} edges ` +
              `(~${Math.round((E / approxE) * 100)}%)`,
          )
          nextLog += 1000000
        }

        const last = rows[rows.length - 1]
        lastLiker = last.liker_did
        lastCreated = last.created_at
        lastUri = last.uri
        first = false
        if (rows.length < BUILD_PAGE) break
        await new Promise((res) => setImmediate(res))
      }

      const U = userI.count
      const P = postI.count

      // prefix-sum offsets
      const fwdOff = new Uint32Array(U + 1)
      for (let u = 0; u < U; u++) fwdOff[u + 1] = fwdOff[u] + (fwdDeg[u] || 0)
      const revOff = new Uint32Array(P + 1)
      for (let p = 0; p < P; p++) revOff[p + 1] = revOff[p] + (revDeg[p] || 0)

      const fwdPost = new Uint32Array(E)
      const fwdTs = new Uint32Array(E)
      const revUser = new Uint32Array(E)
      const fwdCur = fwdOff.slice(0, U) // mutable write cursors
      const revCur = revOff.slice(0, P)
      for (let i = 0; i < E; i++) {
        const u = edgeU[i]
        const fc = fwdCur[u]++
        fwdPost[fc] = edgePost[i]
        fwdTs[fc] = edgeTs[i]
        const p = edgePost[i]
        revUser[revCur[p]++] = u
      }

      // swap in the new base
      this.userI = userI
      this.postI = postI
      this.fwdOff = fwdOff
      this.fwdPost = fwdPost
      this.fwdTs = fwdTs
      this.revOff = revOff
      this.revUser = revUser
      this.baseUsers = U
      this.basePosts = P
      this.deltaFwd = new Map()
      this.deltaRev = new Map()
      this.ready = true

      // replay live creates buffered during the build into the fresh delta
      let replayed = 0
      if (this.pending) {
        for (const [d, uri, ms] of this.pending) {
          const u = this.userI.intern(d)
          const p = this.postI.intern(uri)
          let df = this.deltaFwd.get(u)
          if (!df) {
            df = []
            this.deltaFwd.set(u, df)
          }
          df.push(p, toTsMin(ms))
          let dr = this.deltaRev.get(p)
          if (!dr) {
            dr = []
            this.deltaRev.set(p, dr)
          }
          dr.push(u)
          replayed++
        }
      }

      console.log(
        `🧠 like-graph (csr) built: ${U} users, ${P} posts, ${E} edges ` +
          `(+${replayed} live) in ${Math.round((Date.now() - startedAt) / 1000)}s`,
      )
      return true
    } catch (err) {
      console.error('like-graph (csr) build failed', err)
      return false
    } finally {
      this.pending = null
      this.building = false
    }
  }

  score(
    viewerDid: string,
    seedUris: string[],
    r: RankingConfig,
    candidateLimit = r.maxCandidates,
  ): Map<string, number> {
    const out = new Map<string, number>()
    const n = seedUris.length
    if (n === 0 || !this.ready) return out
    const viewerInt = this.userI.get(viewerDid)

    const seedPostInts = new Set<number>()
    for (const uri of seedUris) {
      const p = this.postI.get(uri)
      if (p !== undefined) seedPostInts.add(p)
    }
    // also exclude every post the viewer has liked in-graph (base CSR slice +
    // delta), not just the top-N seed, so already-liked posts never resurface
    if (viewerInt !== undefined) {
      if (viewerInt < this.baseUsers) {
        const end = this.fwdOff[viewerInt + 1]
        for (let i = this.fwdOff[viewerInt]; i < end; i++) {
          seedPostInts.add(this.fwdPost[i])
        }
      }
      const df = this.deltaFwd.get(viewerInt)
      if (df) for (let i = 0; i < df.length; i += 2) seedPostInts.add(df[i])
    }

    let visits = 0
    const budget = this.cfg.maxEdgeVisits
    const minW = r.seedRecencyMinWeight

    // 1–2. curators + incoming weight
    const incoming = new Map<number, number>()
    for (let idx = 0; idx < n; idx++) {
      const p = this.postI.get(seedUris[idx])
      if (p === undefined) continue
      const deg = this.revDegree(p)
      if (deg === 0) continue
      const w = n === 1 ? 1 : minW + (1 - minW) * (idx / (n - 1))
      const contrib = w / Math.pow(deg, r.itemBranchingPower)
      let scanned = 0
      const cap = this.cfg.seedLikerScanCap
      // base likers
      if (p < this.basePosts) {
        const end = this.revOff[p + 1]
        for (let i = this.revOff[p]; i < end && scanned < cap; i++) {
          const u = this.revUser[i]
          incoming.set(u, (incoming.get(u) ?? 0) + contrib)
          scanned++
        }
      }
      // delta likers
      const dr = this.deltaRev.get(p)
      if (dr) {
        for (let k = 0; k < dr.length && scanned < cap; k++) {
          const u = dr[k]
          incoming.set(u, (incoming.get(u) ?? 0) + contrib)
          scanned++
        }
      }
      visits += scanned
      if (visits > budget) break
    }
    if (viewerInt !== undefined) incoming.delete(viewerInt)
    if (incoming.size === 0) return out

    const curators =
      incoming.size <= r.maxCurators
        ? [...incoming.entries()]
        : [...incoming.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, r.maxCurators)

    // 3–4. candidates: each curator's top-N recent likes (delta newest, then
    // base from the end), deg(c) = count considered, score contributions.
    const cutoffMin = toTsMin(
      Date.now() - r.candidateLikeWindowHours * 60 * 60 * 1000,
    )
    const scoreAcc = new Map<number, number>()
    const raters = new Map<number, number>()
    // most-recent co-liker-like time (tsMin) per candidate — drives the recency
    // weight applied at selection so fresh posts survive the top-N cut.
    const lastTs = new Map<number, number>()
    const cand: number[] = []
    const candRn: number[] = []
    const candTs: number[] = []
    for (const [c, wc] of curators) {
      cand.length = 0
      candRn.length = 0
      candTs.length = 0
      const seenPosts = new Set<number>()
      let rn = 0
      let stop = false
      // delta first (newest)
      const df = this.deltaFwd.get(c)
      if (df) {
        for (
          let i = df.length - 2;
          i >= 0 && seenPosts.size < r.maxLikesPerCurator;
          i -= 2
        ) {
          const ts = df[i + 1]
          if (ts < cutoffMin) {
            stop = true
            break
          }
          const post = df[i]
          if (seenPosts.has(post)) continue
          seenPosts.add(post)
          cand.push(post)
          candRn.push(++rn)
          candTs.push(ts)
          if (++visits > budget) {
            stop = true
            break
          }
        }
      }
      // then base slice from the end (older than delta)
      if (!stop && c < this.baseUsers) {
        const start = this.fwdOff[c]
        for (
          let i = this.fwdOff[c + 1] - 1;
          i >= start && seenPosts.size < r.maxLikesPerCurator;
          i--
        ) {
          const ts = this.fwdTs[i]
          if (ts < cutoffMin) break
          const post = this.fwdPost[i]
          if (seenPosts.has(post)) continue
          seenPosts.add(post)
          cand.push(post)
          candRn.push(++rn)
          candTs.push(ts)
          if (++visits > budget) break
        }
      }

      const deg = cand.length
      if (deg === 0) continue
      const norm = wc / Math.pow(deg, r.curatorBranchingPower)
      for (let t = 0; t < cand.length; t++) {
        const post = cand[t]
        if (seedPostInts.has(post)) continue
        const factor =
          r.coraterDecay > 0 ? Math.pow(1 - r.coraterDecay, candRn[t] - 1) : 1
        scoreAcc.set(post, (scoreAcc.get(post) ?? 0) + norm * factor)
        raters.set(post, (raters.get(post) ?? 0) + 1)
        const prev = lastTs.get(post)
        if (prev === undefined || candTs[t] > prev) lastTs.set(post, candTs[t])
      }
      if (visits > budget) break
    }

    // 5. eligibility + num_paths^smoothing, weighted by co-liker-like recency so
    // fresh (recently-liked) posts survive the top-maxCandidates cut instead of
    // being dropped before finalize's post-age decay can rank them.
    const recencyOn = r.candidateRecencyHalfLifeHours > 0
    const nowMin = toTsMin(Date.now())
    const halfLifeMin = r.candidateRecencyHalfLifeHours * 60
    const scored: { post: number; raw: number }[] = []
    for (const [post, acc] of scoreAcc) {
      if ((raters.get(post) ?? 0) < r.minEligibleRaters) continue
      let raw = Math.pow(acc, r.smoothing)
      if (recencyOn) {
        const ageMin = Math.max(0, nowMin - (lastTs.get(post) ?? nowMin))
        raw *= Math.pow(0.5, ageMin / halfLifeMin)
      }
      scored.push({ post, raw })
    }
    scored.sort((a, b) => b.raw - a.raw)
    const top = scored.slice(0, candidateLimit)
    for (const { post, raw } of top) out.set(this.postI.keyAt(post), raw)
    return out
  }

  stats() {
    return { ready: this.ready, users: this.userI.count, posts: this.postI.count }
  }

  // distinct-liker count for a post = base reverse-slice length + delta likers
  private revDegree(p: number): number {
    const base = p < this.basePosts ? this.revOff[p + 1] - this.revOff[p] : 0
    return base + (this.deltaRev.get(p)?.length ?? 0)
  }
}

const growU32 = (arr: Uint32Array, need: number): Uint32Array => {
  if (need <= arr.length) return arr
  let n = arr.length || 1024
  while (n < need) n *= 2
  const next = new Uint32Array(n)
  next.set(arr)
  return next
}
