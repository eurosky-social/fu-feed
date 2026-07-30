import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ArenaInterner, isInternable } from '../src/graph/arena-interner'

describe('isInternable', () => {
  it('accepts the ASCII keys the graph actually stores', () => {
    assert.equal(isInternable('did:plc:ituoear7k6qx3smjfoxhufm4'), true)
    assert.equal(
      isInternable('at://did:plc:abc/app.bsky.feed.post/3law52komss2b'),
      true,
    )
  })

  it('rejects non-ASCII keys', () => {
    // The arena stores one byte per char, so a non-ASCII key would be
    // truncated on write and could collide with an unrelated key.
    assert.equal(isInternable('did:plc:café'), false)
    assert.equal(isInternable('at://did:plc:a/post/😀'), false)
  })

  it('rejects the empty key', () => {
    assert.equal(isInternable(''), false)
  })
})

describe('ArenaInterner', () => {
  it('assigns stable, dense ids and round-trips keys', () => {
    const interner = new ArenaInterner(4)
    const a = interner.intern('did:plc:aaa')
    const b = interner.intern('did:plc:bbb')

    assert.equal(a, 0)
    assert.equal(b, 1)
    assert.equal(interner.intern('did:plc:aaa'), a, 'interning is idempotent')
    assert.equal(interner.count, 2)
    assert.equal(interner.keyAt(a), 'did:plc:aaa')
    assert.equal(interner.keyAt(b), 'did:plc:bbb')
  })

  it('get() distinguishes known from unknown keys', () => {
    const interner = new ArenaInterner(4)
    const id = interner.intern('did:plc:known')
    assert.equal(interner.get('did:plc:known'), id)
    assert.equal(interner.get('did:plc:missing'), undefined)
  })

  it('grows past its initial capacity without losing or colliding keys', () => {
    // Starts far below the key count to force rehashing.
    const interner = new ArenaInterner(4)
    const keys: string[] = []
    for (let i = 0; i < 5000; i++) keys.push(`at://did:plc:a/app.bsky.feed.post/p${i}`)

    const ids = keys.map((k) => interner.intern(k))
    assert.equal(new Set(ids).size, keys.length, 'ids must be unique')
    assert.equal(interner.count, keys.length)
    keys.forEach((k, i) => {
      assert.equal(interner.get(k), ids[i])
      assert.equal(interner.keyAt(ids[i]), k)
    })
  })

  it('keeps keys distinct across an arena chunk boundary', () => {
    // A tiny chunk size forces many chunk rollovers; a key must never be split
    // across chunks or read back from the wrong offset.
    const interner = new ArenaInterner(8, 64)
    const keys: string[] = []
    for (let i = 0; i < 400; i++) keys.push(`did:plc:chunkboundarykey${i}`)

    const ids = keys.map((k) => interner.intern(k))
    assert.equal(new Set(ids).size, keys.length)
    keys.forEach((k, i) => assert.equal(interner.keyAt(ids[i]), k))
  })

  it('does not confuse keys sharing a long prefix', () => {
    const interner = new ArenaInterner(8)
    const base = 'at://did:plc:averylongidentifier/app.bsky.feed.post/'
    const a = interner.intern(`${base}aaaaaaaaaa1`)
    const b = interner.intern(`${base}aaaaaaaaaa2`)

    assert.notEqual(a, b)
    assert.equal(interner.keyAt(a), `${base}aaaaaaaaaa1`)
    assert.equal(interner.keyAt(b), `${base}aaaaaaaaaa2`)
  })
})
