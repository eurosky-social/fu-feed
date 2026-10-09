# fu — personalized ATProto feed generator

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
For an authenticated but likeless account, that feed is biased toward the languages in the request's
`Accept-Language` header (forwarded by the AppView) — the only per-viewer taste signal available before
the account has liked anything. Posts declaring a non-matching language are dropped; posts that declare
no language always pass, so the feed narrows toward the viewer's languages without starving. Anonymous
viewers share one cached list, so they stay global (a per-request header there would poison the shared
list). Every ranking parameter is env-overridable — see [.env.example](.env.example).

A personalized list shorter than `FEEDGEN_MIN_FEED_SIZE` (default 200) is filled up to it with that
same cold-start feed, personalized posts first. An account that has only just onboarded, with a
handful of likes, gets its few personalized posts and then something to scroll into, rather than a
feed that ends after one to five posts. The follows feed is never filled: it would show strangers.

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
(Map-based; simpler). `FEEDGEN_GRAPH_WINDOW_HOURS` controls how much history is held in RAM, with
one exception: likes on the onboarding interest posts — the posts on the `FEEDGEN_PICKER_DID` account
that the client likes for each interest a new user picks — are loaded whatever their age, just as the
retention sweep never deletes them. They are a newcomer's only link to anyone else, and the older
ones belong to the established accounts that still like things.

## Cold starts and the request budget

The AppView gives up on a `getFeedSkeleton` call after about **4.7 seconds** and renders the timeout as
*"Hmm, the feed server appears to be offline. Please let the feed owner know about this issue."* — a
the-feed-is-broken message, shown to a viewer whose feed is merely cold. A first load routinely runs
past that ceiling: the inline import of the viewer's likes or follows is bounded separately from
hydration, and if the ranker comes up empty the cold-start feed hydrates all over again. Each stage
honours its own deadline; nothing capped the sum.

`FEEDGEN_REQUEST_BUDGET_MS` (default 4s) caps it, counted from when the request arrives — verifying
the viewer's token can cost a DID lookup before any ranking starts, and the AppView's clock is already
running. The budget was first sized against a 10-second ceiling at 7s; in production the AppView hung
up at 4.6–4.7s every time, so that budget never once got its answer back to the client.

On a cache miss the computation is started **detached** and awaited only for the budget. If it lands
in time it is served normally. If it does not, the computation *keeps running and caches its
result*, and the request returns an XRPC error
carrying `Your feed is still being prepared. Pull to refresh in a few seconds.` — which is true,
because the next pull hits the warm cache.

That error is deliberately **429**. The client picks its headline from what it gets back: a timeout
reads as "appears to be offline", and any status it does not recognise reads as "some kind of issue
occurred — please let the feed owner know", both of which blame a cold feed and put a *View profile*
button under it. 429 is the one branch that renders as "temporarily unavailable, please try again
later", with no blame and no button. The AppView passes any non-500 status through unchanged, so both
the status and our message survive the hop, and the message prints beneath the headline.

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

Every served post carries a **`feedContext`** naming the feed and the path that put the post there
([src/algos/feed-context.ts](src/algos/feed-context.ts)):

```
fu-vids-lang;src=cf;lang=1
<rkey>;src=<cf|follows|popular>[;lang=<0|1>]
```

`src` is the collaborative filter, the follows ranking, or the popularity list (the whole feed for a
viewer with no personalization, or the fill under a thin one). `lang` says whether the post declares one
of the viewer's languages, and is present only when the request carried an `Accept-Language`. Clients
hand the context back with every interaction, so all feeds can share one endpoint and still be told
apart:

- reward rows store it in `interactions.feed_context`;
- `interaction_counts` totals every event per day and context, **`interactionSeen` included** — the
  denominator that turns raw likes into likes per view, per feed and per path. A context the service
  could not have issued is neither stored nor counted.

```sql
-- likes and "show less" per thousand views, per feed and path, last 7 days
SELECT feed_context,
       sum(n) FILTER (WHERE event LIKE '%#interactionSeen') AS views,
       round(1000.0 * coalesce(sum(n) FILTER (WHERE event LIKE '%#interactionLike'), 0)
             / NULLIF(sum(n) FILTER (WHERE event LIKE '%#interactionSeen'), 0), 1) AS likes_per_1k,
       round(1000.0 * coalesce(sum(n) FILTER (WHERE event LIKE '%#requestLess'), 0)
             / NULLIF(sum(n) FILTER (WHERE event LIKE '%#interactionSeen'), 0), 1) AS less_per_1k
FROM interaction_counts
WHERE day >= to_char(now() - interval '7 days', 'YYYY-MM-DD')
GROUP BY feed_context ORDER BY feed_context;
```

## Multiple feeds

Content-typed variants (images, video) share the **one** in-memory graph — only a final content filter
differs, so additional feeds add negligible memory. Set `FEEDGEN_IMAGE_FEED_RKEY` /
`FEEDGEN_VIDEO_FEED_RKEY` to the rkeys you publish for them.

Because media is a fraction of all posts, content feeds **over-generate** candidates
(`maxCandidates × FEEDGEN_MEDIA_CANDIDATE_MULTIPLIER`) before applying the media filter, so a photo or
video feed isn't starved by a content-blind candidate cap.

### Ordering by the viewer's languages

`FEEDGEN_VIDEO_LANG_FEED_RKEY` publishes the video feed a second time, **ordered by the viewer's
languages**: the `Accept-Language` the AppView forwards from the client's content-language setting.
Posts that declare one of those languages come first, then everything else — other languages and posts
that declare none — each tier in score order with the usual author spacing, and the per-author cap
counted across both. Nothing is dropped for its language: for a small language the second tier is most
of the feed, and the rest of the viewer's own personalized list is better filler than strangers'
popular posts. A list that is still short is filled from the popularity list, ordered the same way.

Anonymous requests share one cached list, so their languages are ignored; a viewer whose client sends
none gets plain score order. The original feeds are unchanged — their personalized path stays
language-blind and their cold-start list stays *filtered* to the viewer's languages.

It is a separate feed so it can be compared with the language-blind one before replacing it: each logs
`langs=… → N personalized (M in-language) + K popular` per computed list, and `interaction_counts`
(see [Interactions](#interactions)) gives likes per view for both.

## The follows feed

An optional second algorithm on the same service: **the most engaging recent posts from the accounts
you follow**. Set `FEEDGEN_FOLLOWS_FEED_RKEY` to the rkey you publish for it; leave it unset and none
of the machinery below is built.

It is deliberately the inverse of the collaborative filter. The CF feed works out *who* shares your
taste and divides by popularity to surface niche posts; the follows feed takes the audience as given
and lets raw engagement win — the traditional home-feed shape. Both share the same back half
(`ranker/finalize.ts`), so they get identical time-decay, freshness, adult/reply filtering and
per-author diversification.

```
follow list (crawled from the viewer's PDS, once per TTL)
      │
      ▼
author index ──► posts those accounts wrote (and optionally reposted) in the last ~48h,
      │          scored as likes + repostWeight × reposts
      ▼
finalize ──► decay · freshness · adult/reply · diversify ──► ranked URIs
```

### Why a second index, not the like graph

The two structures answer different questions and are sized accordingly:

| | like graph (`graph/csr-like-graph.ts`) | author index (`graph/recent-author-index.ts`) |
|---|---|---|
| Question | "who else liked the posts I liked" | "what did these authors post, and did it land" |
| Needs | every liker's **identity**, 30-day window | a **count** per post, ~48h window |
| Cost | ~500M edges, tens of GB | ~5.6M posts, ~0.5 GB |

Dropping liker identity and shrinking the window is what makes the follows feed cheap to add here —
one to two orders of magnitude below the graph, on the same box. Measured on production at a 48h
window: 36.2M likes fold into 5.64M posts across 756k authors, seeded in 212s. Most of that half
gigabyte is interned post URIs, so the footprint scales with `FEEDGEN_FOLLOWS_WINDOW_HOURS` (the
lever to pull if memory is tight), and a compaction transiently doubles the surviving set while it
rebuilds around it.

It is kept structurally separate rather than bolted onto the CSR build so that the ranker, the index
and the `follows` table lift out as a unit if it ever needs its own process.

The index is filled once from Postgres at boot (hours of likes, not weeks — so this feed comes up
long before a full graph build would finish), then maintained live from the firehose. It has no
rebuild; a periodic compaction drops aged-out posts and reclaims their memory.

### Reposts

Reposts are the second engagement signal, ingested on **their own Jetstream subscription** with their
own cursor — not as a second collection on the like socket. That isolation is deliberate: likes are
the collaborative filter's entire input, and nothing belonging to this feed should be able to stall
it. Set `FEEDGEN_FOLLOWS_REPOST_WEIGHT=0` and the subscription is never opened at all.

They are used two ways:

- **As engagement** (on by default): a post's score is `likes + repostWeight × reposts`, so a repost
  — scarcer and more deliberate than a like — counts for more.
- **As content** (`FEEDGEN_FOLLOWS_INCLUDE_REPOSTS`, on by default): a post reposted *by* someone
  you follow enters the feed even when its author is a stranger — the traditional home-feed
  behaviour. The skeleton carries a `skeletonReasonRepost`, so clients render "Reposted by …"
  rather than showing a stranger with no explanation.

  The attribution travels inside the cached ranked list, which is a flat `string[]` paged by offset
  (see `algos/feed-entry.ts`); at-URIs cannot contain a tab, so that separates the two. Entries
  cached before this existed are bare post URIs and still decode, so no cache invalidation is
  needed on deploy. The repost record's URI is resolved once per finished list rather than held in
  the index — tens of bytes per edge across millions of edges, to answer a question only the
  handful of posts that survive ranking ever ask. An amplified post whose repost record has since
  been swept is dropped rather than served bare: an unattributed stranger is exactly what the
  reason exists to prevent.

`reposts` rows are kept only twice the candidate window (not the 90-day like retention), since
nothing reads them beyond the index seed.

### Coverage

A post enters the index only by being liked or reposted, so a followed account's post with **no
engagement at all anywhere on the network** can never surface. For "bubble the most engaging up" that
is the definition of the feed — but it does mean this is not a complete algorithmic-timeline
replacement.

### Isolation from the collaborative filter

The follows feed shares the `likes` table, `post_meta`, `finalize()` and the Redis ranked-list cache
with the CF feed, and nothing else. Everything it adds is either conditional on
`FEEDGEN_FOLLOWS_FEED_RKEY` being set (the author index, the repost subscription, the `follows` and
`reposts` sweeps) or inert without it (`authorIndex?.` no-ops on the like ingest path). Cache
invalidation is scoped by ranker, so a follow-list sync never drops a viewer's CF list and a like
backfill never drops their follows list.

The one measurable effect on the CF feed is boot ordering: the author index seeds **before** the like
graph builds, because it scans hours where the graph scans weeks. That delays the graph's first build
by the seed's duration (minutes against its own tens of minutes), in exchange for the follows feed
coming up almost immediately rather than waiting the whole build out. Both feeds serve the cold-start
popularity list until their structure is ready. Swap the two blocks in `FeedGenerator.start()` to
reverse the trade.

### Follow lists

Follow edges are **not** ingested from the firehose — that would carry network-wide follow traffic for
the handful of viewers who use the feed. Each viewer's list is crawled from their own PDS
(`com.atproto.repo.listRecords`, public, no auth) on their first request and re-crawled once per
`FEEDGEN_FOLLOWS_SYNC_TTL_SECONDS`, in the same two-stage inline/background shape as the like
backfill. The full background pass is authoritative, so unfollows disappear.

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

## Acknowledgments

The ranking algorithm is **[foryou.club](https://foryou.club/)**, created by
[spacecowboy](https://bsky.app/profile/spacecowboy17.bsky.social) — a trust-based collaborative-filter
recommender. This feed is an independent implementation of the likes-only, Bluesky-specific case of it
(as in spacecowboy's [foryou.club](https://foryou.club) feed): seed from the viewer's recent likes →
co-likers → their recent likes, with path-count smoothing, a popularity penalty, a recency half-life,
and co-rater decay.

Thanks also to **[Graze](https://github.com/graze-social/personalization)**, whose Rust implementation
of the LinkLonk algorithm for Bluesky feeds was a helpful reference.

What this implementation focuses on is **fitting the graph in RAM**. It holds the entire like graph in
memory as a compressed-sparse-row (CSR) layout of typed arrays with an arena-based string interner —
DIDs and URIs are mapped to integer IDs in a chunked byte arena + an open-addressed hash, rather than
JavaScript Maps/objects. That's ~2.5–3× leaner than the same graph built with ordinary JS Maps (the
fallback `arrays` layout), so the full 90-day like graph fits in ~47 GB and the traversal runs
in-process (tens of milliseconds) on a single commodity server. (Graze takes a different tack — the
graph lives in Redis as day-tranched sorted sets, shared across feeds; this keeps it in-process for
single-feed traversal latency.)

## License

MIT. This project builds on [bluesky-social/feed-generator](https://github.com/bluesky-social/feed-generator)
(MIT) — see [LICENSE](LICENSE).
