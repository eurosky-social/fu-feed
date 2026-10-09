import { AppContext } from '../config'

// Content restriction applied to a feed's results.
export type ContentFilter = 'all' | 'image' | 'video'

// Per-request inputs a ranker may honour beyond the viewer and content filter.
export type RankOptions = {
  // The viewer's preferred languages (normalized primary subtags, preference
  // order). When non-empty, results declaring one of them are ordered ahead of
  // the rest — see FinalizeOptions.languageTiers. Empty or absent: no ordering.
  languageTiers?: string[]
}

// Turns a viewer into an ordered list of post URIs for a given content filter.
export interface Ranker {
  rank(
    ctx: AppContext,
    viewerDid: string | null,
    content: ContentFilter,
    opts?: RankOptions,
  ): Promise<string[]>
}

export type CandidateMeta = {
  uri: string
  author_did: string
  created_at: string
  like_count: number
  is_quote: boolean
  is_adult: boolean
  is_reply: boolean
  is_image: boolean
  is_video: boolean
  // normalized primary BCP-47 language subtags declared on the post (e.g.
  // ['en', 'de']); empty when the post declares no language.
  langs: string[]
}
