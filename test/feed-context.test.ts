import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { feedContext, isFeedContext } from '../src/algos/feed-context'

describe('feed contexts', () => {
  it('names the feed and the source, and the language match when known', () => {
    assert.equal(feedContext('fu-vids', 'cf'), 'fu-vids;src=cf')
    assert.equal(feedContext('fu-vids', 'cf', true), 'fu-vids;src=cf;lang=1')
    assert.equal(feedContext('fu', 'popular', false), 'fu;src=popular;lang=0')
  })

  it('accepts every context the service issues', () => {
    for (const source of ['cf', 'follows', 'popular'] as const) {
      for (const lang of [undefined, true, false]) {
        const ctx = feedContext('fu-vids-lang', source, lang)
        assert.ok(isFeedContext(ctx), ctx)
      }
    }
  })

  it('rejects what a client could send that the service never issued', () => {
    for (const value of [
      undefined,
      42,
      '',
      'fu-vids',
      'fu-vids;src=cf;lang=2',
      'fu-vids;src=elsewhere',
      'fu|vids;src=cf',
      'fu vids;src=cf',
      'fu-vids;src=cf;lang=1;extra=1',
      `${'x'.repeat(513)};src=cf`,
    ]) {
      assert.equal(isFeedContext(value), false, String(value))
    }
  })
})
