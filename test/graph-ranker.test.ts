import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CsrLikeGraph } from '../src/graph/csr-like-graph'
import { GraphRanker } from '../src/ranker/graph'
import { AppContext, Config } from '../src/config'
import { Database } from '../src/db'
import { DatabaseSchema } from '../src/db/schema'
import {
  CompiledQuery,
  DatabaseConnection,
  Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  QueryResult,
} from 'kysely'
import { AtpAgent } from '@atproto/api'
import { graphConfig, hoursAgo, rankingConfig } from './helpers/config'
import { appviewPost, PostMetaRow } from './helpers/fake-db'

const VIEWER = 'did:plc:viewer'
const CURATOR = 'did:plc:curator'
const SEED = 'at://did:plc:author/app.bsky.feed.post/seed'
const CANDIDATE = 'at://did:plc:author/app.bsky.feed.post/cand'

type LikeRow = {
  uri: string
  liker_did: string
  subject_uri: string
  created_at: string
  indexed_at: string
}

const like = (
  liker: string,
  subject: string,
  createdHoursAgo: number,
): LikeRow => ({
  uri: `at://${liker}/app.bsky.feed.like/${subject.split('/').pop()}`,
  liker_did: liker,
  subject_uri: subject,
  created_at: hoursAgo(createdHoursAgo),
  indexed_at: hoursAgo(createdHoursAgo),
})

type CuratorRow = {
  viewer_did: string
  curator_did: string
  weight: number
  updated_at: string
}

// A stateful fake DB: answers the graph build, the ranker's seed / already-liked
// reads, the curators load + upsert, and the post_meta cache (kept cold so
// finalize hydrates via the AppView stub). `likes` and `curators` are mutable so
// a test can simulate a co-like aging out of the graph and observe the durable
// curator selection surviving it.
const makeStatefulDb = (state: {
  likes: LikeRow[]
  curators: CuratorRow[]
  postMeta: PostMetaRow[]
}) => {
  const upserts: CuratorRow[][] = [] // captured per persistCurators call
  class FakeDriver implements Driver {
    async init(): Promise<void> {}
    async acquireConnection(): Promise<DatabaseConnection> {
      const connection: DatabaseConnection = {
        async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
          const sql = query.sql
          const rows = (): unknown[] => {
            // graph build pre-sizing count
            if (sql.includes('count(*)')) return [{ c: String(state.likes.length) }]
            // curators load (ranker)
            if (sql.includes('from "curators"')) return state.curators
            // curators upsert (ranker) — capture, return nothing
            if (sql.includes('insert into "curators"')) {
              // Kysely compiles values(...) to a flat parameter list; rebuild
              // row objects from the column order in the SQL so the upsert can
              // be applied to state and asserted on.
              const colMatch = sql.match(/"curators"\s*\(([^)]+)\)/)
              const cols = colMatch
                ? colMatch[1].split(',').map((c) => c.trim().replace(/"/g, ''))
                : ['viewer_did', 'curator_did', 'weight', 'updated_at']
              const vals = query.parameters as unknown[]
              const upsertRows: CuratorRow[] = []
              for (let i = 0; i < vals.length; i += cols.length) {
                const row = {} as Record<string, unknown>
                cols.forEach((c, j) => (row[c] = vals[i + j]))
                upsertRows.push(row as unknown as CuratorRow)
              }
              upserts.push(upsertRows)
              // apply the upsert to state so a later load sees it
              for (const r of upsertRows) {
                const i = state.curators.findIndex(
                  (c) => c.viewer_did === r.viewer_did && c.curator_did === r.curator_did,
                )
                if (i >= 0) state.curators[i] = r
                else state.curators.push(r)
              }
              return []
            }
            // post_meta reads (hydrate) — cold cache so the AppView is exercised
            if (sql.includes('from "post_meta"')) {
              const wanted = new Set(query.parameters as string[])
              return state.postMeta.filter((r) => wanted.has(r.uri))
            }
            // post_meta write-back (hydrate) — swallow
            if (sql.includes('insert into "post_meta"')) return []
            // likes reads: graph build (csr orders by indexed_at with an upper
            // bound; arrays orders by liker_did) vs seed (ordered by created_at
            // desc) vs already-liked (created_at >, no order by)
            if (sql.includes('from "likes"')) {
              if (
                sql.includes('"indexed_at" <=') ||
                sql.includes('order by "liker_did"')
              ) {
                // graph build: one page is enough for the fixture
                return state.likes
              }
              if (sql.includes('order by "created_at" desc')) {
                // ranker seed query: this viewer's likes
                const viewer = query.parameters[0] as string
                return state.likes
                  .filter((l) => l.liker_did === viewer)
                  .sort((a, b) => b.created_at.localeCompare(a.created_at))
              }
              // already-liked exclusion: none in the fixture
              return []
            }
            return []
          }
          return { rows: rows() as R[] }
        },
        streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
          throw new Error('streamQuery is not supported by FakeDriver')
        },
      }
      return connection
    }
    async beginTransaction(): Promise<void> {}
    async commitTransaction(): Promise<void> {}
    async rollbackTransaction(): Promise<void> {}
    async releaseConnection(): Promise<void> {}
    async destroy(): Promise<void> {}
  }
  const db = new Kysely<DatabaseSchema>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new FakeDriver(),
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  })
  return { db, upserts }
}

const makeCtx = (
  db: Database,
  graph: CsrLikeGraph,
  opts: { persistCurators?: boolean; decayHalfLifeHours?: number; appviewPosts?: ReturnType<typeof appviewPost>[] } = {},
): AppContext => {
  const available = opts.appviewPosts ?? []
  const publicAgent = {
    app: {
      bsky: {
        feed: {
          getPosts: async ({ uris }: { uris: string[] }) => ({
            data: { posts: available.filter((p) => uris.includes(p.uri)) },
          }),
        },
      },
    },
  } as unknown as AtpAgent
  const cfg = {
    ranking: rankingConfig(),
    persistCurators: opts.persistCurators ?? true,
    curatorDecayHalfLifeHours: opts.decayHalfLifeHours ?? 0,
    curatorRetentionHours: 30 * 24,
    pickerDid: undefined,
  } as unknown as Config
  return {
    db,
    redis: {} as never,
    didResolver: {} as never,
    publicAgent,
    graph,
    cfg,
  }
}

describe('GraphRanker — persistent curator selection', () => {
  it('survives the likes retention cutoff via durable curators', async () => {
    // Start: the curator co-liked the viewer's seed post, and is still active.
    const state = {
      likes: [
        like(VIEWER, SEED, 5),
        like(CURATOR, SEED, 6),
        like(CURATOR, CANDIDATE, 1),
      ],
      curators: [] as CuratorRow[],
      postMeta: [] as PostMetaRow[],
    }
    const graph = new CsrLikeGraph(graphConfig())
    const { db, upserts } = makeStatefulDb(state)
    assert.equal(await graph.buildFromPostgres(db), true, 'graph build should succeed')
    const ctx = makeCtx(db, graph, {
      appviewPosts: [appviewPost(CANDIDATE, { createdAt: hoursAgo(1), likeCount: 1 })],
    })

    const ranker = new GraphRanker()
    // First request: CURATOR is discovered live, the candidate is served, and
    // the curator selection is persisted.
    const first = await ranker.rank(ctx, VIEWER, 'all')
    assert.ok(first.includes(CANDIDATE), 'first request should serve the candidate')
    assert.equal(upserts.length, 1, 'the curator selection should be persisted once')
    const persisted = upserts[0].find((r) => r.curator_did === CURATOR)
    assert.ok(persisted, 'CURATOR should be in the persisted selection')
    assert.equal(state.curators.length, 1, 'the curators table should hold the row')

    // Simulate the co-like aging out of the live graph: the CURATOR→SEED edge
    // is gone (swept past retention), but CURATOR is still active (recent
    // candidate like) and the viewer still likes SEED (the seed comes from
    // Postgres, not the graph). Rebuild the graph on the slimmed-down likes.
    state.likes = [like(VIEWER, SEED, 5), like(CURATOR, CANDIDATE, 1)]
    assert.equal(await graph.buildFromPostgres(db), true, 'rebuild should succeed')

    // Second request: the live pass finds no curator for SEED (the co-like is
    // gone), but the durable selection brings CURATOR back, and their recent
    // candidate like still surfaces the candidate.
    const second = await ranker.rank(ctx, VIEWER, 'all')
    assert.ok(
      second.includes(CANDIDATE),
      'the candidate should survive the cutoff via the durable curator',
    )
  })

  it('loses the aged-out curator when persistence is off', async () => {
    const state = {
      likes: [
        like(VIEWER, SEED, 5),
        like(CURATOR, SEED, 6),
        like(CURATOR, CANDIDATE, 1),
      ],
      curators: [] as CuratorRow[],
      postMeta: [] as PostMetaRow[],
    }
    const graph = new CsrLikeGraph(graphConfig())
    const { db, upserts } = makeStatefulDb(state)
    assert.equal(await graph.buildFromPostgres(db), true, 'graph build should succeed')
    const ctx = makeCtx(db, graph, {
      persistCurators: false,
      appviewPosts: [appviewPost(CANDIDATE, { createdAt: hoursAgo(1), likeCount: 1 })],
    })

    const ranker = new GraphRanker()
    const first = await ranker.rank(ctx, VIEWER, 'all')
    assert.ok(first.includes(CANDIDATE), 'first request still serves the candidate live')
    assert.equal(upserts.length, 0, 'nothing should be persisted when persistence is off')

    // Co-like ages out; with no durable selection to fall back on, the
    // candidate is gone — the control case.
    state.likes = [like(VIEWER, SEED, 5), like(CURATOR, CANDIDATE, 1)]
    assert.equal(await graph.buildFromPostgres(db), true, 'rebuild should succeed')
    const second = await ranker.rank(ctx, VIEWER, 'all')
    assert.ok(
      !second.includes(CANDIDATE),
      'without durable curators the aged-out curator is lost',
    )
  })
})

// Does the decay actually change an outcome? Two durable curators, both aged
// out of the live graph so they can only arrive via the durable selection.
// STALE carries the larger stored weight but was last seen two half-lives ago;
// FRESH was refreshed just now. Decay off → STALE's pick wins on raw weight.
// Decay on → STALE is shaded below FRESH and the order flips.
describe('GraphRanker — durable curator decay', () => {
  const FRESH = 'did:plc:fresh'
  const STALE = 'did:plc:stale'
  const CAND_FRESH = 'at://did:plc:authora/app.bsky.feed.post/canda'
  const CAND_STALE = 'at://did:plc:authorb/app.bsky.feed.post/candb'
  const HALF_LIFE = 14 * 24

  const scenario = () => {
    const state = {
      // neither curator co-liked SEED, so the live pass discovers nobody;
      // both are still active, so both have forward edges to contribute.
      likes: [
        like(VIEWER, SEED, 5),
        like(FRESH, CAND_FRESH, 1),
        like(STALE, CAND_STALE, 1),
      ],
      curators: [
        { viewer_did: VIEWER, curator_did: FRESH, weight: 1, updated_at: hoursAgo(0) },
        // two half-lives old, but three times the stored weight
        { viewer_did: VIEWER, curator_did: STALE, weight: 3, updated_at: hoursAgo(2 * HALF_LIFE) },
      ] as CuratorRow[],
      postMeta: [] as PostMetaRow[],
    }
    // identical AppView metadata, so finalize cannot separate them
    const posts = [
      appviewPost(CAND_FRESH, { createdAt: hoursAgo(1), likeCount: 1 }),
      appviewPost(CAND_STALE, { createdAt: hoursAgo(1), likeCount: 1 }),
    ]
    return { state, posts }
  }

  it('ranks the stale curator ahead when decay is off', async () => {
    const { state, posts } = scenario()
    const graph = new CsrLikeGraph(graphConfig())
    const { db } = makeStatefulDb(state)
    assert.equal(await graph.buildFromPostgres(db), true)
    const ctx = makeCtx(db, graph, { decayHalfLifeHours: 0, appviewPosts: posts })
    const out = await new GraphRanker().rank(ctx, VIEWER, 'all')
    assert.ok(out.includes(CAND_STALE) && out.includes(CAND_FRESH), 'both should surface')
    assert.ok(
      out.indexOf(CAND_STALE) < out.indexOf(CAND_FRESH),
      'without decay the larger stored weight wins',
    )
  })

  it('shades the stale curator below the fresh one when decay is on', async () => {
    const { state, posts } = scenario()
    const graph = new CsrLikeGraph(graphConfig())
    const { db } = makeStatefulDb(state)
    assert.equal(await graph.buildFromPostgres(db), true)
    const ctx = makeCtx(db, graph, { decayHalfLifeHours: HALF_LIFE, appviewPosts: posts })
    const out = await new GraphRanker().rank(ctx, VIEWER, 'all')
    assert.ok(
      out.indexOf(CAND_FRESH) < out.indexOf(CAND_STALE),
      'two half-lives should take 3 below 1 (3 * 0.25 = 0.75)',
    )
  })
})
