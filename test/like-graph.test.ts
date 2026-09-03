import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CsrLikeGraph } from '../src/graph/csr-like-graph'
import { LikeGraph } from '../src/graph/like-graph'
import { graphConfig, hoursAgo, rankingConfig } from './helpers/config'
import { LikeRow, likeRowsHandler, makeFakeDb } from './helpers/fake-db'

const VIEWER = 'did:plc:viewer'
const EARLY = 'did:plc:early'
const LATE = 'did:plc:late'
const SEED = 'at://did:plc:author/app.bsky.feed.post/seed'
const earlyPick = 'at://did:plc:a/app.bsky.feed.post/early-pick'
const latePick = 'at://did:plc:a/app.bsky.feed.post/late-pick'

const like = (
  liker: string,
  subject: string,
  createdHoursAgo: number,
  indexedHoursAgo: number = createdHoursAgo,
): LikeRow => ({
  uri: `at://${liker}/app.bsky.feed.like/${subject.split('/').pop()}`,
  liker_did: liker,
  subject_uri: subject,
  created_at: hoursAgo(createdHoursAgo),
  indexed_at: hoursAgo(indexedHoursAgo),
})

const seed = (uri: string, likedHoursAgo: number) => [
  { uri, likedAtMs: Date.now() - likedHoursAgo * 60 * 60 * 1000 },
]

// The arrays layout pages by (liker_did, created_at, uri) and relies on that
// order for its chronological forward slices, so fixtures are handed over the
// way its own query would deliver them.
const buildArrays = async (rows: LikeRow[]) => {
  const ordered = [...rows].sort((a, b) =>
    a.liker_did === b.liker_did
      ? a.created_at.localeCompare(b.created_at)
      : a.liker_did.localeCompare(b.liker_did),
  )
  const graph = new LikeGraph(graphConfig({ layout: 'arrays' }))
  const { db } = makeFakeDb(likeRowsHandler(ordered))
  assert.equal(await graph.buildFromPostgres(db), true, 'build should succeed')
  return graph
}

// Both curators liked the seed and one further post each; the only thing
// separating them is whether they got to the seed before the viewer did.
const chronologyRows = (): LikeRow[] => [
  like(EARLY, SEED, 6),
  like(VIEWER, SEED, 5),
  like(LATE, SEED, 4),
  like(EARLY, earlyPick, 1),
  like(LATE, latePick, 1),
]

describe('LikeGraph.score', () => {
  it('ranks the early liker\'s pick above the late liker\'s', async () => {
    const graph = await buildArrays(chronologyRows())
    const scored = graph.score(
      VIEWER,
      seed(SEED, 5),
      rankingConfig({ lateLikerWeight: 0.3 }),
    )
    assert.ok(
      (scored.get(earlyPick) ?? 0) > (scored.get(latePick) ?? 0),
      'the pick of the curator who liked the seed first should score higher',
    )
  })

  it('drops late likers entirely at weight 0', async () => {
    const graph = await buildArrays(chronologyRows())
    const scored = graph.score(
      VIEWER,
      seed(SEED, 5),
      rankingConfig({ lateLikerWeight: 0 }),
    )
    assert.ok(scored.has(earlyPick), 'the early liker still curates')
    assert.ok(!scored.has(latePick), 'a late liker contributes nothing at weight 0')
  })

})

describe('graph layout parity', () => {
  // The two layouts are documented as interchangeable, so the chronology
  // weighting has to mean the same thing in both.
  it('ranks identically under chronology weighting', async () => {
    const third = 'did:plc:third'
    const rows: LikeRow[] = [
      ...chronologyRows(),
      like(third, SEED, 7),
      like(third, earlyPick, 3),
    ]
    const cfg = rankingConfig({ lateLikerWeight: 0.3 })

    const arrays = await buildArrays(rows)
    const csr = new CsrLikeGraph(graphConfig())
    const { db } = makeFakeDb(likeRowsHandler(rows))
    assert.equal(await csr.buildFromPostgres(db), true, 'csr build should succeed')

    const rank = (scored: Map<string, number>) =>
      [...scored.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

    const fromArrays = rank(arrays.score(VIEWER, seed(SEED, 5), cfg))
    const fromCsr = rank(csr.score(VIEWER, seed(SEED, 5), cfg))

    assert.ok(fromArrays.length > 0, 'fixture should produce candidates')
    assert.deepEqual(
      fromArrays.map(([uri]) => uri),
      fromCsr.map(([uri]) => uri),
    )
    for (let i = 0; i < fromArrays.length; i++) {
      assert.ok(
        Math.abs(fromArrays[i][1] - fromCsr[i][1]) < 1e-12,
        `score for ${fromArrays[i][0]} should match across layouts`,
      )
    }
  })
})
