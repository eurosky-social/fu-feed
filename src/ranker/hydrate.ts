import { Selectable } from 'kysely'
import { AppContext } from '../config'
import { PostMeta } from '../db/schema'
import { CandidateMeta } from './types'

const GET_POSTS_CHUNK = 25 // app.bsky.feed.getPosts max uris per call
const ADULT_LABELS = new Set(['porn', 'sexual', 'nudity'])

// Postgres caps a single statement at 65535 bind parameters (the wire protocol
// uses an int16 count). Content-typed feeds over-fetch maxCandidates ×
// mediaCandidateMultiplier URIs (tens of thousands), so both the cache read
// (1 param/uri) and the write-back (11 params/row) must be chunked or the
// statement overflows and throws. Keep each batch well under the limit.
const DB_READ_CHUNK = 10000 // `uri in (...)` — 1 param/uri, safely under 65535
const DB_WRITE_CHUNK = 2000 // 2000 rows × 11 cols = 22000 params, under 65535
// Bound the getPosts fan-out: 24k candidates / 25 = ~960 chunks, and firing them
// all at once hammers the public AppView (socket exhaustion / rate limits).
const APPVIEW_CONCURRENCY = 20

// Abandon an individual getPosts call after this long.
//
// Measured against public.api.bsky.app, 120 calls at this concurrency:
// p50 150ms, p90 550ms, p99 880ms — and one call in 120 that hung for 30.6s,
// with no 429s and no errors. The AppView is not throttling us; roughly 1% of
// requests simply never come back in reasonable time.
//
// That single straggler is what made hydration slow. Any timeout well above p99
// costs effectively nothing and removes the tail.
const APPVIEW_REQUEST_TIMEOUT_MS = 5000

// Splits an array into fixed-size batches (the last may be shorter).
const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// Reads whatever post_meta already holds for these URIs. Local only — never
// calls the AppView, and applies no TTL.
const readCachedRows = async (
  ctx: AppContext,
  uris: string[],
): Promise<Map<string, Selectable<PostMeta>>> => {
  const byUri = new Map<string, Selectable<PostMeta>>()
  for (const batch of chunk(uris, DB_READ_CHUNK)) {
    const rows = await ctx.db
      .selectFrom('post_meta')
      .selectAll()
      .where('uri', 'in', batch)
      .execute()
    for (const row of rows) byUri.set(row.uri, row)
  }
  return byUri
}

// Classification-only lookup: what post_meta already knows, ignoring the
// hydration TTL, with no network calls. Sound because every field except
// like_count is immutable for a given post — a post's author, creation time,
// media kind, reply-ness, language and labels do not change — so a stale row
// classifies just as well as a fresh one. Callers that need an accurate
// like_count must still run the URIs they keep through hydratePostMeta.
export const readCachedMeta = async (
  ctx: AppContext,
  uris: string[],
): Promise<Map<string, CandidateMeta>> => {
  const out = new Map<string, CandidateMeta>()
  if (uris.length === 0) return out
  const rows = await readCachedRows(ctx, [...new Set(uris)])
  for (const [uri, row] of rows) out.set(uri, toCandidateMeta(row))
  return out
}

// Resolves metadata (createdAt / global likeCount / labels / quote-ness) for a
// set of candidate post URIs. Hits the local post_meta cache first and only
// calls the public AppView for misses or stale rows, then writes results back.
export const hydratePostMeta = async (
  ctx: AppContext,
  uris: string[],
): Promise<Map<string, CandidateMeta>> => {
  const out = new Map<string, CandidateMeta>()
  if (uris.length === 0) return out

  const unique = [...new Set(uris)]
  const cachedByUri = await readCachedRows(ctx, unique)

  const freshCutoff = Date.now() - ctx.cfg.ranking.hydrationTtlMs
  const stale: string[] = []

  for (const uri of unique) {
    const row = cachedByUri.get(uri)
    if (row && Date.parse(row.hydrated_at) >= freshCutoff) {
      out.set(uri, toCandidateMeta(row))
    } else {
      // A stale row is still a usable answer: every field except like_count is
      // immutable for a given post (see readCachedMeta). Seed `out` with it and
      // let the refetch below overwrite it if it gets that far. Without this,
      // a candidate whose row merely aged past hydrationTtlMs (1h) was dropped
      // from the feed unless the AppView answered — which is what made a
      // request either block on thousands of getPosts calls or serve nothing.
      if (row) out.set(uri, toCandidateMeta(row))
      stale.push(uri)
    }
  }

  if (stale.length === 0) return out

  const hydrated = await fetchFromAppview(ctx, stale)
  if (hydrated.length > 0) {
    const hydratedAt = new Date().toISOString()
    // Chunk the write-back: POST_META_COLUMNS params/row means a single insert
    // of every hydrated candidate would blow past Postgres's 65535 param cap.
    for (const batch of chunk(hydrated, DB_WRITE_CHUNK)) {
      await ctx.db
        .insertInto('post_meta')
        .values(
          batch.map((m) => ({
            uri: m.uri,
            author_did: m.author_did,
            created_at: m.created_at,
            like_count: m.like_count,
            is_quote: m.is_quote ? 1 : 0,
            is_adult: m.is_adult ? 1 : 0,
            is_reply: m.is_reply ? 1 : 0,
            is_image: m.is_image ? 1 : 0,
            is_video: m.is_video ? 1 : 0,
            langs: m.langs.join(','),
            hydrated_at: hydratedAt,
          })),
        )
        .onConflict((oc) =>
          oc.column('uri').doUpdateSet((eb) => ({
            author_did: eb.ref('excluded.author_did'),
            created_at: eb.ref('excluded.created_at'),
            like_count: eb.ref('excluded.like_count'),
            is_quote: eb.ref('excluded.is_quote'),
            is_adult: eb.ref('excluded.is_adult'),
            is_reply: eb.ref('excluded.is_reply'),
            is_image: eb.ref('excluded.is_image'),
            is_video: eb.ref('excluded.is_video'),
            langs: eb.ref('excluded.langs'),
            hydrated_at: eb.ref('excluded.hydrated_at'),
          })),
        )
        .execute()
    }

    for (const m of hydrated) out.set(m.uri, m)
  }

  return out
}

const fetchFromAppview = async (
  ctx: AppContext,
  uris: string[],
): Promise<CandidateMeta[]> => {
  const results: CandidateMeta[] = []
  const postChunks = chunk(uris, GET_POSTS_CHUNK)

  // Stop fetching once the budget is spent and serve what we have. A media feed
  // over-generates maxCandidates × mediaCandidateMultiplier (4000 by default)
  // candidates, and on a cold post_meta essentially all of them need fetching:
  // 1500 URIs is 60 getPosts calls, which the public AppView throttles hard
  // enough that a single request was measured at 116s and the PDS gave up on it
  // with a 502 long before that. A thinner feed is strictly better than a feed
  // that times out — and thanks to the write-back below, each request that ends
  // early still leaves post_meta warmer for the next one.
  const deadline = Date.now() + ctx.cfg.ranking.hydrationDeadlineMs

  // A fixed pool of workers pulling from a shared cursor, rather than
  // Promise.all over fixed waves of APPVIEW_CONCURRENCY.
  //
  // Waves are a barrier: the wave takes as long as its slowest member, so one
  // 30s straggler left 19 workers idle and stalled every chunk behind it. With
  // ~1% of calls hanging (see APPVIEW_REQUEST_TIMEOUT_MS), a 60-chunk request
  // hit that on most runs — which is what turned a job worth about a second of
  // work into the ~110s that made the PDS give up with a 502.
  const responses: any[][] = []
  let next = 0
  let timedOut = 0
  const worker = async (): Promise<void> => {
    while (true) {
      if (Date.now() > deadline) return
      const i = next++
      if (i >= postChunks.length) return
      const uriChunk = postChunks[i]
      const controller = new AbortController()
      const timer = setTimeout(
        () => controller.abort(),
        APPVIEW_REQUEST_TIMEOUT_MS,
      )
      try {
        const res = await ctx.publicAgent.app.bsky.feed.getPosts(
          { uris: uriChunk },
          { signal: controller.signal },
        )
        responses.push(res.data.posts)
      } catch (err) {
        if (controller.signal.aborted) timedOut++
        else console.error('getPosts hydration failed', err)
      } finally {
        clearTimeout(timer)
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(APPVIEW_CONCURRENCY, postChunks.length) }, () =>
      worker(),
    ),
  )
  if (next < postChunks.length || timedOut > 0) {
    console.warn(
      `[foryou] hydration incomplete — ${responses.length}/${postChunks.length} chunks fetched` +
        (timedOut > 0 ? `, ${timedOut} timed out` : '') +
        (next < postChunks.length ? ' (deadline)' : ''),
    )
  }

  for (const posts of responses) {
    for (const post of posts as any[]) {
      const record = (post.record ?? {}) as Record<string, unknown>
      const createdAt =
        typeof record.createdAt === 'string' &&
        !isNaN(Date.parse(record.createdAt))
          ? record.createdAt
          : new Date().toISOString()
      results.push({
        uri: post.uri,
        author_did: post.author?.did ?? authorFromUri(post.uri),
        created_at: createdAt,
        like_count: typeof post.likeCount === 'number' ? post.likeCount : 0,
        is_quote: isQuote(post),
        is_adult: hasAdultLabel(post),
        is_reply: !!record.reply,
        is_image: hasMedia(post, 'images'),
        is_video: hasMedia(post, 'video'),
        langs: normalizeLangs(record.langs),
      })
    }
  }

  return results
}

const isQuote = (post: any): boolean => {
  const type: unknown = post?.embed?.$type
  return typeof type === 'string' && type.startsWith('app.bsky.embed.record')
}

// Detects an images/video embed, including the media side of recordWithMedia.
const hasMedia = (post: any, kind: 'images' | 'video'): boolean => {
  const want = `app.bsky.embed.${kind}#view`
  const embed = post?.embed
  const type: unknown = embed?.$type
  if (type === want) return true
  if (type === 'app.bsky.embed.recordWithMedia#view') {
    return embed?.media?.$type === want
  }
  return false
}

const hasAdultLabel = (post: any): boolean => {
  const labels = post?.labels
  if (!Array.isArray(labels)) return false
  return labels.some((l) => ADULT_LABELS.has(l?.val))
}

// Normalizes a post record's `langs` to deduped primary BCP-47 subtags:
// lowercased, region/script stripped ('pt-BR' -> 'pt'). Ignores malformed
// entries. Returns [] when the post declares no usable language.
const normalizeLangs = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const primary = entry.split('-')[0].trim().toLowerCase()
    if (!primary || seen.has(primary)) continue
    seen.add(primary)
    out.push(primary)
  }
  return out
}

const authorFromUri = (uri: string): string => {
  // at://<did>/app.bsky.feed.post/<rkey>
  const match = uri.match(/^at:\/\/([^/]+)\//)
  return match ? match[1] : ''
}

const toCandidateMeta = (row: {
  uri: string
  author_did: string
  created_at: string
  like_count: number
  is_quote: number
  is_adult: number
  is_reply: number
  is_image: number
  is_video: number
  langs: string
}): CandidateMeta => ({
  uri: row.uri,
  author_did: row.author_did,
  created_at: row.created_at,
  like_count: row.like_count,
  is_quote: row.is_quote === 1,
  is_adult: row.is_adult === 1,
  is_reply: row.is_reply === 1,
  is_image: row.is_image === 1,
  is_video: row.is_video === 1,
  langs: row.langs ? row.langs.split(',').filter(Boolean) : [],
})
