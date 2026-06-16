import { AppContext, FeedDef } from '../config'

// Resolves a feed record rkey to its definition, or null if not served here.
export const resolveFeed = (ctx: AppContext, rkey: string): FeedDef | null => {
  return ctx.cfg.feeds.find((f) => f.rkey === rkey) ?? null
}

export const listFeeds = (ctx: AppContext): FeedDef[] => ctx.cfg.feeds
