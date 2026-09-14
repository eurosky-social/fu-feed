import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CandidateOptions,
  RecentAuthorIndex,
  authorOf,
} from '../src/graph/recent-author-index'
import { followsConfig, hoursAgo } from './helpers/config'
import { LikeRow, likeRowsHandler, makeFakeDb } from './helpers/fake-db'

const ALICE = 'did:plc:alice'
const BOB = 'did:plc:bob'

const post = (author: string, rkey: string): string =>
  `at://${author}/app.bsky.feed.post/${rkey}`

// The index only reads subject_uri + indexed_at; liker identity is exactly what
// it does not keep, so the liker here is only there to make rows distinct.
const like = (
  liker: string,
  subject: string,
  indexedHoursAgo: number,
): LikeRow => ({
  uri: `at://${liker}/app.bsky.feed.like/${subject.split('/').pop()}`,
  liker_did: liker,
  subject_uri: subject,
  created_at: hoursAgo(indexedHoursAgo),
  indexed_at: hoursAgo(indexedHoursAgo),
})

const opts = (o: Partial<CandidateOptions> = {}): CandidateOptions => ({
  windowHours: 48,
  minEngagement: 1,
  maxPostsPerAuthor: 200,
  authorNormalization: 0,
  repostWeight: 2,
  includeReposts: false,
  maxRepostsPerReposter: 200,
  limit: 100,
  ...o,
})

type RepostRow = {
  uri: string
  reposter_did: string
  subject_uri: string
  created_at: string
  indexed_at: string
}

const repost = (
  reposter: string,
  subject: string,
  indexedHoursAgo: number,
): RepostRow => ({
  uri: `at://${reposter}/app.bsky.feed.repost/${subject.split('/').pop()}`,
  reposter_did: reposter,
  subject_uri: subject,
  created_at: hoursAgo(indexedHoursAgo),
  indexed_at: hoursAgo(indexedHoursAgo),
})

// Serves both engagement scans. `actor_did` is the alias the seed selects the
// reposter under, so the fixture has to carry it the way Postgres would.
const seedBoth = async (
  likes: LikeRow[],
  reposts: RepostRow[],
  cfg = followsConfig(),
) => {
  const index = new RecentAuthorIndex(cfg)
  let likePages = 0
  let repostPages = 0
  const { db, queries } = makeFakeDb((query) => {
    if (query.sql.includes('from "reposts"')) {
      return repostPages++ === 0
        ? reposts.map((r) => ({ ...r, actor_did: r.reposter_did }))
        : []
    }
    if (query.sql.includes('from "likes"')) return likePages++ === 0 ? likes : []
    return []
  })
  assert.equal(await index.seedFromPostgres(db), true, 'seed should succeed')
  return { index, queries }
}

const seed = async (rows: LikeRow[], cfg = followsConfig()) => {
  const index = new RecentAuthorIndex(cfg)
  const { db, queries } = makeFakeDb(likeRowsHandler(rows))
  const ok = await index.seedFromPostgres(db)
  assert.equal(ok, true, 'seed should succeed')
  return { index, queries }
}

describe('RecentAuthorIndex.seedFromPostgres', () => {
  it('bounds the scan above so it cannot chase live ingestion', async () => {
    const { queries } = await seed([like(BOB, post(ALICE, 'a1'), 1)])
    const scan = queries.find((q) => q.sql.includes('from "likes"'))
    assert.ok(scan, 'should scan the likes table')
    assert.match(scan.sql, /"indexed_at" > \$/)
    assert.match(scan.sql, /"indexed_at" <= \$/)
  })

  it('groups posts under their author and counts the likes on each', async () => {
    const { index } = await seed([
      like('did:plc:l1', post(ALICE, 'a1'), 3),
      like('did:plc:l2', post(ALICE, 'a1'), 2),
      like('did:plc:l3', post(ALICE, 'a1'), 1),
      like('did:plc:l1', post(ALICE, 'a2'), 1),
      like('did:plc:l2', post(BOB, 'b1'), 1),
    ])

    assert.deepEqual(
      [...index.candidates([ALICE], opts())],
      [
        [post(ALICE, 'a1'), 3],
        [post(ALICE, 'a2'), 1],
      ],
    )
    assert.deepEqual(
      [...index.candidates([BOB], opts())].map(([uri]) => uri),
      [post(BOB, 'b1')],
    )
  })

  it('breaks ties on engagement by recency', async () => {
    const { index } = await seed([
      like('did:plc:l1', post(ALICE, 'old'), 5),
      like('did:plc:l2', post(ALICE, 'new'), 1),
    ])
    assert.deepEqual(
      [...index.candidates([ALICE], opts())].map(([uri]) => uri),
      [post(ALICE, 'new'), post(ALICE, 'old')],
    )
  })

  it('excludes posts whose first like falls outside the window', async () => {
    const { index } = await seed([
      like('did:plc:l1', post(ALICE, 'stale'), 60),
      like('did:plc:l2', post(ALICE, 'fresh'), 1),
    ])
    assert.deepEqual(
      [...index.candidates([ALICE], opts({ windowHours: 48 }))].map(
        ([uri]) => uri,
      ),
      [post(ALICE, 'fresh')],
    )
  })

  it('ignores subjects that are not post at-URIs', async () => {
    const { index } = await seed([
      {
        ...like('did:plc:l1', post(ALICE, 'a1'), 1),
        subject_uri: `at://${ALICE}/app.bsky.feed.generator/somefeed`,
      },
    ])
    assert.equal(index.stats().posts, 0)
  })

  it('replays likes that arrived while the scan was running', async () => {
    const index = new RecentAuthorIndex(followsConfig())
    const rows = [
      like('did:plc:l1', post(ALICE, 'a1'), 1),
      like('did:plc:l2', post(ALICE, 'a1'), 1),
    ]
    const pages = likeRowsHandler(rows)
    let fired = false
    const { db } = makeFakeDb((query) => {
      // Stand in for the firehose delivering likes mid-scan: the index is not
      // ready yet, so these have to be buffered and replayed onto the new store.
      if (!fired && query.sql.includes('from "likes"')) {
        fired = true
        index.applyLike(post(ALICE, 'live'), Date.now())
        index.applyLike(post(ALICE, 'a1'), Date.now())
        index.applyUnlike(post(ALICE, 'a1'))
      }
      return pages(query)
    })

    assert.equal(await index.seedFromPostgres(db), true)
    assert.equal(fired, true, 'the live likes should have raced the scan')
    assert.deepEqual(
      [...index.candidates([ALICE], opts())],
      [
        [post(ALICE, 'a1'), 2], // 2 scanned, +1 live, -1 unlike
        [post(ALICE, 'live'), 1],
      ],
    )
  })

  it('serves nothing until it has been seeded', () => {
    const index = new RecentAuthorIndex(followsConfig())
    assert.equal(index.ready, false)
    assert.equal(index.candidates([ALICE], opts()).size, 0)
  })
})

describe('RecentAuthorIndex live updates', () => {
  it('counts a like observed on the firehose', async () => {
    const { index } = await seed([like('did:plc:l1', post(ALICE, 'a1'), 1)])
    index.applyLike(post(ALICE, 'a1'), Date.now())
    index.applyLike(post(ALICE, 'a2'), Date.now())

    assert.deepEqual(
      [...index.candidates([ALICE], opts())],
      [
        [post(ALICE, 'a1'), 2],
        [post(ALICE, 'a2'), 1],
      ],
    )
  })

  it('gives the count back on an unlike', async () => {
    const { index } = await seed([
      like('did:plc:l1', post(ALICE, 'a1'), 1),
      like('did:plc:l2', post(ALICE, 'a1'), 1),
    ])
    index.applyUnlike(post(ALICE, 'a1'))
    assert.deepEqual(
      [...index.candidates([ALICE], opts())],
      [[post(ALICE, 'a1'), 1]],
    )
  })

  it('never takes a count below zero, or invents a post', async () => {
    const { index } = await seed([like('did:plc:l1', post(ALICE, 'a1'), 1)])
    index.applyUnlike(post(ALICE, 'a1'))
    index.applyUnlike(post(ALICE, 'a1'))
    index.applyUnlike(post(BOB, 'never-seen'))
    assert.equal(index.stats().posts, 1)
    assert.equal(index.candidates([ALICE], opts({ minEngagement: 1 })).size, 0)
  })
})

describe('RecentAuthorIndex.compact', () => {
  it('reclaims aged-out posts and keeps the survivors intact', async () => {
    const { index } = await seed([
      like('did:plc:l1', post(ALICE, 'stale'), 60),
      like('did:plc:l2', post(ALICE, 'fresh'), 1),
      like('did:plc:l3', post(ALICE, 'fresh'), 1),
    ])
    assert.equal(index.stats().posts, 2)

    index.compact()

    assert.equal(index.stats().posts, 1, 'the stale post should be reclaimed')
    assert.deepEqual(
      [...index.candidates([ALICE], opts())],
      [[post(ALICE, 'fresh'), 2]],
    )
  })

  it('keeps each author ordered newest-first across a compaction', async () => {
    const { index } = await seed([
      like('did:plc:l1', post(ALICE, 'older'), 5),
      like('did:plc:l2', post(ALICE, 'newer'), 1),
    ])
    index.compact()
    assert.deepEqual(
      [...index.candidates([ALICE], opts({ maxPostsPerAuthor: 1 }))].map(
        ([uri]) => uri,
      ),
      [post(ALICE, 'newer')],
    )
  })
})

describe('RecentAuthorIndex.candidates', () => {
  const prolific = [5, 4, 3, 2, 1].map((h) =>
    like('did:plc:l1', post(ALICE, `a${h}`), h),
  )

  it('caps the per-author scan, keeping their newest posts', async () => {
    const { index } = await seed(prolific)
    assert.deepEqual(
      [...index.candidates([ALICE], opts({ maxPostsPerAuthor: 2 }))].map(
        ([uri]) => uri,
      ),
      [post(ALICE, 'a1'), post(ALICE, 'a2')],
    )
  })

  it('caps the returned candidates at the limit', async () => {
    const { index } = await seed(prolific)
    assert.equal(index.candidates([ALICE], opts({ limit: 3 })).size, 3)
  })

  it('drops posts under the corroboration floor', async () => {
    const { index } = await seed([
      like('did:plc:l1', post(ALICE, 'once'), 1),
      like('did:plc:l1', post(ALICE, 'twice'), 1),
      like('did:plc:l2', post(ALICE, 'twice'), 1),
    ])
    assert.deepEqual(
      [...index.candidates([ALICE], opts({ minEngagement: 2 }))].map(([uri]) => uri),
      [post(ALICE, 'twice')],
    )
  })

  it('lets a smaller account compete once normalization is on', async () => {
    const rows = [
      ...Array.from({ length: 100 }, (_, i) =>
        like(`did:plc:l${i}`, post(ALICE, 'hit'), 2),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        like(`did:plc:m${i}`, post(ALICE, 'routine'), 2),
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        like(`did:plc:n${i}`, post(BOB, 'standout'), 2),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        like(`did:plc:o${i}`, post(BOB, 'quiet'), 2),
      ),
    ]

    const { index } = await seed(rows)
    const raw = [...index.candidates([ALICE, BOB], opts())].map(([uri]) => uri)
    assert.deepEqual(
      raw,
      [
        post(ALICE, 'hit'),
        post(ALICE, 'routine'),
        post(BOB, 'standout'),
        post(BOB, 'quiet'),
      ],
      'raw engagement puts the bigger account on top',
    )

    const normalized = [
      ...index.candidates([ALICE, BOB], opts({ authorNormalization: 1 })),
    ].map(([uri]) => uri)
    assert.deepEqual(
      normalized,
      [
        post(ALICE, 'hit'),
        post(BOB, 'standout'),
        post(BOB, 'quiet'),
        post(ALICE, 'routine'),
      ],
      "the smaller account's standout post climbs past the routine one",
    )
  })

  it('ignores authors it has never seen', async () => {
    const { index } = await seed([like('did:plc:l1', post(ALICE, 'a1'), 1)])
    assert.equal(index.candidates(['did:plc:nobody'], opts()).size, 0)
  })
})

describe('authorOf', () => {
  it('reads the author DID out of a post at-URI', () => {
    assert.equal(authorOf(post(ALICE, 'abc')), ALICE)
  })

  it('rejects anything that is not a post at-URI', () => {
    assert.equal(authorOf(`at://${ALICE}/app.bsky.feed.like/abc`), '')
    assert.equal(authorOf(`at://${ALICE}`), '')
    assert.equal(authorOf('https://example.com/x'), '')
    assert.equal(authorOf(''), '')
  })
})

describe('RecentAuthorIndex reposts', () => {
  const REPOSTER = 'did:plc:reposter'
  const STRANGER = 'did:plc:stranger'

  it('weighs a repost more heavily than a like', async () => {
    const { index } = await seedBoth(
      [
        like('did:plc:l1', post(ALICE, 'liked-twice'), 1),
        like('did:plc:l2', post(ALICE, 'liked-twice'), 1),
        like('did:plc:l3', post(ALICE, 'reposted'), 1),
      ],
      [repost(REPOSTER, post(ALICE, 'reposted'), 1)],
    )

    // 1 like + 1 repost at weight 2 = 3, ahead of two plain likes.
    assert.deepEqual(
      [...index.candidates([ALICE], opts({ repostWeight: 2 }))],
      [
        [post(ALICE, 'reposted'), 3],
        [post(ALICE, 'liked-twice'), 2],
      ],
    )
  })

  it('does not even read the repost table at weight zero', async () => {
    const { index, queries } = await seedBoth(
      [like('did:plc:l1', post(ALICE, 'a1'), 1)],
      [repost(REPOSTER, post(ALICE, 'a1'), 1)],
      followsConfig({ repostWeight: 0 }),
    )
    assert.equal(
      queries.some((q) => q.sql.includes('from "reposts"')),
      false,
    )
    assert.deepEqual(
      [...index.candidates([ALICE], opts({ repostWeight: 0 }))],
      [[post(ALICE, 'a1'), 1]],
    )
  })

  it('counts a repost observed on the firehose, and gives it back', async () => {
    const { index } = await seed([like('did:plc:l1', post(ALICE, 'a1'), 1)])
    index.applyRepost(REPOSTER, post(ALICE, 'a1'), Date.now())
    assert.deepEqual(
      [...index.candidates([ALICE], opts())],
      [[post(ALICE, 'a1'), 3]],
    )

    index.applyUnrepost(REPOSTER, post(ALICE, 'a1'))
    assert.deepEqual(
      [...index.candidates([ALICE], opts())],
      [[post(ALICE, 'a1'), 1]],
    )
  })

  it("surfaces a stranger's post that a followed account reposted", async () => {
    const cfg = followsConfig({ includeReposts: true })
    const { index } = await seedBoth(
      [like('did:plc:l1', post(STRANGER, 'amplified'), 1)],
      [repost(REPOSTER, post(STRANGER, 'amplified'), 1)],
      cfg,
    )

    assert.deepEqual(
      [...index.candidates([REPOSTER], opts({ includeReposts: true }))].map(
        ([uri]) => uri,
      ),
      [post(STRANGER, 'amplified')],
    )
    assert.equal(
      index.candidates([REPOSTER], opts({ includeReposts: false })).size,
      0,
      'without the opt-in the reposter contributes no content',
    )
  })

  it('stops surfacing a repost once it is retracted', async () => {
    const cfg = followsConfig({ includeReposts: true })
    const { index } = await seedBoth(
      [like('did:plc:l1', post(STRANGER, 'amplified'), 1)],
      [repost(REPOSTER, post(STRANGER, 'amplified'), 1)],
      cfg,
    )
    index.applyUnrepost(REPOSTER, post(STRANGER, 'amplified'))

    assert.equal(
      index.candidates([REPOSTER], opts({ includeReposts: true })).size,
      0,
    )
  })

  it('carries live repost edges through a compaction', async () => {
    const index = new RecentAuthorIndex(followsConfig({ includeReposts: true }))
    const { db } = makeFakeDb(likeRowsHandler([]))
    assert.equal(await index.seedFromPostgres(db), true)

    index.applyLike(post(STRANGER, 'amplified'), Date.now())
    index.applyRepost(REPOSTER, post(STRANGER, 'amplified'), Date.now())
    assert.equal(index.stats().reposts, 1)

    index.compact()

    assert.equal(index.stats().reposts, 1, 'the edge should survive')
    assert.deepEqual(
      [...index.candidates([REPOSTER], opts({ includeReposts: true }))].map(
        ([uri]) => uri,
      ),
      [post(STRANGER, 'amplified')],
    )
  })

  it('drops repost edges whose post has aged out', async () => {
    const cfg = followsConfig({ includeReposts: true })
    const { index } = await seedBoth(
      [like('did:plc:l1', post(STRANGER, 'stale'), 60)],
      [repost(REPOSTER, post(STRANGER, 'stale'), 60)],
      cfg,
    )
    assert.equal(index.stats().reposts, 1)

    index.compact()

    assert.equal(index.stats().reposts, 0)
    assert.equal(index.stats().posts, 0)
  })
})
