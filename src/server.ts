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
import wellKnown from './well-known'

export class FeedGenerator {
  public app: express.Application
  public server?: http.Server
  public db: Database
  public redis: Redis
  public ingester: LikesIngester
  public graph?: ILikeGraph
  public cfg: Config
  private retentionTimer?: NodeJS.Timeout
  private rebuildTimer?: NodeJS.Timeout

  constructor(
    app: express.Application,
    db: Database,
    redis: Redis,
    ingester: LikesIngester,
    graph: ILikeGraph | undefined,
    cfg: Config,
  ) {
    this.app = app
    this.db = db
    this.redis = redis
    this.ingester = ingester
    this.graph = graph
    this.cfg = cfg
  }

  static create(cfg: Config) {
    const app = express()
    const db = createDb(cfg.databaseUrl)
    const redis = createRedis(cfg.redisUrl)
    const graph: ILikeGraph | undefined =
      cfg.rankerEngine === 'graph'
        ? cfg.graph.layout === 'csr'
          ? new CsrLikeGraph(cfg.graph)
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

    return new FeedGenerator(app, db, redis, ingester, graph, cfg)
  }

  async start(): Promise<http.Server> {
    await migrateToLatest(this.db)
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
    this.retentionTimer = startRetentionSweep(this.db, this.cfg.retentionHours)
    this.server = this.app.listen(this.cfg.port, this.cfg.listenhost)
    await events.once(this.server, 'listening')
    return this.server
  }
}

export default FeedGenerator
