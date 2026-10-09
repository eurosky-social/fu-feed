import { sql } from 'kysely'
import { Database } from './db'
import { isFeedContext } from './algos/feed-context'

// Reward signal extracted from app.bsky.feed.sendInteractions. Each event token
// (app.bsky.feed.defs#…) maps to a signed weight: positive events mean the
// viewer engaged with a served post, requestLess is an explicit negative. Rows
// are kept durably (one per viewer+post+event) so ranking parameters can be
// evaluated against real engagement later. interactionSeen carries no weight —
// it drives the unseen-only feed, not reward — and is intentionally absent here.
export const REWARD_WEIGHTS: Record<string, number> = {
  'app.bsky.feed.defs#requestMore': 5,
  'app.bsky.feed.defs#interactionRepost': 4,
  'app.bsky.feed.defs#interactionQuote': 4,
  'app.bsky.feed.defs#interactionShare': 3,
  'app.bsky.feed.defs#interactionLike': 3,
  'app.bsky.feed.defs#interactionReply': 2,
  'app.bsky.feed.defs#clickthroughItem': 1,
  'app.bsky.feed.defs#clickthroughEmbed': 1,
  'app.bsky.feed.defs#clickthroughAuthor': 1,
  'app.bsky.feed.defs#clickthroughReposter': 1,
  'app.bsky.feed.defs#requestLess': -5,
}

// The one non-reward event that matters: it drives the unseen-only feed, and
// per feed context it is the denominator for every reward rate.
export const SEEN_EVENT = 'app.bsky.feed.defs#interactionSeen'

export type RewardRow = {
  viewer_did: string
  subject_uri: string
  event: string
  weight: number
  created_at: string
  feed_context: string | null
}

export type CountRow = {
  day: string
  feed_context: string
  event: string
  n: number
}

export type ParsedInteractions = {
  // post URIs the viewer has now seen
  seen: string[]
  // one per viewer + post + event; a repeat within the batch keeps the last
  rewards: RewardRow[]
  // event totals per feed context, for the events reported with one
  counts: CountRow[]
}

// Splits one sendInteractions body into what each store takes. Malformed items
// and unknown events are skipped, and a feed context is kept only when it is
// one this service could have issued (see algos/feed-context.ts) — it arrives
// from the client, so anything else would be arbitrary text in the database.
export const parseInteractions = (
  viewerDid: string,
  interactions: unknown,
  now: Date,
): ParsedInteractions => {
  const seen: string[] = []
  const rewards = new Map<string, RewardRow>()
  const counts = new Map<string, CountRow>()
  const createdAt = now.toISOString()
  const day = createdAt.slice(0, 10)

  for (const it of Array.isArray(interactions) ? interactions : []) {
    const event = it?.event
    const item = it?.item
    if (typeof event !== 'string' || typeof item !== 'string') continue
    const weight = REWARD_WEIGHTS[event]
    if (event !== SEEN_EVENT && weight === undefined) continue
    const context = isFeedContext(it.feedContext) ? it.feedContext : null

    if (context) {
      const key = `${context}\u0000${event}`
      const count = counts.get(key)
      if (count) count.n++
      else counts.set(key, { day, feed_context: context, event, n: 1 })
    }

    if (event === SEEN_EVENT) {
      seen.push(item)
      continue
    }
    // Postgres refuses an upsert that touches the same row twice in one
    // statement, which would cost the whole batch — so collapse repeats here.
    rewards.set(`${item}\u0000${event}`, {
      viewer_did: viewerDid,
      subject_uri: item,
      event,
      weight,
      created_at: createdAt,
      feed_context: context,
    })
  }

  return { seen, rewards: [...rewards.values()], counts: [...counts.values()] }
}

// Upserts reward-bearing interactions (one row per viewer+post+event; a repeat
// just refreshes the timestamp). Best-effort — failures are logged, not thrown,
// so a telemetry write never breaks the interactions response.
export const recordInteractions = async (
  db: Database,
  rows: RewardRow[],
): Promise<void> => {
  if (rows.length === 0) return
  try {
    await db
      .insertInto('interactions')
      .values(rows)
      .onConflict((oc) =>
        oc
          .columns(['viewer_did', 'subject_uri', 'event'])
          .doUpdateSet((eb) => ({
            weight: eb.ref('excluded.weight'),
            created_at: eb.ref('excluded.created_at'),
            // A repeat reported without a context keeps the one it had.
            feed_context: eb.fn.coalesce(
              eb.ref('excluded.feed_context'),
              eb.ref('interactions.feed_context'),
            ),
          })),
      )
      .execute()
  } catch (err) {
    console.error('interaction record failed', err)
  }
}

// Adds a batch's event totals to the day's counts. Best-effort, like
// recordInteractions.
export const recordInteractionCounts = async (
  db: Database,
  rows: CountRow[],
): Promise<void> => {
  if (rows.length === 0) return
  try {
    await db
      .insertInto('interaction_counts')
      .values(rows)
      .onConflict((oc) =>
        oc.columns(['day', 'feed_context', 'event']).doUpdateSet({
          n: sql<number>`interaction_counts.n + excluded.n`,
        }),
      )
      .execute()
  } catch (err) {
    console.error('interaction count failed', err)
  }
}
