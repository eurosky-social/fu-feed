import { Database } from './db'

// Reward signal extracted from app.bsky.feed.sendInteractions. Each event token
// (app.bsky.feed.defs#…) maps to a signed weight: positive events mean the
// viewer engaged with a served post, requestLess is an explicit negative. Rows
// are kept durably (one per viewer+post+event) so ranking parameters can be
// evaluated against real engagement later. interactionSeen is handled elsewhere
// (it drives the unseen-only feed, not reward) and is intentionally absent here.
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

export type RewardRow = {
  viewer_did: string
  subject_uri: string
  event: string
  weight: number
  created_at: string
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
          })),
      )
      .execute()
  } catch (err) {
    console.error('interaction record failed', err)
  }
}
