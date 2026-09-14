export type DatabaseSchema = {
  likes: Like
  reposts: Repost
  post_meta: PostMeta
  follows: Follow
  seen: Seen
  interactions: Interaction
  sub_state: SubState
}

// One row per like record off the firehose. This bipartite (liker -> post)
// edge table is the substrate for the collaborative-filter ranker.
export type Like = {
  // the like record's own at-uri: at://<liker>/app.bsky.feed.like/<rkey>
  uri: string
  // the DID of the user who created the like
  liker_did: string
  // the liked post's at-uri: at://<author>/app.bsky.feed.post/<rkey>
  subject_uri: string
  // record createdAt (ISO 8601), as authored
  created_at: string
  // when we ingested the like (ISO 8601); used for pruning + recency windows
  indexed_at: string
}

// Lazily-hydrated metadata for posts that show up as ranking candidates.
// Populated on demand from the public AppView's getPosts.
export type PostMeta = {
  uri: string
  author_did: string
  // post record createdAt (ISO 8601)
  created_at: string
  // global like count from the AppView at hydration time
  like_count: number
  // 1 if the post quotes another record (used for diversification)
  is_quote: number
  // 1 if the post carries an adult/sexual self- or moderation label
  is_adult: number
  // 1 if the post is a reply (the feed serves top-level posts only)
  is_reply: number
  // media flags for content-typed feed variants
  is_image: number
  is_video: number
  // declared post languages: normalized primary BCP-47 subtags, comma-joined
  // (e.g. 'en,de'); '' when the post declares none. Feeds the cold-start
  // language allowlist.
  langs: string
  // when this metadata was last refreshed (ISO 8601)
  hydrated_at: string
}

// One row per repost record off the firehose, ingested only when a follows feed
// is configured (see FollowsConfig.repostWeight). Reposts are a second, scarcer
// engagement signal on a post, and — when the follows feed opts in — a way for a
// stranger's post to enter the feed because someone you follow amplified it.
// The collaborative filter does not read this table.
export type Repost = {
  // the repost record's own at-uri: at://<reposter>/app.bsky.feed.repost/<rkey>
  uri: string
  // the DID of the user who reposted
  reposter_did: string
  // the reposted post's at-uri
  subject_uri: string
  // record createdAt (ISO 8601), as authored
  created_at: string
  // when we ingested the repost (ISO 8601)
  indexed_at: string
}

// A viewer's follow edges, crawled from their PDS on demand — the follows
// feed's audience definition. Unlike `likes` this is NOT network-wide: only
// viewers who have actually asked for the feed are in here, and only up to
// FollowsConfig.maxFollows each.
export type Follow = {
  viewer_did: string
  // the followed account's DID (app.bsky.graph.follow's subject is a bare DID)
  subject_did: string
  // the follow record's createdAt (ISO 8601), as authored
  created_at: string
  // when we crawled it (ISO 8601)
  indexed_at: string
}

// Optional: posts a viewer has already been shown, fed by interactionSeen.
// Reserved for a later phase; written defensively, read if present.
export type Seen = {
  viewer_did: string
  subject_uri: string
  seen_at: string
}

// Reward signal from app.bsky.feed.sendInteractions: positive events
// (like/repost/requestMore/clickthrough/…) and the explicit negative
// (requestLess) on served posts, kept durably so ranking parameters can be
// evaluated/tuned against real engagement.
export type Interaction = {
  viewer_did: string
  subject_uri: string
  // the interaction event token (app.bsky.feed.defs#…)
  event: string
  // signed reward weight (positive = good, negative = "less like this")
  weight: number
  // when we received it (ISO 8601)
  created_at: string
}

export type SubState = {
  service: string
  cursor: number
}
