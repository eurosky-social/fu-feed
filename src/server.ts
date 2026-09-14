import http from 'http'
import events from 'events'
import express from 'express'
import { DidResolver, MemoryCache } from '@atproto/identity'
import { AtpAgent } from '@atproto/api'
import { Redis } from 'ioredis'
import { createServer } from './lexicon'
import feedGeneration from './methods/feed-generation'
import describeGenerator from './methods/describe-generator'
import sendInteractions from './methods/send-interactions'
import { createDb, Database, migrateToLatest } from './db'
import { createRedis } from './redis'
import {
  LikesIngester,
  RepostsIngester,
  startRetentionSweep,
} from './subscription'
import { LikeGraph } from './graph/like-graph'
import { CsrLikeGraph } from './graph/csr-like-graph'
import { RecentAuthorIndex } from './graph/recent-author-index'
import { ILikeGraph } from './graph/types'
import { AppContext, Config } from './config'
import { prewarmColdStart } from './algos/for-you'
import wellKnown from './well-known'

export class FeedGenerator {
  public app: express.Application
  public server?: http.Server
  public db: Database
  public redis: Redis
  public ingester: LikesIngester
  public repostsIngester?: RepostsIngester
  public graph?: ILikeGraph
  public authorIndex?: RecentAuthorIndex
  public cfg: Config
  public ctx: AppContext
  private retentionTimer?: NodeJS.Timeout
  private rebuildTimer?: NodeJS.Timeout
  private compactTimer?: NodeJS.Timeout

  constructor(
    app: express.Application,
    db: Database,
    redis: Redis,
    ingester: LikesIngester,
    repostsIngester: RepostsIngester | undefined,
    graph: ILikeGraph | undefined,
    authorIndex: RecentAuthorIndex | undefined,
    cfg: Config,
    ctx: AppContext,
  ) {
    this.app = app
    this.db = db
    this.redis = redis
    this.ingester = ingester
    this.repostsIngester = repostsIngester
    this.graph = graph
    this.authorIndex = authorIndex
    this.cfg = cfg
    this.ctx = ctx
  }

  static create(cfg: Config) {
    const app = express()
    const db = createDb(cfg.databaseUrl)
    const redis = createRedis(cfg.redisUrl)
    const graph: ILikeGraph | undefined =
      cfg.rankerEngine === 'graph'
        ? cfg.graph.layout === 'csr'
          ? new CsrLikeGraph(cfg.graph, cfg.databaseUrl)
          : new LikeGraph(cfg.graph)
        : undefined
    // Only built when a follows feed is actually published — it is inert
    // otherwise, and the seed scan is not free.
    const authorIndex = cfg.feeds.some((f) => f.ranker === 'follows')
      ? new RecentAuthorIndex(cfg.follows)
      : undefined
    const ingester = new LikesIngester(
      db,
      cfg.jetstreamEndpoint,
      cfg.subscriptionReconnectDelay,
      graph,
      authorIndex,
    )
    // Reposts ride their own Jetstream subscription so nothing about the follows
    // feed can stall the like stream the collaborative filter depends on. Not
    // constructed at all unless reposts can affect a score.
    const repostsIngester =
      authorIndex && cfg.follows.repostWeight > 0
        ? new RepostsIngester(
            db,
            cfg.jetstreamEndpoint,
            cfg.subscriptionReconnectDelay,
            authorIndex,
          )
        : undefined

    const didCache = new MemoryCache()
    const didResolver = new DidResolver({
      plcUrl: 'https://plc.directory',
      didCache,
    })

    // Unauthenticated agent against the public AppView, used only to hydrate
    // post metadata (createdAt / likeCount / labels) for ranking candidates.
    const publicAgent = new AtpAgent({ service: cfg.publicAppviewUrl })

    const server = createServer({
      validateResponse: true,
      payload: {
        jsonLimit: 100 * 1024, // 100kb
        textLimit: 100 * 1024, // 100kb
        blobLimit: 5 * 1024 * 1024, // 5mb
      },
    })
    const ctx: AppContext = {
      db,
      redis,
      didResolver,
      publicAgent,
      graph,
      authorIndex,
      cfg,
    }
    feedGeneration(server, ctx)
    describeGenerator(server, ctx)
    // sendInteractions isn't in the bundled lexicon — register it as a plain
    // route before the lexicon router so it takes precedence.
    sendInteractions(app, ctx)
    app.use(server.xrpc.router)
    app.use(wellKnown(ctx))

    return new FeedGenerator(
      app,
      db,
      redis,
      ingester,
      repostsIngester,
      graph,
      authorIndex,
      cfg,
      ctx,
    )
  }

  // Postgres may not be resolvable yet when this process starts.
  //
  // The compose file does declare `depends_on: condition: service_healthy` for
  // both postgres and redis, but that only orders the *initial* `compose up`.
  // Observed on a deploy: the app container was created 38s before its
  // dependencies even existed, crashed five times with
  // `getaddrinfo ENOTFOUND foreu-postgres-production`, and only survived once
  // the database happened to be up — because Docker's `restart: unless-stopped`
  // restarts a container without re-evaluating `depends_on`.
  //
  // Crashing on a dependency that is merely not ready yet is the wrong default
  // for a service that is always restarted anyway: it turns an orderly wait into
  // a crash loop, burns RestartCount so a genuine crash is harder to spot, and
  // costs a minute of downtime on every deploy. Wait for it instead.
  private async migrateWithRetry(): Promise<void> {
    const startedAt = Date.now()
    const budgetMs = 60_000
    let attempt = 0
    for (;;) {
      try {
        await migrateToLatest(this.db)
        if (attempt > 0) {
          console.log(`[foryou] database reachable after ${attempt} retries`)
        }
        return
      } catch (err) {
        if (Date.now() - startedAt > budgetMs) throw err
        attempt++
        const delayMs = Math.min(1000 * attempt, 5000)
        console.warn(
          `[foryou] database not ready (attempt ${attempt}), retrying in ${delayMs}ms:`,
          err instanceof Error ? err.message : err,
        )
        await new Promise((r) => setTimeout(r, delayMs))
      }
    }
  }

  async start(): Promise<http.Server> {
    await this.migrateWithRetry()
    // Build the in-memory structures in the background; until each is ready its
    // feeds fall back to the cold-start popularity list. Boot builds retry with
    // backoff — a transient DB hiccup must not leave them cold until the next
    // periodic tick.
    //
    // Sequential, and live ingestion starts only once both are done, because a
    // build runs ~8x faster uncontended (the Jetstream consumer otherwise
    // saturates the event loop) and both scans stream the same table. Jetstream
    // resumes from its saved cursor, so no likes are missed meanwhile.
    //
    // The author index goes first: it scans hours of likes where the graph
    // scans weeks, so the follows feed comes up in minutes rather than waiting
    // out a full graph build.
    void (async () => {
      if (this.authorIndex) {
        const index = this.authorIndex
        const db = this.db
        await retryUntilBuilt('🗂️ follows index seed', () =>
          index.seedFromPostgres(db),
        )
        // Compaction is the index's only maintenance: it has no rebuild, since
        // the firehose keeps it current and only aged-out posts need reclaiming.
        this.compactTimer = setInterval(
          () => index.compact(),
          this.cfg.follows.compactIntervalMs,
        )
      }
      if (this.graph) {
        const graph = this.graph
        const db = this.db
        await retryUntilBuilt('🧠 like-graph boot build', () =>
          graph.buildFromPostgres(db),
        )
        // After the first success, rebuild on a fixed interval to refresh and
        // apply retention/deletes.
        this.rebuildTimer = setInterval(
          () => graph.buildFromPostgres(db),
          this.cfg.graph.rebuildIntervalMs,
        )
      }
      this.ingester.run()
      this.repostsIngester?.run()
    })()
    this.retentionTimer = startRetentionSweep(this.db, this.cfg.retentionHours, {
      pickerDid: this.cfg.pickerDid,
      sweepFollowsTables: this.authorIndex !== undefined,
      // Twice the candidate window, so a seed after a restart always has a full
      // window to read even if the sweep just ran.
      repostsRetentionHours: Math.max(72, this.cfg.follows.windowHours * 2),
    })
    // Warm the shared cold-start popularity cache so the first cold-start load
    // after boot doesn't pay the heavy GROUP-BY (fire-and-forget; it self-heals
    // via stale-while-revalidate if this races an early request).
    void prewarmColdStart(this.ctx)
    this.server = this.app.listen(this.cfg.port, this.cfg.listenhost)
    await events.once(this.server, 'listening')
    return this.server
  }
}

// Runs `attempt` until it reports success, backing off between tries. Used for
// the boot builds, where giving up would leave a structure cold indefinitely.
const retryUntilBuilt = async (
  what: string,
  attempt: () => Promise<boolean>,
): Promise<void> => {
  let delay = 5000
  while (!(await attempt())) {
    console.warn(`${what} failed; retrying in ${delay}ms`)
    await new Promise((res) => setTimeout(res, delay))
    delay = Math.min(delay * 2, 60000)
  }
}

export default FeedGenerator
