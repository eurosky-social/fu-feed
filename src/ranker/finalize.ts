import { AppContext } from '../config'
import { hydratePostMeta } from './hydrate'
import { ContentFilter } from './types'

export type FinalizeOptions = {
  // divide score by likeCount^beta to surface niche content; cold-start
  // popularity leaves this off so popular posts can win.
  applyPopularityPenalty: boolean
  // restrict results to a media type (image/video) for content-typed variants
  content: ContentFilter
  // cold-start language allowlist (normalized primary BCP-47 subtags). When
  // non-empty, a post survives only if it declares no language or shares at
  // least one with the allowlist — undeclared posts always pass, so the feed
  // biases toward these languages without starving. Empty/undefined = off.
  languages?: string[]
  // the requesting viewer's DID. Their own authored posts are dropped so the
  // feed never recommends you back to yourself (a taste-neighbor liking your
  // post makes it a candidate). null/undefined for anonymous viewers.
  viewerDid?: string | null
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
  const langAllow =
    opts.languages && opts.languages.length > 0 ? new Set(opts.languages) : null

  const scored: { uri: string; author: string; score: number }[] = []
  for (const [uri, raw] of rawScores) {
    const meta = metas.get(uri)
    if (!meta) continue // unhydratable (deleted/blocked) — drop
    if (opts.viewerDid && meta.author_did === opts.viewerDid) continue // no self-recs
    if (meta.is_adult) continue
    if (meta.is_reply && !cfg.includeReplies) continue // top-level posts only
    if (opts.content === 'image' && !meta.is_image) continue
    if (opts.content === 'video' && !meta.is_video) continue
    // Language allowlist: undeclared posts pass; declared ones must overlap.
    if (
      langAllow &&
      meta.langs.length > 0 &&
      !meta.langs.some((l) => langAllow.has(l))
    )
      continue

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

  // Diversification: cap each author's total contribution AND space their posts
  // apart so the feed never shows a run of the same author. Bucket per author in
  // descending score order (scored is already sorted, so appending preserves
  // it), capped at perAuthorCap.
  const buckets = new Map<string, { uri: string; score: number }[]>()
  for (const item of scored) {
    let bucket = buckets.get(item.author)
    if (!bucket) {
      bucket = []
      buckets.set(item.author, bucket)
    }
    if (bucket.length < cfg.perAuthorCap) bucket.push(item)
  }

  // Emit by repeatedly taking the highest-scoring available post whose author
  // hasn't appeared within the last `authorMinGap` slots. If every remaining
  // author is inside that window (e.g. only one author is left), relax the gap
  // and take the best available anyway — spacing is best-effort and never a
  // reason to drop otherwise-eligible content.
  const heads = [...buckets.entries()].map(([author, items]) => ({
    author,
    items,
    ptr: 0,
  }))
  const lastSlot = new Map<string, number>() // author → slot of their last post
  const out: string[] = []
  while (out.length < cfg.maxFeedSize) {
    let best: (typeof heads)[number] | null = null
    let fallback: (typeof heads)[number] | null = null
    for (const h of heads) {
      if (h.ptr >= h.items.length) continue
      const score = h.items[h.ptr].score
      if (!fallback || score > fallback.items[fallback.ptr].score) fallback = h
      const last = lastSlot.get(h.author)
      if (last !== undefined && out.length - last <= cfg.authorMinGap) continue
      if (!best || score > best.items[best.ptr].score) best = h
    }
    const chosen = best ?? fallback
    if (!chosen) break // all buckets drained
    out.push(chosen.items[chosen.ptr].uri)
    chosen.ptr++
    lastSlot.set(chosen.author, out.length - 1)
  }

  return out
}
