import { Database } from '../db'

// The picker account's onboarding "interest posts" are hubs. A viewer who has
// just onboarded has liked nothing else, so everyone who liked the same interest
// posts before them is their entire curator set. The retention sweep keeps those
// likes indefinitely for exactly that reason (see startRetentionSweep), and the
// in-memory graph has to keep them too: its build otherwise loads only its own
// window, and the likers that window drops are the established accounts that
// still like things — the ones left inside it are mostly other newcomers.

// The at-uri prefix every interest post shares. The retention exemption and the
// graph build both derive from this, so the two cannot drift apart.
export const hubPostPrefix = (pickerDid: string): string =>
  `at://${pickerDid}/app.bsky.feed.post/`

export type HubLikeRow = {
  liker_did: string
  subject_uri: string
  created_at: string
}

// Likes on the given hub posts that a window scan skipped: those indexed at or
// before `windowCutoff`. Looked up by exact subject URI because that is what the
// subject index can serve — the database collates text as en_US, so a prefix
// LIKE on subject_uri cannot use the index and would read the whole table.
export const loadHubLikesBeyondWindow = async (
  db: Database,
  hubUris: ReadonlySet<string>,
  windowCutoff: string,
): Promise<HubLikeRow[]> => {
  if (hubUris.size === 0) return []
  return db
    .selectFrom('likes')
    .select(['liker_did', 'subject_uri', 'created_at'])
    .where('subject_uri', 'in', [...hubUris])
    .where('indexed_at', '<=', windowCutoff)
    .execute()
}
