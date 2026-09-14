import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { finalize } from '../src/ranker/finalize'
import { appviewPost, makeContext } from './helpers/fake-db'

const AUTHOR = 'did:plc:author'
const post = (rkey: string): string =>
  `at://${AUTHOR}/app.bsky.feed.post/${rkey}`

// The public AppView serves records that no longer validate against the lexicon
// bundled in this fork — an image alt longer than 1000 graphemes, for one, which
// is what surfaced this in production. @atproto/xrpc rejects the whole response
// on the first offending field, so one bad post used to cost all 25 in its chunk.
describe('hydration — AppView responses that fail lexicon validation', () => {
  const uris = ['a', 'b', 'c'].map(post)

  it('keeps the chunk by reading the body off the error', async () => {
    const { ctx } = makeContext({
      appviewInvalidResponse: true,
      appviewPosts: uris.map((uri) => appviewPost(uri, { author: AUTHOR })),
      ranking: { perAuthorCap: 10, authorMinGap: 0 },
    })

    const scores = new Map(uris.map((uri, i) => [uri, uris.length - i]))
    const out = await finalize(ctx, scores, {
      applyPopularityPenalty: false,
      content: 'all',
    })

    assert.deepEqual(out, uris, 'every post in the rejected chunk should survive')
  })

  it('drops the chunk when the error carries no usable body', async () => {
    const { ctx } = makeContext({
      appviewPosts: [],
      ranking: { perAuthorCap: 10, authorMinGap: 0 },
    })
    // No posts available and no error body to salvage — nothing to hydrate.
    const out = await finalize(ctx, new Map([[post('gone'), 1]]), {
      applyPopularityPenalty: false,
      content: 'all',
    })
    assert.deepEqual(out, [])
  })
})
