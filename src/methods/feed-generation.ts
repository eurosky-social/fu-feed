import { InvalidRequestError } from '@atproto/xrpc-server'
import { Server } from '../lexicon'
import { AppContext } from '../config'
import { resolveFeed } from '../algos'
import { handler } from '../algos/for-you'
import { validateAuth } from '../auth'
import { AtUri } from '@atproto/syntax'

export default function (server: Server, ctx: AppContext) {
  server.app.bsky.feed.getFeedSkeleton(async ({ params, req }) => {
    const feedUri = new AtUri(params.feed)
    const feed = resolveFeed(ctx, feedUri.rkey)
    if (
      feedUri.hostname !== ctx.cfg.publisherDid ||
      feedUri.collection !== 'app.bsky.feed.generator' ||
      !feed
    ) {
      throw new InvalidRequestError(
        'Unsupported algorithm',
        'UnsupportedAlgorithm',
      )
    }

    // Results are personalized, so read the requesting user's DID from the
    // signed feed-generator JWT. Unauthenticated requests fall back to the
    // cold-start popularity feed rather than being rejected.
    let viewerDid: string | null = null
    try {
      viewerDid = await validateAuth(req, ctx.cfg.serviceDid, ctx.didResolver)
    } catch (err) {
      viewerDid = null
    }

    const body = await handler(ctx, params, viewerDid, feed)
    return {
      encoding: 'application/json',
      body,
    }
  })
}
