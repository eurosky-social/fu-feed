import express from 'express'
import { AppContext } from '../config'
import { validateAuth } from '../auth'
import { addSeen } from '../redis'
import {
  parseInteractions,
  recordInteractionCounts,
  recordInteractions,
} from '../interactions'

// app.bsky.feed.sendInteractions — the AppView proxies client interaction
// events with the viewer's signed service JWT. interactionSeen drives the
// unseen-only feed; like/repost/requestMore/clickthrough/… and the negative
// requestLess are recorded with a signed weight in the interactions table as a
// durable reward signal for tuning. Every event that comes back with one of
// this service's feed contexts is also totalled per day and context, views
// included, so engagement can be compared across feeds and the paths through
// them. The reward signal is collected only — it does not yet feed back into
// ranking. Not in the bundled lexicon, so it's wired as a plain XRPC route.
export default function (app: express.Application, ctx: AppContext) {
  app.post(
    '/xrpc/app.bsky.feed.sendInteractions',
    express.json({ limit: '500kb' }),
    async (req, res) => {
      let viewerDid: string | null = null
      try {
        viewerDid = await validateAuth(req, ctx.cfg.serviceDid, ctx.didResolver)
      } catch {
        viewerDid = null
      }

      if (viewerDid) {
        const { seen, rewards, counts } = parseInteractions(
          viewerDid,
          req.body?.interactions,
          new Date(),
        )
        if (seen.length > 0) await addSeen(ctx.redis, viewerDid, seen)
        await recordInteractions(ctx.db, rewards)
        await recordInteractionCounts(ctx.db, counts)
      }

      // sendInteractions has an empty response body
      res.json({})
    },
  )
}
