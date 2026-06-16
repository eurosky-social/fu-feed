import { Redis } from 'ioredis'

export const createRedis = (url: string): Redis => {
  return new Redis(url, {
    // Don't crash the process on a transient Redis blip; the ranked-list cache
    // is best-effort and the ranker degrades to recomputing on a miss.
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  })
}

// Stores a ranked list of post URIs for a viewer (or the shared cold-start
// list). The cursor passed back to clients is just an offset into this list.
export const cacheRankedList = async (
  redis: Redis,
  key: string,
  uris: string[],
  ttlSeconds: number,
): Promise<void> => {
  try {
    await redis.set(key, JSON.stringify(uris), 'EX', ttlSeconds)
  } catch (err) {
    console.error('redis cache write failed', err)
  }
}

export const getRankedList = async (
  redis: Redis,
  key: string,
): Promise<string[] | null> => {
  try {
    const raw = await redis.get(key)
    if (!raw) return null
    return JSON.parse(raw) as string[]
  } catch (err) {
    console.error('redis cache read failed', err)
    return null
  }
}

export const rankedListKey = (feed: string, viewerDid: string | null): string => {
  return `foryou:ranked:${feed}:${viewerDid ?? 'anon'}`
}

// Recently-seen posts per viewer (shared across feeds), reported by clients via
// sendInteractions. The feed serves unseen posts only, so a refresh brings new
// content. A timestamp-scored sorted set keeps it bounded to a recent window.
const SEEN_WINDOW_MS = 48 * 60 * 60 * 1000
const SEEN_KEY_TTL_SECONDS = 3 * 24 * 60 * 60

const seenKey = (viewerDid: string): string => `foryou:seen:${viewerDid}`

export const getSeen = async (
  redis: Redis,
  viewerDid: string,
): Promise<Set<string>> => {
  try {
    const cutoff = Date.now() - SEEN_WINDOW_MS
    const members = await redis.zrangebyscore(seenKey(viewerDid), cutoff, '+inf')
    return new Set(members)
  } catch (err) {
    console.error('redis seen read failed', err)
    return new Set()
  }
}

export const addSeen = async (
  redis: Redis,
  viewerDid: string,
  uris: string[],
): Promise<void> => {
  if (uris.length === 0) return
  try {
    const key = seenKey(viewerDid)
    const now = Date.now()
    const args: (string | number)[] = []
    for (const u of uris) args.push(now, u)
    await redis.zadd(key, ...(args as [number, string]))
    await redis.expire(key, SEEN_KEY_TTL_SECONDS)
    await redis.zremrangebyscore(key, '-inf', now - SEEN_WINDOW_MS)
  } catch (err) {
    console.error('redis seen write failed', err)
  }
}
