import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CsrLikeGraph } from '../src/graph/csr-like-graph'
import { LikeGraph } from '../src/graph/like-graph'
import { graphConfig, hoursAgo, rankingConfig } from './helpers/config'
import { LikeRow, likeRowsHandler, makeFakeDb } from './helpers/fake-db'

const VIEWER = 'did:plc:viewer'
const CURATOR = 'did:plc:curator'
const SEED = 'at://did:plc:author/app.bsky.feed.post/seed'
const niche = 'at://did:plc:a/app.bsky.feed.post/niche'
const popular = 'at://did:plc:a/app.bsky.feed.post/popular'

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

// The arrays layout pages by (liker_did, created_at, uri) and relies on that
// order for its forward slices, so fixtures are handed over the way its own
// query would deliver them.
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

// CURATOR co-liked both candidates, so they carry the same path evidence. The
// only difference is that `popular` is already viral inside the window.
const rows = (): LikeRow[] => {
  const r: LikeRow[] = [
    like(VIEWER, SEED, 5),
    like(CURATOR, SEED, 6),
    like(CURATOR, niche, 1),
    like(CURATOR, popular, 1),
  ]
  for (let i = 0; i < 20; i++) r.push(like(`did:plc:bystander${i}`, popular, 1))
  return r
}

describe('LikeGraph.score — candidateDegreePenalty', () => {
  it('shades down a candidate the whole window already liked', async () => {
    const graph = await buildArrays(rows())
    const scored = graph.score(
      VIEWER,
      [SEED],
      rankingConfig({ candidateDegreePenalty: 1 }),
    )
    assert.ok(
      (scored.get(niche) ?? 0) > (scored.get(popular) ?? 0),
      'the less-liked candidate should outrank the popular one',
    )
  })

  it('leaves them tied when off', async () => {
    const graph = await buildArrays(rows())
    const scored = graph.score(
      VIEWER,
      [SEED],
      rankingConfig({ candidateDegreePenalty: 0 }),
    )
    assert.equal(scored.get(niche), scored.get(popular))
  })
})

describe('graph layout parity — candidateDegreePenalty', () => {
  // The two layouts count in-window likers differently (rev[] length vs the
  // CSR revDegree slice), so the penalty must still rank identically.
  it('ranks identically under the degree penalty', async () => {
    const fixture = rows()
    const arrays = await buildArrays(fixture)
    const csr = new CsrLikeGraph(graphConfig())
    const { db } = makeFakeDb(likeRowsHandler(fixture))
    assert.equal(await csr.buildFromPostgres(db), true, 'csr build should succeed')

    const cfg = rankingConfig({ candidateDegreePenalty: 1 })
    const fromArrays = arrays.score(VIEWER, [SEED], cfg)
    const fromCsr = csr.score(VIEWER, [SEED], cfg)

    assert.deepEqual(
      [...fromArrays.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      [...fromCsr.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      'candidate scores should match across layouts',
    )
  })
})
