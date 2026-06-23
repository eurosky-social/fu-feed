import { Database } from './db'
import { JetstreamSubscriptionBase, JetstreamEvent } from './jetstream'
import { ILikeGraph } from './graph/types'
import { isInternable } from './graph/arena-interner'

export const LIKE_COLLECTION = 'app.bsky.feed.like'
export const POST_PATH = '/app.bsky.feed.post/'

type PendingLike = {
  uri: string
  liker_did: string
  subject_uri: string
  created_at: string
  indexed_at: string
}

// Ingests the network-wide like stream from Jetstream into the `likes` edge
// table. Likes are the entire signal for the For You algorithm. Creates are
// buffered and flushed in batches to keep write load manageable at full
// network volume; deletes (far rarer) are applied directly.
export class LikesIngester extends JetstreamSubscriptionBase {
  private buffer: PendingLike[] = []
  private flushTimer?: NodeJS.Timeout

  constructor(
    db: Database,
    endpoint: string,
    reconnectDelay: number,
    // Optional in-memory graph kept in sync with the firehose (live appends).
    private readonly graph?: ILikeGraph,
    private readonly flushIntervalMs = 500,
    private readonly flushSize = 500,
  ) {
    super(db, 'jetstream', endpoint, [LIKE_COLLECTION], reconnectDelay)
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => console.error('like flush failed', err))
    }, this.flushIntervalMs)
  }

  async handleEvent(evt: JetstreamEvent): Promise<void> {
    if (evt.kind !== 'commit' || !evt.commit) return
    const c = evt.commit
    if (c.collection !== LIKE_COLLECTION) return

    const likeUri = `at://${evt.did}/${LIKE_COLLECTION}/${c.rkey}`

    if (c.operation === 'delete') {
      await this.db.deleteFrom('likes').where('uri', '=', likeUri).execute()
      return
    }

    if (c.operation !== 'create' || !c.record) return

    const subject = (c.record.subject ?? {}) as { uri?: unknown }
    const subjectUri = subject.uri
    // Only index likes on posts (ignore likes of feed generators, etc).
    if (typeof subjectUri !== 'string' || !subjectUri.includes(POST_PATH)) return
    // Valid post at-URIs are ASCII; drop malformed/hostile non-ASCII or oversized
    // URIs at the boundary so they never reach Postgres or the graph interner.
    if (!isInternable(subjectUri)) return

    const rawCreatedAt = c.record.createdAt
    const createdAt =
      typeof rawCreatedAt === 'string' && !isNaN(Date.parse(rawCreatedAt))
        ? rawCreatedAt
        : new Date().toISOString()

    this.buffer.push({
      uri: likeUri,
      liker_did: evt.did,
      subject_uri: subjectUri,
      created_at: createdAt,
      indexed_at: new Date().toISOString(),
    })

    // keep the in-memory graph live (no-op until it has finished building)
    this.graph?.applyCreate(evt.did, subjectUri, Date.parse(createdAt))

    if (this.buffer.length >= this.flushSize) {
      await this.flush()
    }
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return
    const batch = this.buffer
    this.buffer = []
    await this.db
      .insertInto('likes')
      .values(batch)
      .onConflict((oc) => oc.column('uri').doNothing())
      .execute()
  }

  stop() {
    if (this.flushTimer) clearInterval(this.flushTimer)
    super.stop()
  }
}

// Periodically drops like edges and post metadata older than the retention
// window so the working set stays bounded. The For You output is capped at
// `freshnessHours`, but we retain likes a bit longer to keep seed/co-liker
// coverage for infrequent likers.
export const startRetentionSweep = (
  db: Database,
  retentionHours: number,
  intervalMs = 10 * 60 * 1000,
  // Reward signal is kept longer than raw likes so parameter tuning has history.
  interactionsRetentionHours = 30 * 24,
): NodeJS.Timeout => {
  const sweep = async () => {
    const cutoff = new Date(
      Date.now() - retentionHours * 60 * 60 * 1000,
    ).toISOString()
    const interactionsCutoff = new Date(
      Date.now() - interactionsRetentionHours * 60 * 60 * 1000,
    ).toISOString()
    try {
      const likes = await db
        .deleteFrom('likes')
        .where('indexed_at', '<', cutoff)
        .executeTakeFirst()
      const posts = await db
        .deleteFrom('post_meta')
        .where('created_at', '<', cutoff)
        .executeTakeFirst()
      const interactions = await db
        .deleteFrom('interactions')
        .where('created_at', '<', interactionsCutoff)
        .executeTakeFirst()
      console.log(
        `🧹 retention sweep removed ${Number(likes.numDeletedRows ?? 0)} likes, ` +
          `${Number(posts.numDeletedRows ?? 0)} post_meta, ` +
          `${Number(interactions.numDeletedRows ?? 0)} interactions (cutoff ${cutoff})`,
      )
    } catch (err) {
      console.error('retention sweep failed', err)
    }
  }
  // run once shortly after boot, then on the interval
  setTimeout(() => sweep(), 30 * 1000)
  return setInterval(sweep, intervalMs)
}
