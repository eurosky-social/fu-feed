import { AppContext } from '../config'
import { hydratePostMeta } from './hydrate'
import { ContentFilter } from './types'

export type FinalizeOptions = {
  // divide score by likeCount^beta to surface niche content; cold-start
  // popularity leaves this off so popular posts can win.
  applyPopularityPenalty: boolean
  // restrict results to a media type (image/video) for content-typed variants
  content: ContentFilter
}

// Shared back half of every ranker: hydrate candidate metadata, apply
// time-decay + freshness cap + adult/reply/content filters + popularity
// penalty, then diversify per author and return the ordered URI list.
export const finalize = async (
  ctx: AppContext,
  rawScores: Map<string, number>,
  opts: FinalizeOptions,
): Promise<string[]> => {
  const cfg = ctx.cfg.ranking
  if (rawScores.size === 0) return []

  const metas = await hydratePostMeta(ctx, [...rawScores.keys()])
  const now = Date.now()
  const freshnessMs = cfg.freshnessHours * 60 * 60 * 1000

  const scored: { uri: string; author: string; score: number }[] = []
  for (const [uri, raw] of rawScores) {
    const meta = metas.get(uri)
    if (!meta) continue // unhydratable (deleted/blocked) — drop
    if (meta.is_adult) continue
    if (meta.is_reply && !cfg.includeReplies) continue // top-level posts only
    if (opts.content === 'image' && !meta.is_image) continue
    if (opts.content === 'video' && !meta.is_video) continue

    const age = now - Date.parse(meta.created_at)
    if (isNaN(age) || age > freshnessMs) continue
    const ageHours = Math.max(0, age) / (60 * 60 * 1000)

    const decay = Math.pow(0.5, ageHours / cfg.halfLifeHours)
    let score = raw * decay
    if (opts.applyPopularityPenalty) {
      score /= Math.pow(Math.max(1, meta.like_count), cfg.popularityPenalty)
    }
    scored.push({ uri, author: meta.author_did, score })
  }

  scored.sort((a, b) => b.score - a.score)

  // Diversification: cap how many posts a single author can contribute.
  const perAuthor = new Map<string, number>()
  const out: string[] = []
  for (const item of scored) {
    const count = perAuthor.get(item.author) ?? 0
    if (count >= cfg.perAuthorCap) continue
    perAuthor.set(item.author, count + 1)
    out.push(item.uri)
    if (out.length >= cfg.maxFeedSize) break
  }

  return out
}
