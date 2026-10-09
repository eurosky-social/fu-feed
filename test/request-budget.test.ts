import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FEED_PREPARING_MESSAGE, handler } from '../src/algos/for-you'
import { FeedDef } from '../src/config'
import { appviewPost, makeContext, makeFakeRedis } from './helpers/fake-db'

const AUTHOR = 'did:plc:author'
const uri = (rkey: string): string =>
  `at://${AUTHOR}/app.bsky.feed.post/${rkey}`

const FEED: FeedDef = { rkey: 'fu-follows', ranker: 'follows', content: 'all' }
const PARAMS = { feed: `at://did:plc:pub/app.bsky.feed.generator/fu-follows`, limit: 30 }

// Distinct like counts and one shared createdAt, so the expected order comes
// from the scores rather than from sub-millisecond differences in post age.
const CREATED_AT = new Date().toISOString()
const popular = [
  { subject_uri: uri('a'), likes: 10 },
  { subject_uri: uri('b'), likes: 5 },
]
const posts = ['a', 'b'].map((r) =>
  appviewPost(uri(r), { author: AUTHOR, createdAt: CREATED_AT }),
)

// Anonymous viewer: no follow list to import, so the whole cache-miss cost is
// the cold-start ranking plus hydration — which is what the budget bounds.
describe('request budget', () => {
  it('serves the computed list when it lands inside the budget', async () => {
    const redis = makeFakeRedis()
    const { ctx } = makeContext({
      redis,
      popularRows: popular,
      appviewPosts: posts,
      ranking: { requestBudgetMs: 5000, perAuthorCap: 10, authorMinGap: 0 },
    })

    const res = await handler(ctx, PARAMS, null, FEED, [])
    assert.deepEqual(
      res.feed.map((f) => f.post),
      [uri('a'), uri('b')],
    )
    assert.equal(redis.store.size, 1, 'the list should have been cached')
  })

  it('asks the client to retry rather than letting the AppView time out', async () => {
    const redis = makeFakeRedis()
    const { ctx } = makeContext({
      redis,
      popularRows: popular,
      appviewPosts: posts,
      appviewDelayMs: 150,
      ranking: { requestBudgetMs: 20, perAuthorCap: 10, authorMinGap: 0 },
    })

    const err = await handler(ctx, PARAMS, null, FEED, []).then(
      () => null,
      (e) => e,
    )
    assert.ok(err, 'the handler should have thrown')
    // 429 is the one status the client renders without blaming the feed owner;
    // our message prints underneath it.
    assert.equal(err.type, 429)
    assert.equal(err.payload.message, FEED_PREPARING_MESSAGE)
    assert.equal(err.payload.error, 'FeedPreparing')
  })

  it('counts time spent before the handler against the budget', async () => {
    const redis = makeFakeRedis()
    const { ctx } = makeContext({
      redis,
      popularRows: popular,
      appviewPosts: posts,
      appviewDelayMs: 150,
      ranking: { requestBudgetMs: 5000, perAuthorCap: 10, authorMinGap: 0 },
    })

    // Token verification already spent the whole budget, so this must answer
    // at once rather than wait another five seconds the AppView won't give.
    const started = Date.now()
    const err = await handler(
      ctx,
      PARAMS,
      null,
      FEED,
      [],
      started - 5000,
    ).then(
      () => null,
      (e) => e,
    )
    assert.ok(err, 'the handler should have thrown')
    assert.equal(err.payload.error, 'FeedPreparing')
    assert.ok(Date.now() - started < 1000, 'it should not have waited out a fresh budget')
  })

  it('keeps computing after it gives up waiting, so the next pull is warm', async () => {
    const redis = makeFakeRedis()
    const { ctx } = makeContext({
      redis,
      popularRows: popular,
      appviewPosts: posts,
      appviewDelayMs: 100,
      ranking: { requestBudgetMs: 20, perAuthorCap: 10, authorMinGap: 0 },
    })

    await handler(ctx, PARAMS, null, FEED, []).catch(() => {})
    assert.equal(redis.store.size, 0, 'nothing cached yet when we gave up')

    // The abandoned computation is still running; that is what makes telling
    // the viewer to pull again honest.
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(redis.store.size, 1, 'the detached computation cached its list')

    const res = await handler(ctx, PARAMS, null, FEED, [])
    assert.deepEqual(
      res.feed.map((f) => f.post),
      [uri('a'), uri('b')],
    )
  })
})
