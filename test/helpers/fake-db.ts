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
import { AppContext, FollowsConfig, RankingConfig } from '../../src/config'
import { Database } from '../../src/db'
import { DatabaseSchema } from '../../src/db/schema'
import { RecentAuthorIndex } from '../../src/graph/recent-author-index'
import { followsConfig, rankingConfig } from './config'

export type QueryHandler = (query: CompiledQuery) => unknown[]

// Minimal Kysely driver that answers every query from a handler instead of a
// real connection. Queries are still compiled by the genuine Postgres compiler,
// so tests can assert on the SQL the app actually emits.
class FakeDriver implements Driver {
  constructor(private readonly handler: QueryHandler) {}

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    const handler = this.handler
    const connection: DatabaseConnection = {
      async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
        return { rows: handler(query) as R[] }
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

export type FakeDb = {
  db: Database
  // every query the code under test issued, in order
  queries: CompiledQuery[]
}

export const makeFakeDb = (handler: QueryHandler): FakeDb => {
  const queries: CompiledQuery[] = []
  const db = new Kysely<DatabaseSchema>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new FakeDriver((q) => {
        queries.push(q)
        return handler(q)
      }),
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  })
  return { db, queries }
}

export type LikeRow = {
  uri: string
  liker_did: string
  subject_uri: string
  created_at: string
  indexed_at: string
}

// Serves the two query shapes buildFromPostgres issues: the pre-sizing count,
// then keyset pages of like rows. Rows are returned in the order given — the
// point of most tests here is what the builder does with that order — and a
// single page suffices because BUILD_PAGE (100k) exceeds any fixture.
export const likeRowsHandler = (rows: LikeRow[]): QueryHandler => {
  let pagesServed = 0
  return (query) => {
    if (query.sql.includes('count(*)')) return [{ c: String(rows.length) }]
    if (query.sql.includes('from "likes"')) {
      // Every fixture fits in one page (BUILD_PAGE is 100k), so the builder
      // sees a short page and stops. Serving [] afterwards keeps the helper
      // honest if that ever stops being true.
      return pagesServed++ === 0 ? rows : []
    }
    return []
  }
}

// --- post_meta cache + AppView stubs, for the hydration/finalize path ---

export type PostMetaRow = {
  uri: string
  author_did: string
  created_at: string
  like_count: number
  is_quote: number
  is_adult: number
  is_reply: number
  is_image: number
  is_video: number
  langs: string
  hydrated_at: string
}

// Answers the post_meta reads finalize/hydrate issue and swallows write-backs.
export const postMetaHandler =
  (rows: PostMetaRow[]): QueryHandler =>
  (query) => {
    if (query.sql.includes('from "post_meta"')) {
      const wanted = new Set(query.parameters as string[])
      return rows.filter((r) => wanted.has(r.uri))
    }
    return [] // insert … on conflict … returns nothing we use
  }

// A post as the public AppView would return it.
export const appviewPost = (
  uri: string,
  opts: {
    author?: string
    createdAt?: string
    likeCount?: number
    media?: 'images' | 'video'
    langs?: string[]
    reply?: boolean
  } = {},
) => ({
  uri,
  author: { did: opts.author ?? 'did:plc:author' },
  record: {
    createdAt: opts.createdAt ?? new Date().toISOString(),
    langs: opts.langs,
    ...(opts.reply ? { reply: { parent: { uri: 'at://x' }, root: { uri: 'at://x' } } } : {}),
  },
  likeCount: opts.likeCount ?? 0,
  ...(opts.media
    ? { embed: { $type: `app.bsky.embed.${opts.media}#view` } }
    : {}),
  labels: [],
})

export type TestContext = {
  ctx: AppContext
  // one entry per getPosts call, holding the URIs that call asked for
  appviewRequests: string[][]
  // every URI the AppView was asked for, across all calls
  appviewUris: () => string[]
}

export const makeContext = (opts: {
  cachedMeta?: PostMetaRow[]
  appviewPosts?: ReturnType<typeof appviewPost>[]
  ranking?: Partial<RankingConfig>
  follows?: Partial<FollowsConfig>
  pickerDid?: string
  authorIndex?: RecentAuthorIndex
  // When set, getPosts throws the way @atproto/xrpc does when the AppView's
  // response fails lexicon validation: the parsed body rides on the error.
  appviewInvalidResponse?: boolean
  // the viewer's follow list, as the `follows` table would return it
  followedDids?: string[]
  // post URIs the viewer has already liked, as the `likes` table would
  alreadyLiked?: string[]
}): TestContext => {
  const meta = postMetaHandler(opts.cachedMeta ?? [])
  const { db } = makeFakeDb((query) => {
    if (query.sql.includes('from "follows"')) {
      return (opts.followedDids ?? []).map((did) => ({ subject_did: did }))
    }
    if (query.sql.includes('from "likes"')) {
      return (opts.alreadyLiked ?? []).map((uri) => ({ subject_uri: uri }))
    }
    return meta(query)
  })
  const available = opts.appviewPosts ?? []
  const appviewRequests: string[][] = []

  const publicAgent = {
    app: {
      bsky: {
        feed: {
          getPosts: async ({ uris }: { uris: string[] }) => {
            appviewRequests.push(uris)
            const posts = available.filter((p) => uris.includes(p.uri))
            if (opts.appviewInvalidResponse) {
              throw Object.assign(new Error('Invalid Response'), {
                lexiconNsid: 'app.bsky.feed.getPosts',
                responseBody: { posts },
              })
            }
            return { data: { posts } }
          },
        },
      },
    },
  } as unknown as AtpAgent

  const ctx = {
    db,
    redis: {} as never,
    didResolver: {} as never,
    publicAgent,
    authorIndex: opts.authorIndex,
    cfg: {
      ranking: rankingConfig(opts.ranking),
      follows: followsConfig(opts.follows),
      pickerDid: opts.pickerDid,
    },
  } as unknown as AppContext

  return {
    ctx,
    appviewRequests,
    appviewUris: () => appviewRequests.flat(),
  }
}
