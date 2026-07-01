import { AppContext } from '../config'

// Content restriction applied to a feed's results.
export type ContentFilter = 'all' | 'image' | 'video'

// Turns a viewer into an ordered list of post URIs for a given content filter.
export interface Ranker {
  rank(
    ctx: AppContext,
    viewerDid: string | null,
    content: ContentFilter,
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
