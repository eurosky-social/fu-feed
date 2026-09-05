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
import { LikesIngester, startRetentionSweep } from './subscription'
import { LikeGraph } from './graph/like-graph'
import { CsrLikeGraph } from './graph/csr-like-graph'
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
  public graph?: ILikeGraph
  public cfg: Config
  public ctx: AppContext
  private retentionTimer?: NodeJS.Timeout
  private rebuildTimer?: NodeJS.Timeout

  constructor(
    app: express.Application,
    db: Database,
    redis: Redis,
    ingester: LikesIngester,
    graph: ILikeGraph | undefined,
    cfg: Config,
    ctx: AppContext,
  ) {
    this.app = app
    this.db = db
    this.redis = redis
    this.ingester = ingester
    this.graph = graph
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
    const ingester = new LikesIngester(
      db,
      cfg.jetstreamEndpoint,
      cfg.subscriptionReconnectDelay,
      graph,
    )

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
      cfg,
    }
    feedGeneration(server, ctx)
    describeGenerator(server, ctx)
    // sendInteractions isn't in the bundled lexicon — register it as a plain
    // route before the lexicon router so it takes precedence.
    sendInteractions(app, ctx)
    app.use(server.xrpc.router)
    app.use(wellKnown(ctx))

    return new FeedGenerator(app, db, redis, ingester, graph, cfg, ctx)
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
    // Build the in-memory graph in the background; until ready, requests fall
    // back to the cold-start popularity feed. The boot build retries with
    // backoff (a transient DB hiccup must not leave the graph cold until the
    // next periodic tick). After the first success, rebuild on a fixed interval
    // to refresh and apply retention/deletes.
    if (this.graph) {
      const graph = this.graph
      const db = this.db
      void (async () => {
        let delay = 5000
        while (!(await graph.buildFromPostgres(db))) {
          console.warn(`🧠 like-graph boot build failed; retrying in ${delay}ms`)
          await new Promise((res) => setTimeout(res, delay))
          delay = Math.min(delay * 2, 60000)
        }
        // Start live ingestion only AFTER the first build so the build runs
        // uncontended (~8x faster — the Jetstream consumer otherwise saturates
        // the event loop). Jetstream resumes from its saved cursor, so no likes
        // are missed during the build.
        this.ingester.run()
        this.rebuildTimer = setInterval(
          () => graph.buildFromPostgres(db),
          this.cfg.graph.rebuildIntervalMs,
        )
      })()
    } else {
      this.ingester.run()
    }
    this.retentionTimer = startRetentionSweep(this.db, this.cfg.retentionHours, {
      pickerDid: this.cfg.pickerDid,
      curatorRetentionHours: this.cfg.curatorRetentionHours,
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

export default FeedGenerator
