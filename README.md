# For You — personalized ATProto feed generator

A personalized "For You" feed for the AT Protocol, built on the standard
[feed generator](https://github.com/bluesky-social/feed-generator) interface. Any client can
subscribe to it by its feed AT-URI — there is no client-side code.

## The algorithm

A collaborative filter over the network's **likes**:

1. **Seed** — the viewer's recent likes, each weighted (recent likes are down-weighted to reduce
   over-reactivity).
2. **Curators** — other users who liked those same posts. A curator's weight reflects how many of the
   viewer's seed posts they also liked.
3. **Candidates** — those curators' other recent likes. A post's score is a smoothed count of the
   independent paths reaching it (`paths^smoothing`), normalized by the curators' and seed items'
   degrees.
4. **Finalize** — exponential time-decay (half-life), popularity penalty (`/ likeCount^penalty`), a
   freshness cap, adult-label and reply filtering, per-author diversification, and exclusion of posts
   the viewer has already liked or seen.

Anonymous viewers and brand-new accounts get a cold-start popularity feed (most-liked recent posts).
Every parameter is env-overridable — see [.env.example](.env.example).

## Architecture

```
Jetstream (app.bsky.feed.like) ──► ingester ──► Postgres (likes, post_meta)
                                                       │
        client ──► AppView ──► getFeedSkeleton (viewer DID from JWT)
                                       │  ranker → finalize → Redis-cached list
                                       ▼
                              post URIs ──► client hydrates via getPosts
```

- **Ingestion** ([src/subscription.ts](src/subscription.ts), [src/jetstream.ts](src/jetstream.ts)) —
  consumes the like stream from Jetstream into the `likes` edge table; prunes past
  `FEEDGEN_RETENTION_HOURS`. The cursor is persisted, so restarts resume where they left off.
- **Ranking** ([src/ranker/](src/ranker/)) — the seed is read from Postgres; the heavy curator and
  candidate work runs against an **in-memory like graph** ([src/graph/](src/graph/)) for low-latency
  responses. `finalize.ts` applies decay/filters; `hydrate.ts` fetches post metadata from the public
  AppView (cached in `post_meta`).
- **Serving** ([src/algos/for-you.ts](src/algos/for-you.ts),
  [src/methods/](src/methods/)) — reads the viewer DID from the signed feed-generator JWT, caches the
  ranked list per viewer in Redis, and serves unseen posts (see Interactions below).

### Backfill

Two backfills make a viewer's feed good on their first load instead of waiting for the firehose to
accumulate:

- **Per-viewer seed** — the viewer's own like history is imported via `com.atproto.repo.listRecords`, so
  their seed is complete from the start.
- **Seed co-likers** — in the background, the historical likers of the viewer's recent seed posts are
  imported from the AppView (`app.bsky.feed.getLikes`) to densify the co-liker graph beyond what live
  ingestion has seen. It's bounded per viewer (once per backfill TTL), per post (deduped across viewers,
  skipped once a post is well-covered), and in depth (only likes within the retention window), runs off
  the request path, and invalidates the viewer's cached lists on completion so the next load reflects the
  denser graph. It's a cold-start bridge: once live ingestion already spans a full retention window the
  firehose has every in-window like, so the backfill switches itself off (and back on automatically if
  you later widen retention).

Both are lazy and self-limiting — they run only for viewers who load the feed, and converge as the graph
fills. For a complete cold-start graph independent of who subscribes, do a one-time network-wide repo
backfill instead (`com.atproto.sync.listRepos` → per-repo like records).

### Ranker engines (`FEEDGEN_RANKER`)

- **`graph`** (default) — holds the like graph in RAM (built from Postgres on boot, kept live from the
  firehose, rebuilt periodically). Responses are typically tens of milliseconds.
- **`postgres`** — computes each request as a single Postgres query. Simpler; slower per request.

The in-memory graph has two interchangeable layouts (`FEEDGEN_GRAPH_LAYOUT`): `csr` (typed-array
compressed-sparse-row + arena interners; compact, supports large retention windows) and `arrays`
(Map-based; simpler). `FEEDGEN_GRAPH_WINDOW_HOURS` controls how much history is held in RAM.

## Interactions

Clients report interaction events via `app.bsky.feed.sendInteractions`
([src/methods/send-interactions.ts](src/methods/send-interactions.ts)); the AppView proxies them with the
viewer's signed JWT, and publishing sets `acceptsInteractions: true` so clients send them. Two things
happen:

- **`interactionSeen`** drives an **unseen-only feed** — seen posts are tracked per viewer in Redis and
  filtered out, so a refresh brings new content.
- **Positive events** (`interactionLike`, `interactionRepost`, `requestMore`, clickthroughs, …) and the
  **negative `requestLess`** are recorded with a signed weight in the `interactions` table — a durable
  reward signal for evaluating and tuning ranking parameters against real engagement. The signal is
  collected only; it does not yet feed back into ranking.

## Multiple feeds

Content-typed variants (images, video) share the **one** in-memory graph — only a final content filter
differs, so additional feeds add negligible memory. Set `FEEDGEN_IMAGE_FEED_RKEY` /
`FEEDGEN_VIDEO_FEED_RKEY` to the rkeys you publish for them.

Because media is a fraction of all posts, content feeds **over-generate** candidates
(`maxCandidates × FEEDGEN_MEDIA_CANDIDATE_MULTIPLIER`) before applying the media filter, so a photo or
video feed isn't starved by a content-blind candidate cap.

## Getting started

```bash
npm install
cp .env.example .env          # then edit (publisher DID, hostname)
docker-compose up -d          # local Postgres + Redis
npm start                     # migrates, builds the graph, starts the server
```

The schema migrates on start. The graph builds in the background; until it's ready, requests are
served the cold-start popularity feed.

## Deploy & publish

1. Serve the app over HTTPS on port 443 at `FEEDGEN_HOSTNAME` (the did:web document is exposed at
   `/.well-known/did.json`).
2. Publish the feed record(s):
   ```bash
   npm run publishFeed     # handle + app password, recordName matching FEEDGEN_FEED_SHORTNAME
   ```

Once published, the feed appears in any client's custom-feed search and can be saved or pinned.

## Configuration

All configuration is via environment variables — see [.env.example](.env.example) for the full list
with descriptions (storage, ingestion, identity/publishing, ranker engine, and ranking parameters).

## License

MIT. This project builds on [bluesky-social/feed-generator](https://github.com/bluesky-social/feed-generator)
(MIT) — see [LICENSE](LICENSE).
