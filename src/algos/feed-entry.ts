import { SkeletonFeedPost } from '../lexicon/types/app/bsky/feed/defs'

// One entry in a cached ranked list: the post URI, plus — when the post reached
// the viewer because someone they follow amplified it — the repost record that
// put it there.
//
// The per-viewer list is cached in Redis as a flat string[] and served by slicing
// an offset into it, so the attribution has to travel inside the string rather
// than alongside it. at-URIs cannot contain a tab, which makes it an unambiguous
// separator. Entries written before this existed are bare post URIs and decode
// with no reason, so an in-flight cache needs no invalidation.
const SEP = '\t'

export const encodeEntry = (postUri: string, repostUri?: string): string =>
  repostUri ? `${postUri}${SEP}${repostUri}` : postUri

// The post URI alone — what the seen-set and every other consumer keys on.
export const postUriOf = (entry: string): string => {
  const i = entry.indexOf(SEP)
  return i < 0 ? entry : entry.slice(0, i)
}

// The entry as the feed skeleton serves it. A `reason` makes clients render
// "Reposted by …" instead of presenting a stranger's post with no explanation.
export const toSkeletonPost = (entry: string): SkeletonFeedPost => {
  const i = entry.indexOf(SEP)
  if (i < 0) return { post: entry }
  return {
    post: entry.slice(0, i),
    reason: {
      $type: 'app.bsky.feed.defs#skeletonReasonRepost',
      repost: entry.slice(i + 1),
    },
  }
}
