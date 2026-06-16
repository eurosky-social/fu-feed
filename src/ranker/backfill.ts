import { AtpAgent } from '@atproto/api'
import { AppContext } from '../config'
import { LIKE_COLLECTION, POST_PATH } from '../subscription'

// One-time import of an account's like history so personalization works on a
// user's first request, instead of only from likes observed on the firehose
// going forward. Like records are public and listable without auth
// (com.atproto.repo.listRecords).

type BackfilledLike = {
  uri: string
  liker_did: string
  subject_uri: string
  created_at: string
  indexed_at: string
}

// Ensures a viewer's history has been backfilled at most once per TTL, using a
// Redis SET NX flag both as a one-shot guard and a stampede lock. Degrades to a
// no-op (cold-start) if Redis or the viewer's PDS is unavailable.
export const ensureViewerBackfilled = async (
  ctx: AppContext,
  viewerDid: string,
): Promise<void> => {
  const key = `foryou:backfilled:${viewerDid}`
  let won: string | null = null
  try {
    won = await ctx.redis.set(
      key,
      '1',
      'EX',
      ctx.cfg.backfillTtlSeconds,
      'NX',
    )
  } catch (err) {
    console.error('backfill flag check failed', err)
    return
  }
  if (won !== 'OK') return // already backfilled recently (or in progress)

  try {
    const n = await backfillViewerLikes(ctx, viewerDid)
    console.log(`⤓ backfilled ${n} likes for ${viewerDid}`)
  } catch (err) {
    console.error(`backfill failed for ${viewerDid}`, err)
    // release the flag so a later request can retry
    try {
      await ctx.redis.del(key)
    } catch {
      /* ignore */
    }
  }
}

// Pages the viewer's most-recent likes (default listRecords order is
// newest-first) up to the seed limit and inserts them into the like graph.
// Returns the number of rows written. Exported for tooling/tests.
export const backfillViewerLikes = async (
  ctx: AppContext,
  viewerDid: string,
): Promise<number> => {
  const pds = await resolvePds(ctx, viewerDid)
  if (!pds) {
    console.warn(`no PDS endpoint for ${viewerDid}; skipping backfill`)
    return 0
  }

  const agent = new AtpAgent({ service: pds })
  const seedLimit = ctx.cfg.ranking.seedLimit
  const pageSize = 100
  const nowIso = new Date().toISOString()

  const byUri = new Map<string, BackfilledLike>()
  let cursor: string | undefined
  while (byUri.size < seedLimit) {
    const res = await agent.com.atproto.repo.listRecords({
      repo: viewerDid,
      collection: LIKE_COLLECTION,
      limit: pageSize,
      cursor,
    })
    const records = res.data.records
    if (records.length === 0) break

    for (const rec of records) {
      const value = rec.value as any
      const subjectUri = value?.subject?.uri
      if (typeof subjectUri !== 'string' || !subjectUri.includes(POST_PATH)) {
        continue
      }
      const rawCreatedAt = value?.createdAt
      const createdAt =
        typeof rawCreatedAt === 'string' && !isNaN(Date.parse(rawCreatedAt))
          ? rawCreatedAt
          : nowIso
      byUri.set(rec.uri, {
        uri: rec.uri,
        liker_did: viewerDid,
        subject_uri: subjectUri,
        created_at: createdAt,
        indexed_at: nowIso,
      })
      if (byUri.size >= seedLimit) break
    }

    cursor = res.data.cursor
    if (!cursor) break
  }

  const rows = [...byUri.values()]
  if (rows.length === 0) return 0

  // Insert in chunks; dedupe against likes already captured from the firehose.
  const CHUNK = 500
  for (let i = 0; i < rows.length; i += CHUNK) {
    await ctx.db
      .insertInto('likes')
      .values(rows.slice(i, i + CHUNK))
      .onConflict((oc) => oc.column('uri').doNothing())
      .execute()
  }
  return rows.length
}

const resolvePds = async (
  ctx: AppContext,
  did: string,
): Promise<string | undefined> => {
  try {
    const doc = await ctx.didResolver.resolve(did)
    const services = (doc as any)?.service
    if (!Array.isArray(services)) return undefined
    const pds = services.find(
      (s: any) =>
        s?.id === '#atproto_pds' ||
        (typeof s?.id === 'string' && s.id.endsWith('#atproto_pds')),
    )
    const ep = pds?.serviceEndpoint
    return typeof ep === 'string' ? ep : undefined
  } catch (err) {
    console.error(`failed to resolve PDS for ${did}`, err)
    return undefined
  }
}
