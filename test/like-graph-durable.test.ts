import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CsrLikeGraph } from '../src/graph/csr-like-graph'
import { LikeGraph } from '../src/graph/like-graph'
import { graphConfig, hoursAgo, rankingConfig } from './helpers/config'
import { LikeRow, likeRowsHandler, makeFakeDb } from './helpers/fake-db'

const VIEWER = 'did:plc:viewer'
const CURATOR = 'did:plc:curator'
const SEED = 'at://did:plc:author/app.bsky.feed.post/seed'

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

describe('graph layout parity — durable curators', () => {
  // The durable-curator merge must agree across layouts: a curator the live
  // pass missed (seed co-like aged out) is merged back in identically, and
  // onCurators reports the same set.
  it('merges durable curators and reports them identically across layouts', async () => {
    const candidate = 'at://did:plc:a/app.bsky.feed.post/cand'
    // CURATOR is active (recent candidate like) but did not like the seed in
    // the live graph — only the durable selection brings them back.
    const rows: LikeRow[] = [like(VIEWER, SEED, 5), like(CURATOR, candidate, 1)]
    const durable = new Map([[CURATOR, 1]])

    const arrays = await buildArrays(rows)
    const csr = new CsrLikeGraph(graphConfig())
    const { db } = makeFakeDb(likeRowsHandler(rows))
    assert.equal(await csr.buildFromPostgres(db), true, 'csr build should succeed')

    const arraysCurators = new Map<string, number>()
    const csrCurators = new Map<string, number>()
    const fromArrays = arrays.score(VIEWER, [SEED], rankingConfig(), undefined, {
      durableCurators: durable,
      onCurators: (m) => m.forEach((v, k) => arraysCurators.set(k, v)),
    })
    const fromCsr = csr.score(VIEWER, [SEED], rankingConfig(), undefined, {
      durableCurators: durable,
      onCurators: (m) => m.forEach((v, k) => csrCurators.set(k, v)),
    })

    assert.ok(fromArrays.has(candidate), 'arrays layout should surface the durable candidate')
    assert.ok(fromCsr.has(candidate), 'csr layout should surface the durable candidate')
    assert.deepEqual(
      [...fromArrays.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      [...fromCsr.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      'candidate scores should match across layouts',
    )
    assert.deepEqual(
      [...arraysCurators.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      [...csrCurators.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      'reported curator sets should match across layouts',
    )
  })
})
