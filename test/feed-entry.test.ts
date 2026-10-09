import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  encodeEntry,
  postUriOf,
  toSkeletonPost,
  withContext,
} from '../src/algos/feed-entry'

const POST = 'at://did:plc:author/app.bsky.feed.post/abc'
const REPOST = 'at://did:plc:friend/app.bsky.feed.repost/xyz'

describe('feed entries', () => {
  it('round-trips a post with the repost that surfaced it', () => {
    const entry = encodeEntry(POST, REPOST)
    assert.equal(postUriOf(entry), POST)
    assert.deepEqual(toSkeletonPost(entry), {
      post: POST,
      reason: {
        $type: 'app.bsky.feed.defs#skeletonReasonRepost',
        repost: REPOST,
      },
    })
  })

  it('carries no reason for a post that stands on its own', () => {
    const entry = encodeEntry(POST)
    assert.equal(entry, POST)
    assert.deepEqual(toSkeletonPost(entry), { post: POST })
  })

  // Lists cached before attribution existed are bare post URIs. They have to
  // keep working, or a deploy would serve broken entries until every per-viewer
  // cache expired.
  it('reads a bare URI written before attribution existed', () => {
    assert.equal(postUriOf(POST), POST)
    assert.deepEqual(toSkeletonPost(POST), { post: POST })
  })

  it('carries a feed context on a post that stands on its own', () => {
    const entry = encodeEntry(POST, undefined, CONTEXT)
    assert.equal(postUriOf(entry), POST)
    assert.deepEqual(toSkeletonPost(entry), {
      post: POST,
      feedContext: CONTEXT,
    })
  })

  it('carries a feed context alongside the repost that surfaced the post', () => {
    const entry = encodeEntry(POST, REPOST, CONTEXT)
    assert.equal(postUriOf(entry), POST)
    assert.deepEqual(toSkeletonPost(entry), {
      post: POST,
      reason: {
        $type: 'app.bsky.feed.defs#skeletonReasonRepost',
        repost: REPOST,
      },
      feedContext: CONTEXT,
    })
  })

  it('adds a context to an entry without disturbing its repost', () => {
    assert.equal(
      withContext(POST, CONTEXT),
      encodeEntry(POST, undefined, CONTEXT),
    )
    assert.equal(
      withContext(encodeEntry(POST, REPOST), CONTEXT),
      encodeEntry(POST, REPOST, CONTEXT),
    )
    assert.equal(
      withContext(encodeEntry(POST, REPOST, 'old;src=cf'), CONTEXT),
      encodeEntry(POST, REPOST, CONTEXT),
    )
  })
})

const CONTEXT = 'fu-follows;src=follows;lang=1'
