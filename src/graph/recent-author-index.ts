import { sql } from 'kysely'
import { Database } from '../db'
import { FollowsConfig } from '../config'
import { ArenaInterner, isInternable } from './arena-interner'
import { toTsMin } from './csr-build'

// Author -> their recent posts, with an engagement score per post, plus
// (optionally) reposter -> what they amplified.
//
// This is the follows feed's candidate source, and it is deliberately NOT part
// of the CSR like graph. The two answer different questions and are sized
// accordingly:
//
//   CSR graph    "who else liked the posts I liked" — needs every liker's
//                identity across a 30-day window (~500M edges, tens of GB).
//   this index   "what did the people I follow post, and how much engagement
//                did it get" — needs a COUNT per post across the freshness
//                window (~48h), and no liker identities at all.
//
// Dropping the identities and shrinking the window is what makes it cheap.
// Measured on production at a 48h window: 36.2M likes fold into 5.64M posts
// across 756k authors, seeded in 212s, for roughly half a gigabyte — against
// the graph's tens. The interned post URIs are most of that, so cost scales
// with FOLLOWS_WINDOW_HOURS; compaction transiently doubles the surviving set
// while it rebuilds around it.
//
// Keeping it separate is also what keeps the follows feed movable — ranker,
// index and follow table lift out as a unit if this ever needs its own process
// (see README).
//
// Layout is intrusive-list-in-typed-arrays, no per-node objects:
//   authorHead[a]   -> newest post id by author a, or UNSET
//   postPrev[p]     -> the next-older post by the same author, or UNSET
//   reposterHead[r] -> newest repost edge by reposter r, or UNSET
//   repostPrev[e]   -> the next-older edge by the same reposter, or UNSET
// Ids are handed out by the interner in first-sighting order, so walking a list
// from its head yields newest-first.
//
// Liker and reposter identities are never stored against a post, so its counts
// are "what this process observed in the window", not global totals.
// finalize() still reads the authoritative global like count from post_meta.

const POST_PATH = '/app.bsky.feed.post/'
const UNSET = -1
const SEED_PAGE = 100000
const HOUR_MS = 60 * 60 * 1000

// `at://did:plc:xyz/app.bsky.feed.post/3k…` -> `did:plc:xyz`. Returns '' for
// anything that is not a post at-URI: the ingesters already filter on the
// collection, but the seed scans read whatever the tables hold.
export const authorOf = (postUri: string): string => {
  if (!postUri.startsWith('at://')) return ''
  const slash = postUri.indexOf('/', 5)
  if (slash < 0) return ''
  if (!postUri.startsWith(POST_PATH, slash)) return ''
  return postUri.slice(5, slash)
}

export type CandidateOptions = {
  // a post qualifies only if its first observed engagement falls in this window
  windowHours: number
  // minimum in-window engagement score for a post to be a candidate
  minEngagement: number
  // per-author scan cap, applied newest-first — bounds the walk for prolific
  // authors instead of letting one account's output dominate the scan
  maxPostsPerAuthor: number
  // divide an authored post's score by its author's in-window mean^power, so a
  // small account's unusually good post can compete with a large account's
  // routine one (0 = off, raw engagement; 1 = full normalization)
  authorNormalization: number
  // what one repost is worth relative to one like
  repostWeight: number
  // also surface posts the followed accounts reposted, not only those they
  // wrote
  includeReposts: boolean
  // per-reposter scan cap, applied newest-first
  maxRepostsPerReposter: number
  // how many top-scoring candidates to return
  limit: number
}

// What one candidate-generation pass produced.
export type CandidateSet = {
  // post URI -> engagement score, already in descending score order
  scores: Map<string, number>
  // post URI -> the followed account whose repost put it here. Only posts that
  // reached the feed SOLELY through a repost appear: a post one of the viewer's
  // own follows wrote needs no explanation, so it is attributed to nobody.
  repostedBy: Map<string, string>
}

// Everything the index is. Swapped wholesale by seed/compact so readers never
// observe a half-built state (both run synchronously with respect to the event
// loop except for the seed's awaits, which all happen before the swap).
type Store = {
  authorI: ArenaInterner
  postI: ArenaInterner
  postAuthor: Int32Array
  postLikes: Uint32Array
  postReposts: Uint32Array
  postSeen: Uint32Array // tsMin of the first engagement we observed on this post
  postPrev: Int32Array
  authorHead: Int32Array
  nPosts: number
  nAuthors: number
  // repost edges — only populated when the feed opts into reposts as content
  reposterI: ArenaInterner
  repostPost: Int32Array // edge -> post id, or UNSET once retracted
  repostActor: Int32Array // edge -> reposter id
  repostPrev: Int32Array
  reposterHead: Int32Array
  nReposts: number
  nReposters: number
}

const emptyStore = (expectedPosts = 1 << 16): Store => {
  const actors = Math.max(16, expectedPosts >> 2)
  return {
    authorI: new ArenaInterner(actors),
    postI: new ArenaInterner(Math.max(16, expectedPosts)),
    postAuthor: new Int32Array(expectedPosts),
    postLikes: new Uint32Array(expectedPosts),
    postReposts: new Uint32Array(expectedPosts),
    postSeen: new Uint32Array(expectedPosts),
    postPrev: new Int32Array(expectedPosts),
    authorHead: new Int32Array(actors).fill(UNSET),
    nPosts: 0,
    nAuthors: 0,
    reposterI: new ArenaInterner(16),
    repostPost: new Int32Array(0),
    repostActor: new Int32Array(0),
    repostPrev: new Int32Array(0),
    reposterHead: new Int32Array(16).fill(UNSET),
    nReposts: 0,
    nReposters: 0,
  }
}

const growPosts = (s: Store, need: number): void => {
  if (need <= s.postAuthor.length) return
  let n = s.postAuthor.length || 1024
  while (n < need) n *= 2
  const author = new Int32Array(n)
  author.set(s.postAuthor)
  s.postAuthor = author
  const likes = new Uint32Array(n)
  likes.set(s.postLikes)
  s.postLikes = likes
  const reposts = new Uint32Array(n)
  reposts.set(s.postReposts)
  s.postReposts = reposts
  const seen = new Uint32Array(n)
  seen.set(s.postSeen)
  s.postSeen = seen
  const prev = new Int32Array(n)
  prev.set(s.postPrev)
  s.postPrev = prev
}

const growAuthors = (s: Store, need: number): void => {
  if (need <= s.authorHead.length) return
  let n = s.authorHead.length || 1024
  while (n < need) n *= 2
  const head = new Int32Array(n).fill(UNSET)
  head.set(s.authorHead)
  s.authorHead = head
}

const growRepostEdges = (s: Store, need: number): void => {
  if (need <= s.repostPost.length) return
  let n = s.repostPost.length || 1024
  while (n < need) n *= 2
  const post = new Int32Array(n)
  post.set(s.repostPost)
  s.repostPost = post
  const actor = new Int32Array(n)
  actor.set(s.repostActor)
  s.repostActor = actor
  const prev = new Int32Array(n)
  prev.set(s.repostPrev)
  s.repostPrev = prev
}

const growReposters = (s: Store, need: number): void => {
  if (need <= s.reposterHead.length) return
  let n = s.reposterHead.length || 1024
  while (n < need) n *= 2
  const head = new Int32Array(n).fill(UNSET)
  head.set(s.reposterHead)
  s.reposterHead = head
}

// Finds a post's id, creating its entry if this is the first engagement we have
// seen on it. Returns UNSET for anything that is not a usable post URI.
//
// `firstSeenMs` is INGEST time, not the record's createdAt: a client can
// backdate a record, and postSeen is the only thing standing between the index
// and unbounded growth.
const touchPost = (s: Store, postUri: string, firstSeenMs: number): number => {
  if (!isInternable(postUri)) return UNSET
  const author = authorOf(postUri)
  if (author === '' || !isInternable(author)) return UNSET

  // Interner ids are dense and handed out in order, so an id below nPosts is a
  // post we have already recorded — one hash lookup instead of get-then-intern.
  const p = s.postI.intern(postUri)
  if (p < s.nPosts) return p

  const a = s.authorI.intern(author)
  growPosts(s, p + 1)
  growAuthors(s, a + 1)
  s.postAuthor[p] = a
  s.postLikes[p] = 0
  s.postReposts[p] = 0
  s.postSeen[p] = toTsMin(firstSeenMs)
  s.postPrev[p] = s.authorHead[a]
  s.authorHead[a] = p
  s.nPosts = p + 1
  if (a >= s.nAuthors) s.nAuthors = a + 1
  return p
}

const recordLike = (s: Store, postUri: string, indexedAtMs: number): void => {
  const p = touchPost(s, postUri, indexedAtMs)
  if (p === UNSET) return
  if (s.postLikes[p] < 0xffffffff) s.postLikes[p]++
}

// `keepEdges` is the includeReposts switch: without it a repost is only an
// engagement count, and the reposter -> post edge that would let a stranger's
// post reach the feed is not worth its memory.
const recordRepost = (
  s: Store,
  reposterDid: string,
  postUri: string,
  indexedAtMs: number,
  keepEdges: boolean,
): void => {
  const p = touchPost(s, postUri, indexedAtMs)
  if (p === UNSET) return
  if (s.postReposts[p] < 0xffffffff) s.postReposts[p]++
  if (!keepEdges || !isInternable(reposterDid)) return

  const r = s.reposterI.intern(reposterDid)
  const e = s.nReposts
  growRepostEdges(s, e + 1)
  growReposters(s, r + 1)
  s.repostPost[e] = p
  s.repostActor[e] = r
  s.repostPrev[e] = s.reposterHead[r]
  s.reposterHead[r] = e
  s.nReposts = e + 1
  if (r >= s.nReposters) s.nReposters = r + 1
}

// How far back an unrepost will walk a reposter's list looking for the edge to
// retract. Their in-window reposts are few, and a miss only leaves a stale edge
// that the next compaction drops.
const UNREPOST_SCAN_CAP = 1000

const recordUnrepost = (
  s: Store,
  reposterDid: string,
  postUri: string,
): void => {
  const p = s.postI.get(postUri)
  if (p === undefined || p >= s.nPosts) return
  if (s.postReposts[p] > 0) s.postReposts[p]--

  const r = s.reposterI.get(reposterDid)
  if (r === undefined || r >= s.nReposters) return
  let scanned = 0
  for (
    let e = s.reposterHead[r];
    e !== UNSET && scanned < UNREPOST_SCAN_CAP;
    e = s.repostPrev[e]
  ) {
    scanned++
    if (s.repostPost[e] !== p) continue
    s.repostPost[e] = UNSET // retract this edge, keep the list intact
    return
  }
}

const engagement = (s: Store, p: number, repostWeight: number): number =>
  s.postLikes[p] + repostWeight * s.postReposts[p]

// An event observed while a seed was scanning Postgres, replayed against the
// fresh store once the scan lands.
type PendingEvent = {
  kind: 'like' | 'repost'
  uri: string
  // the reposter, for repost events
  actor: string
  ms: number
  // -1 for an unlike / unrepost
  delta: number
}

export class RecentAuthorIndex {
  ready = false
  private seeding = false
  private store: Store = emptyStore()
  private pending: PendingEvent[] | null = null

  constructor(private readonly cfg: FollowsConfig) {}

  // Reposts are only read from the firehose when they can affect a score.
  private get wantsReposts(): boolean {
    return this.cfg.repostWeight > 0
  }

  // Live firehose hook. `indexedAtMs` is ingest time (see touchPost).
  applyLike(postUri: string, indexedAtMs: number): void {
    this.pending?.push({
      kind: 'like',
      uri: postUri,
      actor: '',
      ms: indexedAtMs,
      delta: 1,
    })
    if (!this.ready) return
    recordLike(this.store, postUri, indexedAtMs)
  }

  // An unlike off the firehose. The post keeps its slot (ids are never
  // reclaimed outside a compaction); only the count moves.
  applyUnlike(postUri: string): void {
    this.pending?.push({
      kind: 'like',
      uri: postUri,
      actor: '',
      ms: 0,
      delta: -1,
    })
    if (!this.ready) return
    const s = this.store
    const p = s.postI.get(postUri)
    if (p === undefined || p >= s.nPosts) return
    if (s.postLikes[p] > 0) s.postLikes[p]--
  }

  applyRepost(
    reposterDid: string,
    postUri: string,
    indexedAtMs: number,
  ): void {
    if (!this.wantsReposts) return
    this.pending?.push({
      kind: 'repost',
      uri: postUri,
      actor: reposterDid,
      ms: indexedAtMs,
      delta: 1,
    })
    if (!this.ready) return
    recordRepost(
      this.store,
      reposterDid,
      postUri,
      indexedAtMs,
      this.cfg.includeReposts,
    )
  }

  applyUnrepost(reposterDid: string, postUri: string): void {
    if (!this.wantsReposts) return
    this.pending?.push({
      kind: 'repost',
      uri: postUri,
      actor: reposterDid,
      ms: 0,
      delta: -1,
    })
    if (!this.ready) return
    recordUnrepost(this.store, reposterDid, postUri)
  }

  // One-time fill from Postgres so the feed is useful immediately after a
  // restart rather than only for posts engaged with since. Returns false on
  // failure so the caller can retry; the index stays unready and the feed falls
  // back to the cold-start popularity list meanwhile.
  //
  // Backfilled like rows carry a CURRENT indexed_at (see ranker/backfill.ts), so
  // the scan can admit posts that are older than the window — finalize() is the
  // authoritative age filter and drops them on post_meta.created_at.
  async seedFromPostgres(db: Database): Promise<boolean> {
    if (this.seeding) {
      console.warn('🗂️ follows index seed skipped: a seed is already running')
      return false
    }
    this.seeding = true
    // `startedAt` is both the scans' ceiling and the moment `pending` starts
    // buffering, so every event lands in exactly one of the two: a scan
    // (<= ceiling) or the replay below.
    const startedAt = Date.now()
    this.pending = []
    try {
      const windowCutoff = new Date(
        startedAt - this.cfg.windowHours * HOUR_MS,
      ).toISOString()
      const ceiling = new Date(startedAt).toISOString()
      const next = emptyStore(1 << 20)

      const likes = await this.scan(
        db,
        'likes',
        windowCutoff,
        ceiling,
        (row) => recordLike(next, row.subject_uri, Date.parse(row.indexed_at)),
      )
      let reposts = 0
      if (this.wantsReposts) {
        reposts = await this.scan(
          db,
          'reposts',
          windowCutoff,
          ceiling,
          (row) =>
            recordRepost(
              next,
              row.actor_did,
              row.subject_uri,
              Date.parse(row.indexed_at),
              this.cfg.includeReposts,
            ),
        )
      }

      this.store = next
      this.ready = true

      // Detach the buffer BEFORE replaying it: the apply* methods append to
      // `this.pending` whenever it is non-null, so replaying through it while it
      // is still attached would feed the loop its own output.
      const buffered = this.pending ?? []
      this.pending = null
      for (const ev of buffered) {
        if (ev.kind === 'like') {
          if (ev.delta > 0) recordLike(next, ev.uri, ev.ms)
          else this.applyUnlike(ev.uri)
        } else if (ev.delta > 0) {
          recordRepost(next, ev.actor, ev.uri, ev.ms, this.cfg.includeReposts)
        } else {
          this.applyUnrepost(ev.actor, ev.uri)
        }
      }

      console.log(
        `🗂️ follows index seeded: ${next.nPosts} posts, ${next.nAuthors} authors ` +
          `from ${likes} likes + ${reposts} reposts (+${buffered.length} live) ` +
          `in ${Math.round((Date.now() - startedAt) / 1000)}s`,
      )
      return true
    } catch (err) {
      console.error('follows index seed failed', err)
      return false
    } finally {
      this.pending = null
      this.seeding = false
    }
  }

  // Keyset-pages one engagement table in indexed_at order: both are physically
  // laid out in ingest order, so this reads the heap near-sequentially. Paging
  // by any other column turns every row into a random fetch (see csr-build.ts).
  private async scan(
    db: Database,
    table: 'likes' | 'reposts',
    windowCutoff: string,
    ceiling: string,
    apply: (row: {
      subject_uri: string
      indexed_at: string
      actor_did: string
    }) => void,
  ): Promise<number> {
    const actorColumn = table === 'likes' ? 'liker_did' : 'reposter_did'
    let lastIndexed = ''
    let lastUri = ''
    let first = true
    let rowsRead = 0

    for (;;) {
      let q = db
        .selectFrom(table)
        .select(['subject_uri', 'indexed_at', 'uri', `${actorColumn} as actor_did`])
        .where('indexed_at', '>', windowCutoff)
        .where('indexed_at', '<=', ceiling)
        .orderBy('indexed_at')
        .orderBy('uri')
        .limit(SEED_PAGE)
      if (!first) {
        q = q.where(
          sql<boolean>`(indexed_at, uri) > (${lastIndexed}, ${lastUri})`,
        )
      }
      const rows = await q.execute()
      if (rows.length === 0) break
      for (const row of rows) apply(row)
      rowsRead += rows.length
      const last = rows[rows.length - 1]
      lastIndexed = last.indexed_at
      lastUri = last.uri
      first = false
      if (rows.length < SEED_PAGE) break
    }
    return rowsRead
  }

  // Rebuilds the store with only the posts still inside the window, reclaiming
  // everything else. Purely in-memory — no Postgres, no firehose gap — because
  // ids cannot be freed individually: the interner has no delete, so aged-out
  // posts are dropped by rebuilding around the survivors.
  //
  // Costs one string rebuild per surviving post, which is why this runs on a
  // slow timer rather than per request.
  compact(): void {
    if (!this.ready || this.seeding) return
    const startedAt = Date.now()
    const s = this.store
    const cutoff = toTsMin(startedAt - this.cfg.windowHours * HOUR_MS)
    const next = emptyStore(Math.max(1 << 16, s.nPosts))
    // old post id -> new post id, so the repost edges can be re-pointed
    const moved = new Int32Array(s.nPosts).fill(UNSET)

    // Oldest id first, so the fresh ids stay in first-sighting order and each
    // author's list keeps its newest-first ordering.
    for (let p = 0; p < s.nPosts; p++) {
      if (s.postSeen[p] < cutoff) continue
      if (s.postLikes[p] === 0 && s.postReposts[p] === 0) continue
      const q = touchPost(next, s.postI.keyAt(p), 0)
      if (q === UNSET) continue
      next.postLikes[q] = s.postLikes[p]
      next.postReposts[q] = s.postReposts[p]
      next.postSeen[q] = s.postSeen[p]
      moved[p] = q
    }

    // Repost edges, oldest first for the same reason. Edges whose post did not
    // survive, and edges retracted by an unrepost, are simply not copied.
    if (this.cfg.includeReposts) {
      for (let e = 0; e < s.nReposts; e++) {
        const p = s.repostPost[e]
        if (p === UNSET || moved[p] === UNSET) continue
        const r = next.reposterI.intern(s.reposterI.keyAt(s.repostActor[e]))
        const ne = next.nReposts
        growRepostEdges(next, ne + 1)
        growReposters(next, r + 1)
        next.repostPost[ne] = moved[p]
        next.repostActor[ne] = r
        next.repostPrev[ne] = next.reposterHead[r]
        next.reposterHead[r] = ne
        next.nReposts = ne + 1
        if (r >= next.nReposters) next.nReposters = r + 1
      }
    }

    this.store = next
    console.log(
      `🗂️ follows index compacted: ${next.nPosts}/${s.nPosts} posts, ` +
        `${next.nReposts}/${s.nReposts} reposts, ${next.nAuthors} authors ` +
        `in ${Date.now() - startedAt}ms`,
    )
  }

  // Post URIs the given accounts wrote (and, when the feed opts in, reposted),
  // scored by in-window engagement, in descending score order — finalize()
  // relies on that ordering for its hydration budget.
  candidates(actorDids: string[], opts: CandidateOptions): CandidateSet {
    const scores = new Map<string, number>()
    const repostedBy = new Map<string, string>()
    const s = this.store
    if (!this.ready || actorDids.length === 0) return { scores, repostedBy }

    const cutoff = toTsMin(Date.now() - opts.windowHours * HOUR_MS)
    // A post can be reached twice — written by one follow, reposted by another.
    // Keep its best score rather than letting the order depend on which arm ran.
    const best = new Map<number, number>()
    const consider = (p: number, score: number): void => {
      const prev = best.get(p)
      if (prev === undefined || score > prev) best.set(p, score)
    }
    // Posts one of these accounts actually wrote. They need no "reposted by"
    // explanation, which is why the authored pass runs first and in full.
    const authored = new Set<number>()
    const attribution = new Map<number, string>()

    const localIds: number[] = []
    const localScores: number[] = []

    // --- pass 1: posts they wrote ---
    for (const did of actorDids) {
      const a = s.authorI.get(did)
      if (a === undefined || a >= s.nAuthors) continue
      localIds.length = 0
      localScores.length = 0
      let scanned = 0
      let sum = 0
      for (
        let p = s.authorHead[a];
        p !== UNSET && scanned < opts.maxPostsPerAuthor;
        p = s.postPrev[p]
      ) {
        scanned++
        if (s.postSeen[p] < cutoff) continue
        const score = engagement(s, p, opts.repostWeight)
        if (score < opts.minEngagement) continue
        localIds.push(p)
        localScores.push(score)
        sum += score
      }
      const divisor =
        opts.authorNormalization > 0 && localIds.length > 0
          ? Math.pow(
              Math.max(1, sum / localIds.length),
              opts.authorNormalization,
            )
          : 1
      for (let i = 0; i < localIds.length; i++) {
        authored.add(localIds[i])
        consider(localIds[i], localScores[i] / divisor)
      }
    }

    // --- pass 2: posts they reposted ---
    // Runs after pass 1 so `authored` is complete: a post written by follow A
    // and reposted by follow B is A's post, not B's amplification. Where two
    // follows both reposted something, the first one scanned gets the credit.
    if (opts.includeReposts) {
      for (const did of actorDids) {
        const r = s.reposterI.get(did)
        if (r === undefined || r >= s.nReposters) continue
        let scanned = 0
        for (
          let e = s.reposterHead[r];
          e !== UNSET && scanned < opts.maxRepostsPerReposter;
          e = s.repostPrev[e]
        ) {
          scanned++
          const p = s.repostPost[e]
          if (p === UNSET) continue // retracted by an unrepost
          if (s.postSeen[p] < cutoff) continue
          const score = engagement(s, p, opts.repostWeight)
          if (score < opts.minEngagement) continue
          // No author normalization here: the post is not the reposter's, so
          // their posting volume says nothing about how it should be weighted.
          consider(p, score)
          if (!authored.has(p) && !attribution.has(p)) attribution.set(p, did)
        }
      }
    }
    if (best.size === 0) return { scores, repostedBy }

    // Ties are common (most posts sit at one or two likes), so break them by
    // recency — otherwise the tail of the feed is ordered by interning accident.
    const ids = [...best.keys()]
    ids.sort(
      (x, y) => (best.get(y) as number) - (best.get(x) as number) ||
        s.postSeen[y] - s.postSeen[x],
    )
    const take = Math.min(ids.length, opts.limit)
    for (let k = 0; k < take; k++) {
      const id = ids[k]
      const uri = s.postI.keyAt(id)
      scores.set(uri, best.get(id) as number)
      const by = attribution.get(id)
      if (by !== undefined) repostedBy.set(uri, by)
    }
    return { scores, repostedBy }
  }

  stats(): {
    ready: boolean
    authors: number
    posts: number
    reposts: number
  } {
    return {
      ready: this.ready,
      authors: this.store.nAuthors,
      posts: this.store.nPosts,
      reposts: this.store.nReposts,
    }
  }
}
