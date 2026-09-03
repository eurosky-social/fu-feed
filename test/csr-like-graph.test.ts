import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CsrLikeGraph } from '../src/graph/csr-like-graph'
import { graphConfig, hoursAgo, rankingConfig } from './helpers/config'
import { LikeRow, likeRowsHandler, makeFakeDb } from './helpers/fake-db'

const VIEWER = 'did:plc:viewer'
const CURATOR = 'did:plc:curator'
const SEED = 'at://did:plc:author/app.bsky.feed.post/seed'

// `indexed_at` is ingest time, `created_at` is when the like was made. They
// agree for firehose likes and diverge for backfilled ones.
const like = (
  liker: string,
  subject: string,
  createdHoursAgo: number,
  indexedHoursAgo: number = createdHoursAgo,
): LikeRow => ({
  uri: `at://${liker}/app.bsky.feed.like/${subject.split('/').pop()}`,
  liker_did: liker,
  subject_uri: subject,
  created_at: hoursAgo(createdHoursAgo),
  indexed_at: hoursAgo(indexedHoursAgo),
})

// The viewer's own like on a seed post, in the shape GraphRanker passes: epoch
// ms, so the graph can tell which of that post's other likers got there first.
const seed = (uri: string, likedHoursAgo: number) => [
  { uri, likedAtMs: Date.now() - likedHoursAgo * 60 * 60 * 1000 },
]

const build = async (rows: LikeRow[]) => {
  const graph = new CsrLikeGraph(graphConfig())
  const { db, queries } = makeFakeDb(likeRowsHandler(rows))
  const ok = await graph.buildFromPostgres(db)
  assert.equal(ok, true, 'build should succeed')
  return { graph, queries }
}

describe('CsrLikeGraph.buildFromPostgres', () => {
  it('pages the like scan in indexed_at order, bounded above', async () => {
    const { queries } = await build([like(VIEWER, SEED, 1)])

    const scan = queries.find((q) => q.sql.includes('from "likes"') && !q.sql.includes('count(*)'))
    assert.ok(scan, 'expected a like-scan query')

    // Ordering by indexed_at is what keeps the heap read near-sequential;
    // liker_did ordering is uncorrelated with heap layout and made the build
    // I/O-bound in production.
    assert.match(scan!.sql, /order by "indexed_at", "uri"/)
    assert.doesNotMatch(scan!.sql, /order by "liker_did"/)

    // Both window floor and build ceiling must bound the scan, or an
    // ascending-indexed_at scan chases live inserts and never terminates.
    const bounds = scan!.sql.match(/"indexed_at"/g) ?? []
    assert.ok(bounds.length >= 2, 'scan should have a lower and an upper indexed_at bound')
    assert.match(scan!.sql, /"indexed_at" <=/)
  })

  it('reports the graph it loaded', async () => {
    const { graph } = await build([
      like(VIEWER, SEED, 1),
      like(CURATOR, SEED, 2),
      like(CURATOR, 'at://did:plc:a/app.bsky.feed.post/p1', 1),
    ])
    const stats = graph.stats()
    assert.equal(stats.ready, true)
    assert.equal(stats.users, 2)
    assert.equal(stats.posts, 2)
  })
})

describe('CsrLikeGraph.score', () => {
  it('surfaces a co-liked candidate and never the seed itself', async () => {
    const candidate = 'at://did:plc:a/app.bsky.feed.post/fresh'
    const { graph } = await build([
      like(VIEWER, SEED, 3),
      like(CURATOR, SEED, 2),
      like(CURATOR, candidate, 1),
    ])

    const scored = graph.score(VIEWER, seed(SEED, 3), rankingConfig())
    assert.ok(scored.has(candidate), 'co-liked candidate should be scored')
    assert.ok((scored.get(candidate) ?? 0) > 0, 'candidate should score above zero')
    assert.ok(!scored.has(SEED), 'the seed post must not be recommended back')
  })

  it('excludes the viewer from their own curator set', async () => {
    // The viewer also liked `own`; nothing else did. If the viewer counted as
    // their own curator, `own` would come back as a recommendation.
    const own = 'at://did:plc:a/app.bsky.feed.post/own'
    const { graph } = await build([
      like(VIEWER, SEED, 3),
      like(VIEWER, own, 1),
    ])

    const scored = graph.score(VIEWER, seed(SEED, 3), rankingConfig())
    assert.ok(!scored.has(own), 'viewer must not be their own curator')
  })

  it('ignores curator likes older than the candidate window', async () => {
    const stale = 'at://did:plc:a/app.bsky.feed.post/stale'
    const { graph } = await build([
      like(VIEWER, SEED, 3),
      like(CURATOR, SEED, 2),
      like(CURATOR, stale, 200), // well outside candidateLikeWindowHours (48)
    ])

    const scored = graph.score(VIEWER, seed(SEED, 3), rankingConfig())
    assert.ok(!scored.has(stale), 'like outside the candidate window must not qualify')
  })

  // REGRESSION — the trap in paging by indexed_at.
  //
  // score() walks a curator's CSR slice from the end and breaks at the first
  // like older than the candidate window, which is only sound while the slice
  // ascends by like time. The CSR scatter is a *stable* counting sort, so the
  // slice inherits the SQL scan order. Under indexed_at paging a backfilled
  // like (recent indexed_at, historical created_at) lands at the end of the
  // slice, so without an explicit re-sort the traversal breaks on its very
  // first step and the curator contributes nothing.
  it('still finds candidates when a backfilled like is ingested last', async () => {
    const fresh = 'at://did:plc:a/app.bsky.feed.post/fresh'
    const backfilled = 'at://did:plc:a/app.bsky.feed.post/ancient'

    // Rows in indexed_at order, as the scan now returns them. The backfilled
    // like is oldest by created_at but newest by indexed_at.
    const { graph } = await build([
      like(VIEWER, SEED, 4, 4),
      like(CURATOR, SEED, 3, 3),
      like(CURATOR, fresh, 1, 1),
      like(CURATOR, backfilled, 500, 0.1),
    ])

    const scored = graph.score(VIEWER, seed(SEED, 4), rankingConfig())
    assert.ok(
      scored.has(fresh),
      'a backfilled like at the slice end must not truncate the traversal',
    )
    assert.ok(!scored.has(backfilled), 'the out-of-window backfilled like stays excluded')
  })

  it('keeps a heavily-backfilled curator ordered across many likes', async () => {
    // Same hazard at scale: interleave in-window and out-of-window likes so
    // ingest order is badly shuffled relative to like time.
    const rows: LikeRow[] = [like(VIEWER, SEED, 100, 100), like(CURATOR, SEED, 99, 99)]
    const expected: string[] = []
    for (let i = 0; i < 80; i++) {
      const uri = `at://did:plc:a/app.bsky.feed.post/p${i}`
      const createdHours = i % 2 === 0 ? 1 + (i % 24) : 400 + i
      rows.push(like(CURATOR, uri, createdHours, 50 - i * 0.5))
      if (i % 2 === 0) expected.push(uri)
    }

    const { graph } = await build(rows)
    const scored = graph.score(VIEWER, seed(SEED, 100), rankingConfig())

    for (const uri of expected) {
      assert.ok(scored.has(uri), `in-window candidate ${uri} should survive`)
    }
  })

  it('honours minEligibleRaters', async () => {
    const single = 'at://did:plc:a/app.bsky.feed.post/single'
    const { graph } = await build([
      like(VIEWER, SEED, 3),
      like(CURATOR, SEED, 2),
      like(CURATOR, single, 1),
    ])

    // one curator liked it, so a threshold of 2 must exclude it
    const scored = graph.score(VIEWER, seed(SEED, 3), rankingConfig({ minEligibleRaters: 2 }))
    assert.ok(!scored.has(single), 'single-rater candidate should be cut at threshold 2')
  })

  it('caps the returned candidates at candidateLimit', async () => {
    const rows: LikeRow[] = [like(VIEWER, SEED, 5), like(CURATOR, SEED, 4)]
    for (let i = 0; i < 30; i++) {
      rows.push(like(CURATOR, `at://did:plc:a/app.bsky.feed.post/c${i}`, 1))
    }
    const { graph } = await build(rows)

    const scored = graph.score(VIEWER, seed(SEED, 5), rankingConfig(), 5)
    assert.equal(scored.size, 5, 'candidateLimit should bound the result')
  })

  // Chronology: someone who liked the seed post BEFORE the viewer found it
  // independently; someone who liked it after may just have ridden the same
  // wave. lateLikerWeight decides how much the latter still counts.
  describe('lateLikerWeight', () => {
    const EARLY = 'did:plc:early'
    const LATE = 'did:plc:late'
    const earlyPick = 'at://did:plc:a/app.bsky.feed.post/early-pick'
    const latePick = 'at://did:plc:a/app.bsky.feed.post/late-pick'

    // Symmetric by construction: both curators liked the seed and one further
    // post each, so the only thing separating them is *when* they liked SEED.
    const fixture = () =>
      build([
        like(EARLY, SEED, 6), // before the viewer
        like(VIEWER, SEED, 5),
        like(LATE, SEED, 4), // after the viewer
        like(EARLY, earlyPick, 1),
        like(LATE, latePick, 1),
      ])

    it('ranks the early liker\'s pick above the late liker\'s', async () => {
      const { graph } = await fixture()
      const scored = graph.score(
        VIEWER,
        seed(SEED, 5),
        rankingConfig({ lateLikerWeight: 0.3 }),
      )
      assert.ok(
        (scored.get(earlyPick) ?? 0) > (scored.get(latePick) ?? 0),
        'the pick of the curator who liked the seed first should score higher',
      )
    })

    it('drops late likers entirely at weight 0', async () => {
      const { graph } = await fixture()
      const scored = graph.score(
        VIEWER,
        seed(SEED, 5),
        rankingConfig({ lateLikerWeight: 0 }),
      )
      assert.ok(scored.has(earlyPick), 'the early liker still curates')
      assert.ok(!scored.has(latePick), 'a late liker contributes nothing at weight 0')
    })

    it('ignores chronology at weight 1', async () => {
      const { graph } = await fixture()
      const scored = graph.score(VIEWER, seed(SEED, 5), rankingConfig({ lateLikerWeight: 1 }))
      assert.equal(
        scored.get(earlyPick),
        scored.get(latePick),
        'weight 1 must leave both curators weighted identically',
      )
    })

    it('counts every liker as early when the seed like time is unusable', async () => {
      const { graph } = await fixture()
      const scored = graph.score(
        VIEWER,
        [{ uri: SEED, likedAtMs: NaN }],
        rankingConfig({ lateLikerWeight: 0 }),
      )
      // A missing timestamp must not silently delete half the curator set.
      assert.ok(scored.has(earlyPick))
      assert.ok(scored.has(latePick))
    })
  })

  // In-graph popularity: two candidates with identical path structure, one of
  // which everybody has already liked.
  it('returns nothing for an unknown viewer', async () => {
    const { graph } = await build([like(CURATOR, SEED, 1)])
    const scored = graph.score('did:plc:stranger', seed(SEED, 1), rankingConfig())
    assert.equal(scored.size, 0)
  })
})
