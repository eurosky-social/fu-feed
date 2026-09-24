import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CompiledQuery } from 'kysely'
import { CsrLikeGraph } from '../src/graph/csr-like-graph'
import { LikeGraph } from '../src/graph/like-graph'
import { ILikeGraph } from '../src/graph/types'
import { GraphConfig } from '../src/config'
import { graphConfig, hoursAgo, rankingConfig } from './helpers/config'
import { LikeRow, QueryHandler, makeFakeDb } from './helpers/fake-db'

const PICKER = 'did:plc:picker'
const HUB = `at://${PICKER}/app.bsky.feed.post/science`
const IDLE_HUB = `at://${PICKER}/app.bsky.feed.post/comics`
const CANDIDATE = 'at://did:plc:author/app.bsky.feed.post/fresh'
const NEWCOMER = 'did:plc:newcomer'
const REGULAR_A = 'did:plc:regular-a'
const REGULAR_B = 'did:plc:regular-b'

const like = (liker: string, subject: string, hours: number): LikeRow => ({
  uri: `at://${liker}/app.bsky.feed.like/${subject.split('/').pop()}`,
  liker_did: liker,
  subject_uri: subject,
  created_at: hoursAgo(hours),
  indexed_at: hoursAgo(hours),
})

// Two established accounts picked "science" long ago and still like things; a
// newcomer has just picked it. Only the newcomer's like is inside the window.
const IN_WINDOW: LikeRow[] = [
  like(NEWCOMER, HUB, 1),
  like(REGULAR_A, CANDIDATE, 2),
  like(REGULAR_B, CANDIDATE, 3),
]
const BEYOND_WINDOW: LikeRow[] = [
  like(REGULAR_A, HUB, 900),
  like(REGULAR_B, HUB, 1000),
  like(REGULAR_A, IDLE_HUB, 1100),
]

const isHubLookup = (q: CompiledQuery): boolean =>
  q.sql.includes('"subject_uri" in (')

// The window scan gets IN_WINDOW; the hub lookup gets whichever of
// BEYOND_WINDOW it asked for by URI.
const likesHandler = (): QueryHandler => {
  let scanned = false
  return (q) => {
    if (isHubLookup(q)) {
      const wanted = new Set(q.parameters)
      return BEYOND_WINDOW.filter((r) => wanted.has(r.subject_uri))
    }
    if (q.sql.includes('count(*)')) return [{ c: String(IN_WINDOW.length) }]
    if (q.sql.includes('from "likes"')) {
      if (scanned) return []
      scanned = true
      return IN_WINDOW
    }
    return []
  }
}

const LAYOUTS: [GraphConfig['layout'], (cfg: GraphConfig) => ILikeGraph][] = [
  ['csr', (cfg) => new CsrLikeGraph(cfg)],
  ['arrays', (cfg) => new LikeGraph(cfg)],
]

for (const [layout, make] of LAYOUTS) {
  const build = async (pickerDid?: string) => {
    const graph = make(graphConfig({ layout, pickerDid }))
    const { db, queries } = makeFakeDb(likesHandler())
    assert.equal(await graph.buildFromPostgres(db), true, 'build should succeed')
    return { graph, queries }
  }

  // Two curators have to be reached for the candidate to be eligible, so a
  // traversal that stops early for either of them fails this.
  const ranking = rankingConfig({ minEligibleRaters: 2 })

  describe(`interest-post likes beyond the graph window (${layout})`, () => {
    it('keeps the accounts that picked an interest long ago as curators', async () => {
      const { graph } = await build(PICKER)
      const scored = graph.score(NEWCOMER, [HUB], ranking)
      assert.ok(
        scored.has(CANDIDATE),
        'a post both earlier pickers liked should reach the newcomer',
      )
    })

    it('holds only the window when no picker account is configured', async () => {
      const { graph, queries } = await build(undefined)
      assert.ok(!queries.some(isHubLookup), 'no hub lookup without a picker')
      assert.equal(graph.score(NEWCOMER, [HUB], ranking).size, 0)
    })

    it('looks hubs up by exact URI, below the window floor only', async () => {
      const { queries } = await build(PICKER)
      const lookups = queries.filter(isHubLookup)
      assert.equal(lookups.length, 1)
      const q = lookups[0]
      // A prefix LIKE cannot use the subject index under an en_US collation
      // and would read the whole table on every rebuild.
      assert.doesNotMatch(q.sql, / like /i)
      // The complement of the window scan's `indexed_at >` bound, so no like is
      // loaded by both.
      assert.match(q.sql, /"indexed_at" <= \$\d+/)
      // Only interest posts the window scan saw are looked up.
      assert.ok(q.parameters.includes(HUB))
      assert.ok(!q.parameters.includes(IDLE_HUB))
      assert.ok(!q.parameters.includes(CANDIDATE))
    })
  })
}
