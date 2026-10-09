import { AppContext } from '../config'
import { hydratePostMeta, readCachedMeta } from './hydrate'
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
  // The viewer's preferred languages, for ordering rather than filtering. When
  // non-empty, posts that declare at least one of them form the first tier and
  // everything else — other languages and posts that declare none — the second.
  // Each tier keeps its score order and author spacing, and the per-author cap
  // counts across both, so an author cannot reappear in the second tier past
  // their cap. Nothing is dropped. Empty/undefined = one tier, plain score order.
  languageTiers?: string[]
  // the requesting viewer's DID. Their own authored posts are dropped so the
  // feed never recommends you back to yourself (a taste-neighbor liking your
  // post makes it a candidate). null/undefined for anonymous viewers.
  viewerDid?: string | null
  // per-feed override of ranking.includeReplies. A reply from a taste-neighbour
  // is usually context-free noise, but a reply from someone you follow often
  // isn't — so the follows feed gets to answer this differently. Undefined
  // leaves the global setting in force.
  includeReplies?: boolean
}

// Chooses which candidates are worth a hydration round-trip.
//
// The main feed hydrates its whole candidate set (maxCandidates, ~1.5k) and is
// fine. Content-typed feeds ask the ranker for maxCandidates ×
// mediaCandidateMultiplier candidates precisely because media is a small slice
// of all posts — measured in production, ~2.6% of an eligible candidate set is
// video. Hydrating all of them meant thousands of getPosts calls per request in
// bounded-concurrency waves, which overran the AppView's feed-fetch timeout and
// left the image/video feeds serving a near-empty list.
//
// post_meta already knows the media kind of most candidates, and that fact is
// immutable, so a stale row classifies just as well as a fresh one (see
// readCachedMeta). Use it to discard non-matching candidates before touching
// the network. Candidates post_meta has never seen cannot be classified without
// a fetch, so they are kept in score order up to a budget — bounding the
// worst case while still letting genuinely-new posts reach the feed. Their
// media kind is checked as usual once hydrated.
//
// Every ranker inserts into rawScores in descending score order, so iterating
// its keys preserves that order and the budget keeps the best unknowns.
const urisToHydrate = async (
  ctx: AppContext,
  rawScores: Map<string, number>,
  opts: FinalizeOptions,
): Promise<string[]> => {
  const all = [...rawScores.keys()]
  if (opts.content === 'all') return all

  const cached = await readCachedMeta(ctx, all)
  const matching: string[] = []
  const unknown: string[] = []
  for (const uri of all) {
    const meta = cached.get(uri)
    if (!meta) {
      unknown.push(uri)
    } else if (opts.content === 'video' ? meta.is_video : meta.is_image) {
      matching.push(uri)
    }
  }

  const budget = ctx.cfg.ranking.mediaUnknownHydrationLimit
  return budget > 0 ? matching.concat(unknown.slice(0, budget)) : matching
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

  const metas = await hydratePostMeta(
    ctx,
    await urisToHydrate(ctx, rawScores, opts),
  )
  const now = Date.now()
  const freshnessMs = cfg.freshnessHours * 60 * 60 * 1000
  const langAllow =
    opts.languages && opts.languages.length > 0 ? new Set(opts.languages) : null
  const preferred =
    opts.languageTiers && opts.languageTiers.length > 0
      ? new Set(opts.languageTiers)
      : null

  const includeReplies = opts.includeReplies ?? cfg.includeReplies

  const scored: Scored[] = []
  for (const [uri, raw] of rawScores) {
    const meta = metas.get(uri)
    if (!meta) continue // unhydratable (deleted/blocked) — drop
    if (opts.viewerDid && meta.author_did === opts.viewerDid) continue // no self-recs
    // Never surface the picker account's onboarding "interest posts": their likes
    // seed personalization and act as co-liker hubs, but the posts themselves are
    // not content. (Their likes are also exempt from the retention sweep.)
    if (ctx.cfg.pickerDid && meta.author_did === ctx.cfg.pickerDid) continue
    if (meta.is_adult) continue
    if (meta.is_reply && !includeReplies) continue // top-level posts only
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
    const tier = preferred && !meta.langs.some((l) => preferred.has(l)) ? 1 : 0
    scored.push({ uri, author: meta.author_did, score, tier })
  }

  // Tier first (always 0 without language tiers), then score.
  scored.sort((a, b) => a.tier - b.tier || b.score - a.score)

  // Diversification: cap each author's total contribution AND space their posts
  // apart so the feed never shows a run of the same author. The cap is taken in
  // the order above, so with language tiers an author's in-language posts claim
  // their slots before anything of theirs in the second tier.
  const perAuthor = new Map<string, number>()
  const tiers: Scored[][] = [[], []]
  for (const item of scored) {
    const n = perAuthor.get(item.author) ?? 0
    if (n >= cfg.perAuthorCap) continue
    perAuthor.set(item.author, n + 1)
    tiers[item.tier].push(item)
  }

  // The spacing state carries across the tier boundary, so the last author of
  // the first tier is not repeated at the start of the second.
  const out: string[] = []
  const lastSlot = new Map<string, number>() // author → slot of their last post
  for (const tier of tiers) emitSpaced(tier, out, lastSlot, cfg)
  return out
}

type Scored = { uri: string; author: string; score: number; tier: number }

// Appends `items` (one tier, in descending score order) to `out`, spacing each
// author's posts at least authorMinGap slots apart, until out reaches
// maxFeedSize.
const emitSpaced = (
  items: Scored[],
  out: string[],
  lastSlot: Map<string, number>,
  cfg: { maxFeedSize: number; authorMinGap: number },
): void => {
  // Bucket per author; appending preserves the descending score order.
  const buckets = new Map<string, Scored[]>()
  for (const item of items) {
    let bucket = buckets.get(item.author)
    if (!bucket) {
      bucket = []
      buckets.set(item.author, bucket)
    }
    bucket.push(item)
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
}
