import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { handler } from '../src/algos/for-you'
import { FeedDef } from '../src/config'
import { RecentAuthorIndex } from '../src/graph/recent-author-index'
import { ILikeGraph } from '../src/graph/types'
import { followsConfig, hoursAgo } from './helpers/config'
import {
  appviewPost,
  likeRowsHandler,
  makeContext,
  makeFakeDb,
  makeFakeRedis,
} from './helpers/fake-db'

const VIEWER = 'did:plc:viewer'
const HUB = 'at://did:plc:picker/app.bsky.feed.post/science'
const post = (author: string, rkey: string): string =>
  `at://did:plc:${author}/app.bsky.feed.post/${rkey}`

const MINE = post('m', 'mine')
const MINE_2 = post('m2', 'mine2')
const MINE_3 = post('m3', 'mine3')
const POP_A = post('a', 'a')
const POP_B = post('b', 'b')
const POP_C = post('c', 'c')

const CF: FeedDef = { rkey: 'fu', ranker: 'cf', content: 'all' }
const PARAMS = { feed: 'at://did:plc:pub/app.bsky.feed.generator/fu', limit: 30 }

// The popularity ranker caches its candidate set per content filter for the
// life of the process, so every test in this file sees the same popular posts.
// MINE is among them, to show the fill never repeats a personalized post.
const POPULAR = [
  { subject_uri: MINE, likes: 50 },
  { subject_uri: POP_A, likes: 40 },
  { subject_uri: POP_B, likes: 30 },
  { subject_uri: POP_C, likes: 20 },
]
const CREATED_AT = new Date().toISOString()
const POSTS = [MINE, MINE_2, MINE_3, POP_A, POP_B, POP_C].map((uri) =>
  appviewPost(uri, { author: uri.split('/')[2], createdAt: CREATED_AT }),
)

// Stands in for curator traversal: the candidates and raw scores it would find.
const fixedGraph = (scores: Record<string, number>): ILikeGraph => ({
  ready: true,
  applyCreate: () => {},
  buildFromPostgres: async () => true,
  score: () => new Map(Object.entries(scores)),
  stats: () => ({ ready: true, users: 0, posts: 0 }),
})

// Refuses every NX lock — how the like-history and follow-list imports read
// "done recently" — so no test reaches for a PDS.
const importedRedis = () => {
  const redis = makeFakeRedis()
  return {
    ...redis,
    set: async (key: string, value: string, ...rest: unknown[]) =>
      rest.includes('NX') ? null : redis.set(key, value),
  }
}

// The viewer has liked one interest post and nothing else.
const context = (graph: ILikeGraph, minFeedSize: number) =>
  makeContext({
    graph,
    redis: importedRedis(),
    alreadyLiked: [HUB],
    popularRows: POPULAR,
    appviewPosts: POSTS,
    ranking: { minFeedSize, perAuthorCap: 10, authorMinGap: 0 },
  })

const served = async (...args: Parameters<typeof handler>) =>
  (await handler(...args)).feed.map((f) => f.post)

describe('filling a thin personalized feed', () => {
  it('puts the personalized posts first and fills up to the floor', async () => {
    const { ctx } = context(fixedGraph({ [MINE]: 1 }), 3)
    assert.deepEqual(await served(ctx, PARAMS, VIEWER, CF, []), [
      MINE,
      POP_A,
      POP_B,
    ])
  })

  it('leaves a list that already meets the floor alone', async () => {
    const { ctx } = context(fixedGraph({ [MINE]: 3, [MINE_2]: 2, [MINE_3]: 1 }), 3)
    assert.deepEqual(await served(ctx, PARAMS, VIEWER, CF, []), [
      MINE,
      MINE_2,
      MINE_3,
    ])
  })

  it('does not fill when the floor is 0', async () => {
    const { ctx } = context(fixedGraph({ [MINE]: 1 }), 0)
    assert.deepEqual(await served(ctx, PARAMS, VIEWER, CF, []), [MINE])
  })

  it('never fills the follows feed with strangers', async () => {
    const alice = post('alice', 'hello')
    const index = new RecentAuthorIndex(followsConfig())
    const { db } = makeFakeDb(
      likeRowsHandler([
        {
          uri: 'at://did:plc:fan/app.bsky.feed.like/1',
          liker_did: 'did:plc:fan',
          subject_uri: alice,
          created_at: hoursAgo(1),
          indexed_at: hoursAgo(1),
        },
      ]),
    )
    assert.equal(await index.seedFromPostgres(db), true)
    const { ctx } = makeContext({
      authorIndex: index,
      followedDids: ['did:plc:alice'],
      redis: importedRedis(),
      popularRows: POPULAR,
      appviewPosts: [...POSTS, appviewPost(alice, { author: 'did:plc:alice' })],
      ranking: { minFeedSize: 3, perAuthorCap: 10, authorMinGap: 0 },
    })
    const follows: FeedDef = { rkey: 'fu-follows', ranker: 'follows', content: 'all' }
    assert.deepEqual(await served(ctx, PARAMS, VIEWER, follows, []), [alice])
  })

  it('keeps the personalized posts when the fill fails', async () => {
    // Video, so the popularity set is not already cached by an earlier test
    // and the failing query below is actually issued.
    const clip = post('v', 'clip')
    const { ctx } = makeContext({
      graph: fixedGraph({ [clip]: 1 }),
      redis: importedRedis(),
      appviewPosts: [appviewPost(clip, { author: 'did:plc:v', media: 'video' })],
      ranking: { minFeedSize: 3, perAuthorCap: 10, authorMinGap: 0 },
    })
    ctx.db = makeFakeDb((q) => {
      if (/group by/i.test(q.sql)) throw new Error('popularity query failed')
      if (q.sql.includes('from "likes"')) return [{ subject_uri: HUB }]
      return []
    }).db
    const vids: FeedDef = { rkey: 'fu-vids', ranker: 'cf', content: 'video' }
    assert.deepEqual(await served(ctx, PARAMS, VIEWER, vids, []), [clip])
  })
})
