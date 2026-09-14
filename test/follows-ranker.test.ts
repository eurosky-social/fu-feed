import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RecentAuthorIndex } from '../src/graph/recent-author-index'
import { FollowsRanker } from '../src/ranker/follows'
import { followsConfig, hoursAgo } from './helpers/config'
import {
  LikeRow,
  appviewPost,
  likeRowsHandler,
  makeContext,
  makeFakeDb,
} from './helpers/fake-db'
import { encodeEntry } from '../src/algos/feed-entry'

const VIEWER = 'did:plc:viewer'
const ALICE = 'did:plc:alice'
const BOB = 'did:plc:bob'

const post = (author: string, rkey: string): string =>
  `at://${author}/app.bsky.feed.post/${rkey}`

const like = (subject: string, n: number): LikeRow[] =>
  Array.from({ length: n }, (_, i) => ({
    uri: `at://did:plc:l${i}/app.bsky.feed.like/${subject.split('/').pop()}`,
    liker_did: `did:plc:l${i}`,
    subject_uri: subject,
    created_at: hoursAgo(1),
    indexed_at: hoursAgo(1),
  }))

const seedIndex = async (rows: LikeRow[]): Promise<RecentAuthorIndex> => {
  const index = new RecentAuthorIndex(followsConfig())
  const { db } = makeFakeDb(likeRowsHandler(rows))
  assert.equal(await index.seedFromPostgres(db), true, 'seed should succeed')
  return index
}

// Seeds an index that also carries repost edges, the way the reposts ingester
// would fill it.
const seedWithRepost = async (
  subject: string,
  reposter: string,
): Promise<RecentAuthorIndex> => {
  const index = new RecentAuthorIndex(followsConfig({ includeReposts: true }))
  const { db } = makeFakeDb(likeRowsHandler([]))
  assert.equal(await index.seedFromPostgres(db), true)
  index.applyLike(subject, Date.now())
  index.applyRepost(reposter, subject, Date.now())
  return index
}

const ranker = new FollowsRanker()

describe('FollowsRanker', () => {
  it('ranks the posts of accounts the viewer follows by engagement', async () => {
    const index = await seedIndex([
      ...like(post(ALICE, 'big'), 5),
      ...like(post(ALICE, 'small'), 2),
    ])
    const { ctx } = makeContext({
      authorIndex: index,
      followedDids: [ALICE],
      appviewPosts: [
        appviewPost(post(ALICE, 'big'), { author: ALICE }),
        appviewPost(post(ALICE, 'small'), { author: ALICE }),
      ],
    })

    assert.deepEqual(await ranker.rank(ctx, VIEWER, 'all'), [
      post(ALICE, 'big'),
      post(ALICE, 'small'),
    ])
  })

  it('never surfaces an account the viewer does not follow', async () => {
    const index = await seedIndex([
      ...like(post(BOB, 'viral'), 50),
      ...like(post(ALICE, 'quiet'), 1),
    ])
    const { ctx } = makeContext({
      authorIndex: index,
      followedDids: [ALICE],
      appviewPosts: [
        appviewPost(post(BOB, 'viral'), { author: BOB }),
        appviewPost(post(ALICE, 'quiet'), { author: ALICE }),
      ],
    })

    assert.deepEqual(await ranker.rank(ctx, VIEWER, 'all'), [
      post(ALICE, 'quiet'),
    ])
  })

  it('drops posts the viewer has already liked', async () => {
    const index = await seedIndex([
      ...like(post(ALICE, 'seen'), 5),
      ...like(post(ALICE, 'unseen'), 2),
    ])
    const { ctx } = makeContext({
      authorIndex: index,
      followedDids: [ALICE],
      alreadyLiked: [post(ALICE, 'seen')],
      appviewPosts: [
        appviewPost(post(ALICE, 'seen'), { author: ALICE }),
        appviewPost(post(ALICE, 'unseen'), { author: ALICE }),
      ],
    })

    assert.deepEqual(await ranker.rank(ctx, VIEWER, 'all'), [
      post(ALICE, 'unseen'),
    ])
  })

  it('lets popular posts win — the popularity penalty is off here', async () => {
    // With the CF ranker's penalty applied, `routine` (1 global like) would beat
    // `hit` (10k). This feed is meant to bubble the most-engaged posts up.
    const index = await seedIndex([
      ...like(post(ALICE, 'hit'), 5),
      ...like(post(ALICE, 'routine'), 4),
    ])
    const { ctx } = makeContext({
      authorIndex: index,
      followedDids: [ALICE],
      appviewPosts: [
        appviewPost(post(ALICE, 'hit'), { author: ALICE, likeCount: 10000 }),
        appviewPost(post(ALICE, 'routine'), { author: ALICE, likeCount: 1 }),
      ],
    })

    assert.deepEqual(await ranker.rank(ctx, VIEWER, 'all'), [
      post(ALICE, 'hit'),
      post(ALICE, 'routine'),
    ])
  })

  it('keeps replies out by default, and admits them when the feed opts in', async () => {
    const index = await seedIndex([
      ...like(post(ALICE, 'top'), 5),
      ...like(post(ALICE, 'reply'), 4),
    ])
    const appviewPosts = [
      appviewPost(post(ALICE, 'top'), { author: ALICE }),
      appviewPost(post(ALICE, 'reply'), { author: ALICE, reply: true }),
    ]

    const { ctx } = makeContext({
      authorIndex: index,
      followedDids: [ALICE],
      appviewPosts,
    })
    assert.deepEqual(await ranker.rank(ctx, VIEWER, 'all'), [
      post(ALICE, 'top'),
    ])

    const withReplies = makeContext({
      authorIndex: index,
      followedDids: [ALICE],
      appviewPosts,
      follows: { includeReplies: true },
    })
    assert.deepEqual(await ranker.rank(withReplies.ctx, VIEWER, 'all'), [
      post(ALICE, 'top'),
      post(ALICE, 'reply'),
    ])
  })

  it('defers to the cold-start feed when the viewer follows nobody', async () => {
    const index = await seedIndex(like(post(ALICE, 'a1'), 5))
    const { ctx } = makeContext({ authorIndex: index, followedDids: [] })
    assert.deepEqual(await ranker.rank(ctx, VIEWER, 'all'), [])
  })

  it('defers to the cold-start feed while the index is still seeding', async () => {
    const { ctx } = makeContext({
      authorIndex: new RecentAuthorIndex(followsConfig()),
      followedDids: [ALICE],
    })
    assert.deepEqual(await ranker.rank(ctx, VIEWER, 'all'), [])
  })

  it('defers to the cold-start feed for an anonymous viewer', async () => {
    const index = await seedIndex(like(post(ALICE, 'a1'), 5))
    const { ctx } = makeContext({ authorIndex: index, followedDids: [ALICE] })
    assert.deepEqual(await ranker.rank(ctx, null, 'all'), [])
  })
})

describe('FollowsRanker — reposts', () => {
  const STRANGER = 'did:plc:stranger'
  const amplified = post(STRANGER, 'amplified')

  const repostRecord = {
    uri: `at://${ALICE}/app.bsky.feed.repost/abc`,
    reposter_did: ALICE,
    subject_uri: amplified,
  }

  it("surfaces a stranger's post amplified by a follow, with attribution", async () => {
    const index = await seedWithRepost(amplified, ALICE)
    const { ctx } = makeContext({
      authorIndex: index,
      followedDids: [ALICE],
      follows: { includeReposts: true },
      appviewPosts: [appviewPost(amplified, { author: STRANGER })],
      repostRecords: [repostRecord],
    })

    // The entry carries the repost record, so the skeleton can tell clients who
    // amplified it rather than presenting a stranger with no explanation.
    assert.deepEqual(await ranker.rank(ctx, VIEWER, 'all'), [
      encodeEntry(amplified, repostRecord.uri),
    ])
  })

  it('drops an amplified post it cannot attribute', async () => {
    const index = await seedWithRepost(amplified, ALICE)
    const { ctx } = makeContext({
      authorIndex: index,
      followedDids: [ALICE],
      follows: { includeReposts: true },
      appviewPosts: [appviewPost(amplified, { author: STRANGER })],
      repostRecords: [], // the repost row was swept between ingest and now
    })

    assert.deepEqual(await ranker.rank(ctx, VIEWER, 'all'), [])
  })

  it("leaves a follow's own post unattributed even when another follow reposted it", async () => {
    const own = post(ALICE, 'mine')
    const index = await seedWithRepost(own, BOB)
    const { ctx } = makeContext({
      authorIndex: index,
      followedDids: [ALICE, BOB],
      follows: { includeReposts: true },
      appviewPosts: [appviewPost(own, { author: ALICE })],
      repostRecords: [
        { uri: `at://${BOB}/app.bsky.feed.repost/x`, reposter_did: BOB, subject_uri: own },
      ],
    })

    // ALICE wrote it, so it needs no "reposted by" line.
    assert.deepEqual(await ranker.rank(ctx, VIEWER, 'all'), [own])
  })

  it('leaves it out entirely when the feed opts out of reposts as content', async () => {
    const index = await seedWithRepost(amplified, ALICE)
    const { ctx } = makeContext({
      authorIndex: index,
      followedDids: [ALICE],
      follows: { includeReposts: false },
      appviewPosts: [appviewPost(amplified, { author: STRANGER })],
      repostRecords: [repostRecord],
    })

    assert.deepEqual(await ranker.rank(ctx, VIEWER, 'all'), [])
  })
})
