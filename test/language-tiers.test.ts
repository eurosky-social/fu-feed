import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { handler } from '../src/algos/for-you'
import { FeedDef } from '../src/config'
import { ILikeGraph } from '../src/graph/types'
import { finalize } from '../src/ranker/finalize'
import { hoursAgo } from './helpers/config'
import { PostMetaRow, makeContext, makeFakeRedis } from './helpers/fake-db'

const VIEWER = 'did:plc:viewer'
const HUB = 'at://did:plc:picker/app.bsky.feed.post/hub'
const post = (author: string, rkey: string): string =>
  `at://did:plc:${author}/app.bsky.feed.post/${rkey}`

// A freshly hydrated video, so neither finalize nor the handler calls the
// AppView. Every post shares one createdAt, so time decay never reorders them.
const CREATED_AT = hoursAgo(1)
const video = (uri: string, langs: string): PostMetaRow => ({
  uri,
  author_did: uri.split('/')[2],
  created_at: CREATED_AT,
  like_count: 1,
  is_quote: 0,
  is_adult: 0,
  is_reply: 0,
  is_image: 0,
  is_video: 1,
  langs,
  hydrated_at: new Date().toISOString(),
})

// Raw scores in the order given, best first.
const scores = (uris: string[]): Map<string, number> =>
  new Map(uris.map((uri, rank) => [uri, 1000 - rank]))

const DE_1 = post('a', 'de1')
const DE_2 = post('b', 'de2')
const EN_1 = post('c', 'en1')
const EN_2 = post('d', 'en2')
const NONE = post('e', 'none')
const META = [
  video(DE_1, 'de'),
  video(DE_2, 'de,en'),
  video(EN_1, 'en'),
  video(EN_2, 'en'),
  video(NONE, ''),
]
// Interleaved, so tier order and score order disagree.
const BY_SCORE = [EN_1, DE_1, NONE, EN_2, DE_2]

const ranked = (
  opts: {
    tiers?: string[]
    cap?: number
    gap?: number
    meta?: PostMetaRow[]
    order?: string[]
  } = {},
) => {
  const { ctx } = makeContext({
    cachedMeta: opts.meta ?? META,
    ranking: { perAuthorCap: opts.cap ?? 10, authorMinGap: opts.gap ?? 0 },
  })
  return finalize(ctx, scores(opts.order ?? BY_SCORE), {
    applyPopularityPenalty: false,
    content: 'video',
    languageTiers: opts.tiers,
  })
}

describe('finalize — language tiers', () => {
  it('orders by score alone when no languages are given', async () => {
    assert.deepEqual(await ranked(), BY_SCORE)
  })

  it("puts posts in the viewer's languages first, each tier in score order", async () => {
    assert.deepEqual(await ranked({ tiers: ['de'] }), [
      DE_1,
      DE_2,
      EN_1,
      NONE,
      EN_2,
    ])
  })

  it('counts a post in any of its declared languages', async () => {
    // DE_2 declares de and en, so an English reader gets it in the first tier.
    assert.deepEqual(await ranked({ tiers: ['en'] }), [
      EN_1,
      EN_2,
      DE_2,
      DE_1,
      NONE,
    ])
  })

  it('puts posts that declare no language in the second tier', async () => {
    const out = await ranked({ tiers: ['de', 'fr'] })
    assert.ok(out.indexOf(NONE) > out.indexOf(DE_2))
  })

  it('never drops a post for its language', async () => {
    assert.deepEqual(
      new Set(await ranked({ tiers: ['fi'] })),
      new Set(BY_SCORE),
    )
  })

  it("spends an author's cap on their in-language posts first", async () => {
    const own = (rkey: string) => post('prolific', rkey)
    const meta = [
      video(own('en'), 'en'),
      video(own('de1'), 'de'),
      video(own('de2'), 'de'),
    ]
    // The English post scores highest, but the cap of two goes to the German ones.
    const out = await ranked({
      tiers: ['de'],
      cap: 2,
      meta,
      order: [own('en'), own('de1'), own('de2')],
    })
    assert.deepEqual(out, [own('de1'), own('de2')])
  })

  it('keeps authors spaced across the boundary between the tiers', async () => {
    const a1 = post('a', 'a1')
    const a2 = post('a', 'a2')
    const b1 = post('b', 'b1')
    const meta = [video(a1, 'de'), video(a2, 'en'), video(b1, 'en')]
    // a2 outscores b1, but author a closed the first tier one slot earlier.
    const out = await ranked({
      tiers: ['de'],
      gap: 1,
      meta,
      order: [a1, a2, b1],
    })
    assert.deepEqual(out, [a1, b1, a2])
  })
})

// --- served through the feed handler ---------------------------------------

const VIDS: FeedDef = { rkey: 'fu-vids', ranker: 'cf', content: 'video' }
const BY_LANGUAGE: FeedDef = {
  rkey: 'fu-vids-lang',
  ranker: 'cf',
  content: 'video',
  languageTiers: true,
}
const params = (feed: FeedDef, cursor?: string) => ({
  feed: `at://did:plc:pub/app.bsky.feed.generator/${feed.rkey}`,
  limit: 30,
  cursor,
})

const POPULAR_DE = post('p', 'popde')
const POPULAR_EN = post('q', 'popen')
const POPULAR = [
  { subject_uri: POPULAR_EN, likes: 90 },
  { subject_uri: POPULAR_DE, likes: 80 },
]

// Stands in for curator traversal: the candidates and raw scores it would find.
const fixedGraph = (uris: string[]): ILikeGraph => ({
  ready: true,
  applyCreate: () => {},
  buildFromPostgres: async () => true,
  score: () => scores(uris),
  stats: () => ({ ready: true, users: 0, posts: 0 }),
})

// Refuses every NX lock — how the like-history import reads "done recently" —
// so no test reaches for a PDS.
const importedRedis = () => {
  const redis = makeFakeRedis()
  return {
    ...redis,
    set: async (key: string, value: string, ...rest: unknown[]) =>
      rest.includes('NX') ? null : redis.set(key, value),
  }
}

const context = (minFeedSize = 0) =>
  makeContext({
    graph: fixedGraph(BY_SCORE),
    redis: importedRedis(),
    alreadyLiked: [HUB],
    popularRows: POPULAR,
    cachedMeta: [...META, video(POPULAR_DE, 'de'), video(POPULAR_EN, 'en')],
    ranking: { minFeedSize, perAuthorCap: 10, authorMinGap: 0 },
  })

const serve = async (
  feed: FeedDef,
  viewer: string | null,
  langs: string[],
  minFeedSize = 0,
) =>
  (await handler(context(minFeedSize).ctx, params(feed), viewer, feed, langs))
    .feed

describe('the language-ordered video feed', () => {
  it("serves the viewer's languages first and marks each post", async () => {
    const feed = await serve(BY_LANGUAGE, VIEWER, ['de'])
    assert.deepEqual(feed, [
      { post: DE_1, feedContext: 'fu-vids-lang;src=cf;lang=1' },
      { post: DE_2, feedContext: 'fu-vids-lang;src=cf;lang=1' },
      { post: EN_1, feedContext: 'fu-vids-lang;src=cf;lang=0' },
      { post: NONE, feedContext: 'fu-vids-lang;src=cf;lang=0' },
      { post: EN_2, feedContext: 'fu-vids-lang;src=cf;lang=0' },
    ])
  })

  it('leaves the language-blind video feed in score order, still marked', async () => {
    const feed = await serve(VIDS, VIEWER, ['de'])
    assert.deepEqual(
      feed.map((f) => f.post),
      BY_SCORE,
    )
    assert.deepEqual(
      feed.map((f) => f.feedContext),
      ['lang=0', 'lang=1', 'lang=0', 'lang=0', 'lang=1'].map(
        (l) => `fu-vids;src=cf;${l}`,
      ),
    )
  })

  it('orders by score and omits the language mark when the viewer sends none', async () => {
    const feed = await serve(BY_LANGUAGE, VIEWER, [])
    assert.deepEqual(
      feed.map((f) => f.post),
      BY_SCORE,
    )
    assert.ok(feed.every((f) => f.feedContext === 'fu-vids-lang;src=cf'))
  })

  it('marks the popular fill under a thin list as popular, ordered by language too', async () => {
    const feed = await serve(BY_LANGUAGE, VIEWER, ['de'], BY_SCORE.length + 2)
    assert.deepEqual(feed.slice(-2), [
      { post: POPULAR_DE, feedContext: 'fu-vids-lang;src=popular;lang=1' },
      { post: POPULAR_EN, feedContext: 'fu-vids-lang;src=popular;lang=0' },
    ])
  })

  it("ignores an anonymous request's languages: one cached list serves every anonymous viewer", async () => {
    const feed = await serve(BY_LANGUAGE, null, ['de'])
    assert.deepEqual(feed, [
      { post: POPULAR_EN, feedContext: 'fu-vids-lang;src=popular' },
      { post: POPULAR_DE, feedContext: 'fu-vids-lang;src=popular' },
    ])
  })

  it('keeps the marks on later pages, which are served from the cached list', async () => {
    const { ctx } = context()
    const first = await handler(
      ctx,
      { ...params(BY_LANGUAGE), limit: 2 },
      VIEWER,
      BY_LANGUAGE,
      ['de'],
    )
    const next = await handler(
      ctx,
      { ...params(BY_LANGUAGE, first.cursor), limit: 2 },
      VIEWER,
      BY_LANGUAGE,
      ['de'],
    )
    assert.deepEqual(next.feed, [
      { post: EN_1, feedContext: 'fu-vids-lang;src=cf;lang=0' },
      { post: NONE, feedContext: 'fu-vids-lang;src=cf;lang=0' },
    ])
  })
})
