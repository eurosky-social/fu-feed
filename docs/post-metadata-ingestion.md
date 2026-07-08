# Post metadata: lazy AppView hydration vs firehose ingestion

## How it works today

The Jetstream subscription ingests **likes only** (`app.bsky.feed.like`, see
`src/subscription.ts`). The `likes` table therefore holds only *edges* —
`(uri, liker_did, subject_uri, created_at, indexed_at)` — with **no post content
and no post metadata**.

Ranking, though, needs metadata a like edge doesn't carry: `createdAt`
(freshness cap), `likeCount` (popularity penalty), moderation labels (adult
filter), embed type (image/video filter), and `langs`. That lives in `post_meta`,
a **lazily-populated cache** hydrated from the public AppView (`getPosts`) the
first time a post becomes a ranking *candidate* (`src/ranker/hydrate.ts`), with a
1-hour freshness TTL. So `post_meta` is not "every liked post" — it's only the
posts that have been candidates (~250K), out of ~16M distinct liked posts in a
90-day window.

**This is why cold computes hit the AppView:** any candidate not in `post_meta`
(or with a row older than the TTL) triggers a `getPosts` fetch.

## Would firehose ingestion remove the AppView dependency?

Mostly yes. Subscribe to `app.bsky.feed.post` in addition to likes; the post
commit record directly carries **`createdAt`, `langs`, and the embed/reply
shape** → `is_image` / `is_video` / `is_quote` / `is_reply`. No AppView call for
any of those.

Two fields are *not* in the post record:

- **`likeCount`** — an AppView aggregate. But foreu **already ingests every
  like**, so it can compute per-post like counts from its own `likes` table. The
  one metric that most needs the AppView today is derivable locally. This is the
  crux of why firehose ingestion is attractive.
- **moderation labels (`is_adult`)** — these come from *labelers*, not the post
  record. Keeping the adult filter would require subscribing to a labeler stream
  (or a residual AppView call just for labels). Dropping it degrades the filter.

### Storage

A `post_meta` row is ~250–350 B all-in (heap + the `uri` PK index).

- Metadata for **every liked post (90d)**: ~16M × ~300 B ≈ **5–8 GB** — trivial
  next to the ~1 TB likes store on the 1.7 TB SSD.
- A candidate must be **< `freshnessHours` (48h) old** to survive `finalize`, so
  metadata is only *useful* for posts from the last ~2 days. The working set is
  **single-digit GB regardless of approach.** Storage is not the constraint.

The real cost of firehose ingestion is throughput, not disk: you'd receive
*every* post network-wide (~millions/day) and discard the ~95% that never get
liked — a second high-volume subscription plus a labeler stream.

## Rejected alternative: eager per-like hydration

"For each like ingested, `getPosts` the subject" is strictly worse than the
current lazy model: it turns hydration into millions of AppView calls/day,
sustained, straight into the same rate limits. Lazy hydration only ever fetches
the ~16M posts that actually become candidates, not all of them.

## Recommendation

- **Now:** stay lazy. Cold-compute latency is addressable with cheap knobs
  (hydration TTL, `maxCandidates`, co-liker-backfill throttle) and by caching the
  cold-start popularity list (see below) — no ingest/storage change needed.
- **Later (if AppView hydration becomes a real scaling bottleneck):** ingest
  `app.bsky.feed.post` from the firehose, self-compute `likeCount` from the
  `likes` table, and add a labeler subscription for `is_adult`. Storage stays
  single-digit GB (48h working set). A real project, worth it only once traffic
  justifies it.

## Related: the cold-start popularity query is the real first-load bottleneck

Empirically, the ~16s "feed unavailable" on a **first/unpersonalized load** is
dominated not by hydration but by the popularity fallback's aggregation
(`src/ranker/popularity.ts`):

```sql
SELECT subject_uri, count(*) FROM likes
WHERE indexed_at > <freshnessHours ago>
GROUP BY subject_uri ORDER BY likes DESC LIMIT maxCandidates
```

That GROUP-BY scans tens of millions of like rows on every cold run. **Only
unpersonalized viewers hit it** — personalized viewers use the in-memory graph
(`GraphRanker`), which is fast. Note `maxCandidates` only caps the output, not
the rows aggregated, so lowering it does **not** speed this up.

The effective fix is to compute the popularity list **once, globally** (it is
viewer-independent apart from the language bias applied later in `finalize`) on a
short schedule and have all cold-start viewers read the cached list — turning
each cold-start load into a cheap slice + warm hydration. This would remove the
first-load timeout without waiting for the co-liker backfill to self-disable
(~90 days of ingestion) or for accounts to accrue personalization signal.
