import express from 'express'
import { AppContext } from '../config'
import { validateAuth } from '../auth'
import { addSeen } from '../redis'

const SEEN_EVENT = 'app.bsky.feed.defs#interactionSeen'

// app.bsky.feed.sendInteractions — receives client interaction events (the
// AppView proxies them with the viewer's signed service JWT). interactionSeen
// events are recorded so the feed can serve unseen posts only. This method
// isn't in the bundled lexicon snapshot, so it's wired as a plain XRPC route.
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

      const interactions = Array.isArray(req.body?.interactions)
        ? req.body.interactions
        : []
      if (viewerDid) {
        const seen: string[] = []
        for (const it of interactions) {
          if (it?.event === SEEN_EVENT && typeof it?.item === 'string') {
            seen.push(it.item)
          }
        }
        if (seen.length > 0) {
          await addSeen(ctx.redis, viewerDid, seen)
        }
      }

      // sendInteractions has an empty response body
      res.json({})
    },
  )
}
