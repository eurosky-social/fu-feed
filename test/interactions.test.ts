import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  SEEN_EVENT,
  parseInteractions,
  recordInteractionCounts,
  recordInteractions,
} from '../src/interactions'
import { makeFakeDb } from './helpers/fake-db'

const VIEWER = 'did:plc:viewer'
const NOW = new Date('2026-10-09T23:59:59.000Z')
const LIKE = 'app.bsky.feed.defs#interactionLike'
const LESS = 'app.bsky.feed.defs#requestLess'
const A = 'at://did:plc:a/app.bsky.feed.post/a'
const B = 'at://did:plc:b/app.bsky.feed.post/b'
const IN_LANG = 'fu-vids-lang;src=cf;lang=1'
const OTHER = 'fu-vids-lang;src=cf;lang=0'

describe('parsing a sendInteractions batch', () => {
  it('splits views, rewards and per-context totals', () => {
    const parsed = parseInteractions(
      VIEWER,
      [
        { item: A, event: SEEN_EVENT, feedContext: IN_LANG },
        { item: B, event: SEEN_EVENT, feedContext: IN_LANG },
        { item: A, event: LIKE, feedContext: IN_LANG },
        { item: B, event: LESS, feedContext: OTHER },
      ],
      NOW,
    )
    assert.deepEqual(parsed.seen, [A, B])
    assert.deepEqual(parsed.rewards, [
      {
        viewer_did: VIEWER,
        subject_uri: A,
        event: LIKE,
        weight: 3,
        created_at: NOW.toISOString(),
        feed_context: IN_LANG,
      },
      {
        viewer_did: VIEWER,
        subject_uri: B,
        event: LESS,
        weight: -5,
        created_at: NOW.toISOString(),
        feed_context: OTHER,
      },
    ])
    assert.deepEqual(parsed.counts, [
      { day: '2026-10-09', feed_context: IN_LANG, event: SEEN_EVENT, n: 2 },
      { day: '2026-10-09', feed_context: IN_LANG, event: LIKE, n: 1 },
      { day: '2026-10-09', feed_context: OTHER, event: LESS, n: 1 },
    ])
  })

  it('keeps a reward but neither stores nor counts a context it did not issue', () => {
    const parsed = parseInteractions(
      VIEWER,
      [
        { item: A, event: LIKE, feedContext: 'whatever a client sends' },
        { item: B, event: SEEN_EVENT },
      ],
      NOW,
    )
    assert.equal(parsed.rewards[0].feed_context, null)
    assert.deepEqual(parsed.seen, [B])
    assert.deepEqual(parsed.counts, [])
  })

  it('collapses a repeated reward, which Postgres would refuse in one upsert', () => {
    const parsed = parseInteractions(
      VIEWER,
      [
        { item: A, event: LIKE, feedContext: OTHER },
        { item: A, event: LIKE, feedContext: IN_LANG },
      ],
      NOW,
    )
    assert.equal(parsed.rewards.length, 1)
    assert.equal(parsed.rewards[0].feed_context, IN_LANG)
    // Both reports still count: the totals are of events received.
    assert.deepEqual(
      parsed.counts.map((c) => [c.feed_context, c.n]),
      [
        [OTHER, 1],
        [IN_LANG, 1],
      ],
    )
  })

  it('skips malformed items and events that carry no signal', () => {
    const parsed = parseInteractions(
      VIEWER,
      [
        null,
        { item: A },
        { event: LIKE },
        {
          item: A,
          event: 'app.bsky.feed.defs#somethingNew',
          feedContext: IN_LANG,
        },
      ],
      NOW,
    )
    assert.deepEqual(parsed, { seen: [], rewards: [], counts: [] })
    assert.deepEqual(parseInteractions(VIEWER, 'not a list', NOW), {
      seen: [],
      rewards: [],
      counts: [],
    })
  })
})

describe('storing interactions', () => {
  it("adds a batch to the day's totals rather than overwriting them", async () => {
    const { db, queries } = makeFakeDb(() => [])
    await recordInteractionCounts(db, [
      { day: '2026-10-09', feed_context: IN_LANG, event: LIKE, n: 2 },
    ])
    assert.equal(queries.length, 1)
    assert.match(queries[0].sql, /insert into "interaction_counts"/)
    assert.match(
      queries[0].sql,
      /on conflict \("day", "feed_context", "event"\) do update set "n" = interaction_counts\.n \+ excluded\.n/,
    )
  })

  it('keeps the context a reward already has when a repeat arrives without one', async () => {
    const { db, queries } = makeFakeDb(() => [])
    await recordInteractions(db, [
      {
        viewer_did: VIEWER,
        subject_uri: A,
        event: LIKE,
        weight: 3,
        created_at: NOW.toISOString(),
        feed_context: null,
      },
    ])
    assert.match(
      queries[0].sql,
      /"feed_context" = coalesce\("excluded"\."feed_context", "interactions"\."feed_context"\)/,
    )
  })

  it('writes nothing for an empty batch', async () => {
    const { db, queries } = makeFakeDb(() => [])
    await recordInteractions(db, [])
    await recordInteractionCounts(db, [])
    assert.equal(queries.length, 0)
  })
})
