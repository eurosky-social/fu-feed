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

    // The AppView forwards the client's content-language preference here; it's
    // the only per-viewer taste signal available for a brand-new account with
    // no likes, so it seeds the cold-start feed's language bias.
    const viewerLangs = parseAcceptLanguage(req.headers['accept-language'])

    const body = await handler(ctx, params, viewerDid, feed, viewerLangs)
    return {
      encoding: 'application/json',
      body,
    }
  })
}

// Parses an Accept-Language header ('fr-CH, fr;q=0.9, en;q=0.8, *;q=0.5') into
// deduped primary BCP-47 subtags in descending q-order ('pt-BR' -> 'pt'). The
// wildcard '*' and malformed entries are dropped. Returns [] when absent/empty,
// which leaves the cold-start feed global.
const parseAcceptLanguage = (header?: string): string[] => {
  if (!header) return []
  const ranked = header
    .split(',')
    .map((part) => {
      const [tag, ...paramParts] = part.trim().split(';')
      const primary = tag.split('-')[0].trim().toLowerCase()
      const qParam = paramParts
        .map((p) => p.trim())
        .find((p) => p.startsWith('q='))
      const q = qParam ? parseFloat(qParam.slice(2)) : 1
      return { primary, q: isNaN(q) ? 0 : q }
    })
    .filter((e) => e.primary && e.primary !== '*' && e.q > 0)
    .sort((a, b) => b.q - a.q)

  const out: string[] = []
  const seen = new Set<string>()
  for (const { primary } of ranked) {
    if (seen.has(primary)) continue
    seen.add(primary)
    out.push(primary)
  }
  return out
}
