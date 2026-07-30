import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { finalize } from '../src/ranker/finalize'
import { hoursAgo } from './helpers/config'
import {
  PostMetaRow,
  appviewPost,
  makeContext,
} from './helpers/fake-db'

const uriOf = (i: number) => `at://did:plc:author${i}/app.bsky.feed.post/p${i}`

// A cached post_meta row. `staleHours` back-dates hydrated_at so the row is
// outside the hydration TTL — which is the interesting case, because the media
// kind must still be usable for classification even when like_count is not.
const cachedRow = (
  i: number,
  kind: 'video' | 'image' | 'text',
  opts: { staleHours?: number; likeCount?: number } = {},
): PostMetaRow => ({
  uri: uriOf(i),
  author_did: `did:plc:author${i}`,
  created_at: hoursAgo(1),
  like_count: opts.likeCount ?? 1,
  is_quote: 0,
  is_adult: 0,
  is_reply: 0,
  is_image: kind === 'image' ? 1 : 0,
  is_video: kind === 'video' ? 1 : 0,
  langs: '',
  hydrated_at: hoursAgo(opts.staleHours ?? 24),
})

// Candidates in descending score order, as every ranker emits them.
const scores = (indices: number[]): Map<string, number> => {
  const m = new Map<string, number>()
  indices.forEach((i, rank) => m.set(uriOf(i), 1000 - rank))
  return m
}

describe('finalize — content-feed hydration narrowing', () => {
  it('only hydrates the candidates already known to match the media kind', async () => {
    // 1 video among 60 candidates — the production ratio is worse still.
    const cached: PostMetaRow[] = [cachedRow(0, 'video')]
    for (let i = 1; i < 60; i++) cached.push(cachedRow(i, 'text'))

    const { ctx, appviewUris } = makeContext({
      cachedMeta: cached,
      appviewPosts: [
        appviewPost(uriOf(0), { media: 'video', createdAt: hoursAgo(1), author: 'did:plc:author0' }),
      ],
    })

    const out = await finalize(ctx, scores([...Array(60).keys()]), {
      applyPopularityPenalty: true,
      content: 'video',
    })

    // Every row is stale, so anything we kept gets refetched — which makes the
    // AppView call list an exact readout of what we chose to hydrate.
    assert.deepEqual(appviewUris(), [uriOf(0)], 'only the known video should be fetched')
    assert.deepEqual(out, [uriOf(0)])
  })

  it('classifies from a stale cached row rather than dropping it', async () => {
    // The whole point: a row far outside the hydration TTL still tells us the
    // post is a video, because media kind is immutable.
    const { ctx, appviewUris } = makeContext({
      cachedMeta: [cachedRow(0, 'video', { staleHours: 24 * 30 }), cachedRow(1, 'text')],
      appviewPosts: [appviewPost(uriOf(0), { media: 'video', author: 'did:plc:author0' })],
    })

    const out = await finalize(ctx, scores([0, 1]), {
      applyPopularityPenalty: true,
      content: 'video',
    })

    assert.deepEqual(appviewUris(), [uriOf(0)])
    assert.deepEqual(out, [uriOf(0)], 'a month-old cache row must still classify')
  })

  it('hydrates unknown candidates so genuinely-new posts can still surface', async () => {
    // uri 1 has never been hydrated, so its media kind is unknowable locally.
    const { ctx, appviewUris } = makeContext({
      cachedMeta: [cachedRow(0, 'text')],
      appviewPosts: [appviewPost(uriOf(1), { media: 'video', author: 'did:plc:author1' })],
    })

    const out = await finalize(ctx, scores([0, 1]), {
      applyPopularityPenalty: true,
      content: 'video',
    })

    assert.deepEqual(appviewUris(), [uriOf(1)], 'the unknown is fetched, the known non-video is not')
    assert.deepEqual(out, [uriOf(1)])
  })

  it('caps unknown hydration at the budget, keeping the highest scorers', async () => {
    const { ctx, appviewUris } = makeContext({
      cachedMeta: [], // nothing known: all 10 candidates are unknown
      ranking: { mediaUnknownHydrationLimit: 3 },
    })

    await finalize(ctx, scores([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), {
      applyPopularityPenalty: true,
      content: 'video',
    })

    assert.deepEqual(
      appviewUris(),
      [uriOf(0), uriOf(1), uriOf(2)],
      'budget should keep the top-scoring unknowns and drop the rest',
    )
  })

  it('never fetches unknowns when the budget is zero', async () => {
    const { ctx, appviewUris } = makeContext({
      cachedMeta: [cachedRow(0, 'video')],
      appviewPosts: [appviewPost(uriOf(0), { media: 'video', author: 'did:plc:author0' })],
      ranking: { mediaUnknownHydrationLimit: 0 },
    })

    const out = await finalize(ctx, scores([0, 1, 2]), {
      applyPopularityPenalty: true,
      content: 'video',
    })

    assert.deepEqual(appviewUris(), [uriOf(0)], 'only the known video, no unknowns')
    assert.deepEqual(out, [uriOf(0)])
  })

  it('keeps images and videos separate', async () => {
    const { ctx } = makeContext({
      cachedMeta: [cachedRow(0, 'video'), cachedRow(1, 'image')],
      appviewPosts: [
        appviewPost(uriOf(0), { media: 'video', author: 'did:plc:author0' }),
        appviewPost(uriOf(1), { media: 'images', author: 'did:plc:author1' }),
      ],
    })

    const videos = await finalize(ctx, scores([0, 1]), {
      applyPopularityPenalty: true,
      content: 'video',
    })
    const images = await finalize(ctx, scores([0, 1]), {
      applyPopularityPenalty: true,
      content: 'image',
    })

    assert.deepEqual(videos, [uriOf(0)])
    assert.deepEqual(images, [uriOf(1)])
  })

  it('leaves the main feed hydrating every candidate', async () => {
    // content: 'all' must be untouched by the narrowing — no pre-filter, no cap.
    const { ctx, appviewUris } = makeContext({
      cachedMeta: [],
      appviewPosts: [0, 1, 2].map((i) =>
        appviewPost(uriOf(i), { author: `did:plc:author${i}` }),
      ),
      ranking: { mediaUnknownHydrationLimit: 0 },
    })

    const out = await finalize(ctx, scores([0, 1, 2]), {
      applyPopularityPenalty: true,
      content: 'all',
    })

    assert.deepEqual(appviewUris().sort(), [uriOf(0), uriOf(1), uriOf(2)].sort())
    assert.equal(out.length, 3)
  })
})
