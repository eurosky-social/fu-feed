import express from 'express'
import { AppContext } from '../config'
import { validateAuth } from '../auth'
import { addSeen } from '../redis'
import { recordInteractions, REWARD_WEIGHTS, RewardRow } from '../interactions'

const SEEN_EVENT = 'app.bsky.feed.defs#interactionSeen'

// app.bsky.feed.sendInteractions — the AppView proxies client interaction
// events with the viewer's signed service JWT. interactionSeen drives the
// unseen-only feed; like/repost/requestMore/clickthrough/… and the negative
// requestLess are recorded with a signed weight in the interactions table as a
// durable reward signal for tuning. The reward signal is collected only — it
// does not yet feed back into ranking. Not in the bundled lexicon, so it's
// wired as a plain XRPC route.
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
        const rewards: RewardRow[] = []
        const now = new Date().toISOString()

        for (const it of interactions) {
          const event = it?.event
          const item = it?.item
          if (typeof event !== 'string' || typeof item !== 'string') continue

          if (event === SEEN_EVENT) {
            seen.push(item)
            continue
          }

          const weight = REWARD_WEIGHTS[event]
          if (weight === undefined) continue // non-reward / unknown event
          rewards.push({
            viewer_did: viewerDid,
            subject_uri: item,
            event,
            weight,
            created_at: now,
          })
        }

        if (seen.length > 0) await addSeen(ctx.redis, viewerDid, seen)
        if (rewards.length > 0) await recordInteractions(ctx.db, rewards)
      }

      // sendInteractions has an empty response body
      res.json({})
    },
  )
}
