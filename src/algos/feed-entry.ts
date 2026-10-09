import { SkeletonFeedPost } from '../lexicon/types/app/bsky/feed/defs'

// One entry in a cached ranked list: the post URI, plus — when the post reached
// the viewer because someone they follow amplified it — the repost record that
// put it there, plus the feed context the post is served with.
//
// The per-viewer list is cached in Redis as a flat string[] and served by slicing
// an offset into it, so both have to travel inside the string rather than
// alongside it. at-URIs cannot contain a tab, which makes it an unambiguous
// separator: `post`, `post\trepost`, or `post\trepost\tcontext` with an empty
// repost field when there is none. Entries written before either existed are
// bare post URIs, and ones written before the context existed have two fields;
// both decode with the parts they lack absent, so an in-flight cache needs no
// invalidation.
const SEP = '\t'

export const encodeEntry = (
  postUri: string,
  repostUri?: string,
  context?: string,
): string => {
  if (context) return `${postUri}${SEP}${repostUri ?? ''}${SEP}${context}`
  return repostUri ? `${postUri}${SEP}${repostUri}` : postUri
}

type Entry = { post: string; repost?: string; context?: string }

const decode = (entry: string): Entry => {
  const [post, repost, context] = entry.split(SEP)
  return { post, repost: repost || undefined, context: context || undefined }
}

// The post URI alone — what the seen-set and every other consumer keys on.
export const postUriOf = (entry: string): string => {
  const i = entry.indexOf(SEP)
  return i < 0 ? entry : entry.slice(0, i)
}

// The same entry carrying `context` in place of whatever it had.
export const withContext = (entry: string, context: string): string => {
  const { post, repost } = decode(entry)
  return encodeEntry(post, repost, context)
}

// The entry as the feed skeleton serves it. A `reason` makes clients render
// "Reposted by …" instead of presenting a stranger's post with no explanation.
// `feedContext` is passed through the AppView to the client, which sends it
// back with every interaction it reports on the post (see interactions.ts).
export const toSkeletonPost = (entry: string): SkeletonFeedPost => {
  const { post, repost, context } = decode(entry)
  const out: SkeletonFeedPost = { post }
  if (repost) {
    out.reason = {
      $type: 'app.bsky.feed.defs#skeletonReasonRepost',
      repost,
    }
  }
  // The bundled lexicon predates feedContext; the field is an optional string
  // on skeletonFeedPost upstream, and response validation passes it through.
  if (context) out.feedContext = context
  return out
}
