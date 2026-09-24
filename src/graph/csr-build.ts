import { sql } from 'kysely'
import { Database } from '../db'
import { GraphConfig } from '../config'
import { ArenaInterner, ArenaInternerSnapshot, isInternable } from './arena-interner'
import { hubPostPrefix, loadHubLikesBeyondWindow } from './hub-likes'

// A finished CSR base, in a form that can cross a worker-thread boundary: every
// field is a typed array or a scalar, so `postMessage` moves the buffers instead
// of copying them.
export type CsrSnapshot = {
  userI: ArenaInternerSnapshot
  postI: ArenaInternerSnapshot
  fwdOff: Uint32Array
  fwdPost: Uint32Array
  fwdTs: Uint32Array
  revOff: Uint32Array
  revUser: Uint32Array
  users: number
  posts: number
  edges: number
}

// Every ArrayBuffer in a snapshot, for a postMessage transfer list.
export const csrSnapshotBuffers = (snap: CsrSnapshot): ArrayBuffer[] => [
  ...ArenaInterner.buffersOf(snap.userI),
  ...ArenaInterner.buffersOf(snap.postI),
  snap.fwdOff.buffer as ArrayBuffer,
  snap.fwdPost.buffer as ArrayBuffer,
  snap.fwdTs.buffer as ArrayBuffer,
  snap.revOff.buffer as ArrayBuffer,
  snap.revUser.buffer as ArrayBuffer,
]

export const EPOCH_MS = Date.UTC(2020, 0, 1)
const FUTURE_SKEW_MS = 5 * 60000
export const toTsMin = (ms: number): number => {
  const cap = Date.now() + FUTURE_SKEW_MS
  const clamped = ms > cap ? cap : ms
  const m = Math.floor((clamped - EPOCH_MS) / 60000)
  return m > 0 ? m : 0
}
const BUILD_PAGE = 100000

// Reads the like window out of Postgres and folds it into CSR arrays.
//
// Pure with respect to the live graph: it touches no shared state and returns a
// standalone snapshot, which is what lets it run in a worker thread. The caller
// owns swapping the result in and replaying whatever arrived meanwhile.
//
// `buildCeiling` must be the moment the caller began buffering live creates, so
// every row is covered by exactly one of the two paths: this scan (<= ceiling)
// or the caller's replay (>).
export const buildCsrSnapshot = async (
  db: Database,
  cfg: GraphConfig,
  buildCeilingMs: number,
): Promise<CsrSnapshot> => {
    const windowCutoff = new Date(
      Date.now() - cfg.windowHours * 60 * 60 * 1000,
    ).toISOString()
    // Upper bound for the scan. We now page by indexed_at (ascending), so
    // without a ceiling the scan would chase rows live ingestion appends
    // while the build runs and never reach the end. Anchored to startedAt —
    // the moment `pending` began buffering live creates — so every row is
    // covered by exactly one of the two: scan (<= ceiling) or replay (>).
    const buildCeiling = new Date(buildCeilingMs).toISOString()

    // pre-size edge staging from the actual row count to avoid power-of-two
    // over-allocation (count(*)::text avoids int overflow at 90d scale)
    const cnt = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM likes
      WHERE indexed_at > ${windowCutoff} AND indexed_at <= ${buildCeiling}
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
    let lastIndexed = ''
    let lastUri = ''
    let first = true
    let nextLog = 1000000

    const addEdge = (likerDid: string, subjectUri: string, createdAt: string) => {
      const ms = Date.parse(createdAt)
      if (isNaN(ms)) return
      if (!isInternable(subjectUri)) return // skip malformed URIs
      const u = userI.intern(likerDid)
      const p = postI.intern(subjectUri)
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

    // Interest posts are found by the scan itself: anyone onboarding onto one
    // likes it, so every hub still in use has a like inside the window. A hub
    // nobody picked for a whole window drops out until its next like, which
    // brings its full history back at the following rebuild.
    const hubPrefix = cfg.pickerDid ? hubPostPrefix(cfg.pickerDid) : null
    const hubUris = new Set<string>()

    // Page in indexed_at order, NOT liker_did order. `likes` is physically
    // laid out in ingest order (measured on prod: correlation 0.999 for
    // indexed_at vs 0.012 for liker_did), so paging by liker_did turned every
    // row into a random fetch into a >100GB heap — the build went I/O-bound at
    // ~17K edges/s and took ~8.5h, far longer than its own 2h rebuild
    // interval. Paging by indexed_at reads the heap near-sequentially.
    // (liker_did ordering is NOT needed for correctness: edges are staged flat
    // and counting-sorted into CSR below.)
    for (;;) {
      let q = db
        .selectFrom('likes')
        .select([
          'liker_did',
          'subject_uri',
          'created_at',
          'uri',
          'indexed_at',
        ])
        .where('indexed_at', '>', windowCutoff)
        .where('indexed_at', '<=', buildCeiling)
        .orderBy('indexed_at')
        .orderBy('uri')
        .limit(BUILD_PAGE)
      if (!first) {
        q = q.where(
          sql<boolean>`(indexed_at, uri) > (${lastIndexed}, ${lastUri})`,
        )
      }
      const rows = await q.execute()
      if (rows.length === 0) break

      for (const r of rows) {
        if (hubPrefix && r.subject_uri.startsWith(hubPrefix)) {
          hubUris.add(r.subject_uri)
        }
        addEdge(r.liker_did, r.subject_uri, r.created_at)
      }

      if (E >= nextLog) {
        console.log(
          `🧠 like-graph (csr) building… ${E} edges ` +
            `(~${Math.round((E / approxE) * 100)}%)`,
        )
        nextLog += 1000000
      }

      const last = rows[rows.length - 1]
      lastIndexed = last.indexed_at
      lastUri = last.uri
      first = false
      if (rows.length < BUILD_PAGE) break
      await new Promise((res) => setImmediate(res))
    }

    // Everything the window scan skipped on those hubs. `<= windowCutoff` is the
    // exact complement of the scan's lower bound, so no like is loaded twice.
    // These land out of time order at the ends of their users' slices; the
    // sortSlicesByTs pass below puts them back.
    if (hubUris.size > 0) {
      const hubRows = await loadHubLikesBeyondWindow(db, hubUris, windowCutoff)
      for (const r of hubRows) addEdge(r.liker_did, r.subject_uri, r.created_at)
      console.log(
        `🧠 like-graph (csr) kept ${hubRows.length} likes on ${hubUris.size} ` +
          `interest posts from beyond the window`,
      )
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

    // The scatter above is a stable counting sort, so each user's slice
    // inherits the scan order. score() walks a user's slice from the end and
    // breaks at the first like older than the candidate window, which is only
    // correct while the slice ascends by like time. Ingest order matches like
    // order for firehose likes but NOT for backfilled ones (recent
    // indexed_at, historical created_at) — those would land at the end of the
    // slice and truncate the traversal on its first step. Restore the
    // invariant explicitly. (revUser needs no ordering: it is accumulated
    // forward under a scan cap with no time-based break.)
    sortSlicesByTs(fwdOff, fwdPost, fwdTs, U)
  return {
    userI: userI.toSnapshot(),
    postI: postI.toSnapshot(),
    fwdOff,
    fwdPost,
    fwdTs,
    revOff,
    revUser,
    users: U,
    posts: P,
    edges: E,
  }
}

const INSERTION_MAX = 64

const sortSlicesByTs = (
  off: Uint32Array,
  post: Uint32Array,
  ts: Uint32Array,
  users: number,
): void => {
  let idx = new Uint32Array(0)
  let bufPost = new Uint32Array(0)
  let bufTs = new Uint32Array(0)

  for (let u = 0; u < users; u++) {
    const lo = off[u]
    const hi = off[u + 1]
    const n = hi - lo
    if (n < 2) continue

    let sorted = true
    for (let i = lo + 1; i < hi; i++) {
      if (ts[i] < ts[i - 1]) {
        sorted = false
        break
      }
    }
    if (sorted) continue

    if (n <= INSERTION_MAX) {
      for (let i = lo + 1; i < hi; i++) {
        const t = ts[i]
        const p = post[i]
        let j = i - 1
        while (j >= lo && ts[j] > t) {
          ts[j + 1] = ts[j]
          post[j + 1] = post[j]
          j--
        }
        ts[j + 1] = t
        post[j + 1] = p
      }
      continue
    }

    if (idx.length < n) {
      idx = new Uint32Array(n)
      bufPost = new Uint32Array(n)
      bufTs = new Uint32Array(n)
    }
    const order = idx.subarray(0, n)
    for (let i = 0; i < n; i++) order[i] = i
    order.sort((a, b) => ts[lo + a] - ts[lo + b])
    for (let i = 0; i < n; i++) {
      bufPost[i] = post[lo + order[i]]
      bufTs[i] = ts[lo + order[i]]
    }
    post.set(bufPost.subarray(0, n), lo)
    ts.set(bufTs.subarray(0, n), lo)
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
