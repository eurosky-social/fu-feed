import path from 'path'
import { Database } from '../db'
import { GraphConfig, RankingConfig } from '../config'
import { ILikeGraph, SeedLike } from './types'
import { ArenaInterner, isInternable } from './arena-interner'
import { BuildWorkerInput } from './build-worker'
import { CsrSnapshot, buildCsrSnapshot, toTsMin, toTsSec } from './csr-build'

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
  // like time per reverse edge, aligned with revUser; empty unless
  // GraphConfig.revTimestamps is on (see score()'s chronology weighting)
  private revTs = new Uint32Array(0)
  private baseUsers = 0
  private basePosts = 0

  // live overlay (ids may be < baseUsers/Posts, i.e. base nodes with new edges,
  // or >= base counts, i.e. brand-new nodes since the last build)
  private deltaFwd = new Map<number, number[]>() // [post, tsMin, …] chronological
  private deltaRev = new Map<number, number[]>() // [user, tsSec, …]
  private pending: Array<[string, string, number]> | null = null

  constructor(
    private readonly cfg: GraphConfig,
    // Connection string for the build worker's own pool: a Kysely/pg pool
    // belongs to the thread that created it and cannot be shared across
    // threads. Omit it to build on this thread against the `db` handed to
    // `buildFromPostgres` instead — which is what tests do, since a worker
    // would ignore their fake database and dial a real one.
    private readonly databaseUrl?: string,
  ) {}

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
    dr.push(u, toTsSec(createdAtMs))
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
      // Build off-thread. Everything up to this point is bookkeeping; the work
      // itself — interning every key and counting-sorting the edges — is what
      // used to starve the event loop. See build-worker.ts.
      //
      // `startedAt` is the ceiling for the scan AND the moment `pending` began
      // buffering, so every row lands in exactly one of the two: the scan or the
      // replay below.
      const snapshot = await this.runBuildWorker(db, startedAt)

      const userI = ArenaInterner.fromSnapshot(snapshot.userI)
      const postI = ArenaInterner.fromSnapshot(snapshot.postI)

      // swap in the new base
      this.userI = userI
      this.postI = postI
      this.fwdOff = snapshot.fwdOff
      this.fwdPost = snapshot.fwdPost
      this.fwdTs = snapshot.fwdTs
      this.revOff = snapshot.revOff
      this.revUser = snapshot.revUser
      this.revTs = snapshot.revTs
      this.baseUsers = snapshot.users
      this.basePosts = snapshot.posts
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
          dr.push(u, toTsSec(ms))
          replayed++
        }
      }

      console.log(
        `🧠 like-graph (csr) built: ${snapshot.users} users, ${snapshot.posts} posts, ` +
          `${snapshot.edges} edges (+${replayed} live) in ` +
          `${Math.round((Date.now() - startedAt) / 1000)}s`,
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

  // Runs the build in a worker thread, falling back to this thread if a worker
  // cannot be started at all.
  //
  // The fallback exists because a cold graph is worse than a slow one: with no
  // base to serve from, every viewer drops to the cold-start popularity feed. If
  // worker_threads is unavailable for some reason, taking the latency hit beats
  // never building. A worker that starts and then *fails* is a real error and
  // propagates — it must not be silently retried inline, or a reproducible build
  // failure would pin the event loop on every rebuild tick.
  private async runBuildWorker(
    db: Database,
    buildCeilingMs: number,
  ): Promise<CsrSnapshot> {
    if (!this.databaseUrl) {
      return buildCsrSnapshot(db, this.cfg, buildCeilingMs)
    }

    let Worker: typeof import('worker_threads').Worker
    try {
      ;({ Worker } = await import('worker_threads'))
    } catch {
      console.warn(
        '🧠 like-graph: worker_threads unavailable — building on the main thread',
      )
      return buildCsrSnapshot(db, this.cfg, buildCeilingMs)
    }

    // ts-node in development runs the .ts sources; the container runs the
    // compiled output. Resolve the sibling worker in whichever form we are.
    const isTs = __filename.endsWith('.ts')
    const workerPath = path.join(
      __dirname,
      isTs ? 'build-worker.ts' : 'build-worker.js',
    )
    const input: BuildWorkerInput = {
      databaseUrl: this.databaseUrl,
      graph: this.cfg,
      buildCeilingMs,
    }

    return new Promise<CsrSnapshot>((resolve, reject) => {
      const worker = new Worker(workerPath, {
        workerData: input,
        ...(isTs ? { execArgv: ['--require', 'ts-node/register'] } : {}),
      })
      let settled = false
      worker.on('message', (msg: { ok: boolean; snapshot?: CsrSnapshot; error?: string }) => {
        settled = true
        if (msg.ok && msg.snapshot) resolve(msg.snapshot)
        else reject(new Error(msg.error ?? 'graph build worker reported failure'))
        void worker.terminate()
      })
      worker.on('error', (err) => {
        settled = true
        reject(err)
      })
      worker.on('exit', (code) => {
        if (!settled) {
          reject(new Error(`graph build worker exited early with code ${code}`))
        }
      })
    })
  }

  score(
    viewerDid: string,
    seed: SeedLike[],
    r: RankingConfig,
    candidateLimit = r.maxCandidates,
  ): Map<string, number> {
    const out = new Map<string, number>()
    const n = seed.length
    if (n === 0 || !this.ready) return out
    const viewerInt = this.userI.get(viewerDid)

    const seedPostInts = new Set<number>()
    for (const s of seed) {
      const p = this.postI.get(s.uri)
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
    // Weight a curator by whether they got to the seed post before the viewer.
    // Needs a like time per reverse edge, which the base CSR only carries when
    // GraphConfig.revTimestamps is on; without it every liker counts as early.
    // Both sides of the comparison are in SECONDS (revTs / deltaRev / seedTs):
    // minute granularity let a bot reacting within the same minute as the
    // viewer's like count as "early" and slip past lateLikerWeight.
    const lateW = r.lateLikerWeight
    const chronologyOn = lateW !== 1 && this.revTs.length > 0

    // 1–2. curators + incoming weight
    const incoming = new Map<number, number>()
    for (let idx = 0; idx < n; idx++) {
      const p = this.postI.get(seed[idx].uri)
      if (p === undefined) continue
      const deg = this.revDegree(p)
      if (deg === 0) continue
      const w = n === 1 ? 1 : minW + (1 - minW) * (idx / (n - 1))
      const contrib = w / Math.pow(deg, r.itemBranchingPower)
      const lateContrib = contrib * lateW
      // the viewer's own like time on this seed post; a liker at or after it is
      // late. An unusable timestamp leaves everyone early rather than guessing.
      const seedTs = chronologyOn ? seedTsMin(seed[idx].likedAtMs) : 0
      let scanned = 0
      const cap = this.cfg.seedLikerScanCap
      // base likers
      if (p < this.basePosts) {
        const end = this.revOff[p + 1]
        for (let i = this.revOff[p]; i < end && scanned < cap; i++) {
          const u = this.revUser[i]
          scanned++
          const c =
            chronologyOn && this.revTs[i] >= seedTs ? lateContrib : contrib
          if (c === 0) continue // lateLikerWeight 0 → late likers are dropped
          incoming.set(u, (incoming.get(u) ?? 0) + c)
        }
      }
      // delta likers ([user, tsSec] pairs)
      const dr = this.deltaRev.get(p)
      if (dr) {
        for (let k = 0; k < dr.length && scanned < cap; k += 2) {
          const u = dr[k]
          scanned++
          const c = chronologyOn && dr[k + 1] >= seedTs ? lateContrib : contrib
          if (c === 0) continue
          incoming.set(u, (incoming.get(u) ?? 0) + c)
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
  // (the delta holds [user, tsSec] pairs)
  private revDegree(p: number): number {
    const base = p < this.basePosts ? this.revOff[p + 1] - this.revOff[p] : 0
    return base + (this.deltaRev.get(p)?.length ?? 0) / 2
  }
}

// The viewer's like time on a seed post, in the graph's tsSec encoding, so it
// compares against reverse-edge times that are also in seconds (see toTsSec).
// Infinity for an unusable timestamp, which makes every liker compare as early
// and so leaves that seed post unweighted rather than mis-weighted.
const seedTsMin = (likedAtMs: number): number =>
  Number.isFinite(likedAtMs) ? toTsSec(likedAtMs) : Number.POSITIVE_INFINITY

// Slices at or below this length use insertion sort; longer ones use an index
// sort, so a heavily-backfilled high-degree user can't hit insertion sort's
// quadratic worst case.
const INSERTION_MAX = 64

// Sorts every user's CSR slice ascending by timestamp, keeping `post` aligned
// with `ts`. Slices are already ascending in the overwhelmingly common case
// (ingest order == like order), so the sortedness check short-circuits nearly
// every user and this is effectively one linear pass over the edges.
