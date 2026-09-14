import { Database } from './db'
import { JetstreamSubscriptionBase, JetstreamEvent } from './jetstream'
import { ILikeGraph } from './graph/types'
import { RecentAuthorIndex } from './graph/recent-author-index'
import { isInternable } from './graph/arena-interner'

export const LIKE_COLLECTION = 'app.bsky.feed.like'
export const REPOST_COLLECTION = 'app.bsky.feed.repost'
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
    // Optional follows-feed author index, kept in sync the same way. Separate
    // from the graph on purpose — see graph/recent-author-index.ts.
    private readonly authorIndex?: RecentAuthorIndex,
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
      // RETURNING makes the unlike self-describing: the event carries only the
      // like record's URI, and the author index needs the post it pointed at to
      // decrement the count. Same single round trip either way.
      const deleted = await this.db
        .deleteFrom('likes')
        .where('uri', '=', likeUri)
        .returning('subject_uri')
        .executeTakeFirst()
      if (deleted) this.authorIndex?.applyUnlike(deleted.subject_uri)
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

    // keep the in-memory structures live (no-ops until they have been built)
    this.graph?.applyCreate(evt.did, subjectUri, Date.parse(createdAt))
    // Ingest time, not the record's createdAt: the index uses it as a stand-in
    // for post age, and a client can backdate a like record arbitrarily.
    this.authorIndex?.applyLike(subjectUri, Date.now())

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

type PendingRepost = {
  uri: string
  reposter_did: string
  subject_uri: string
  created_at: string
  indexed_at: string
}

// Ingests the network-wide repost stream into the `reposts` table.
//
// A separate subscription rather than a second collection on the like socket,
// deliberately: likes are the collaborative filter's entire input, and nothing
// belonging to the follows feed should be able to stall, slow or crash that
// stream. It also keeps the cost conditional — this class is only constructed
// when a follows feed is configured, so a CF-only deployment carries no repost
// traffic at all. It has its own `sub_state` cursor for the same reason.
export class RepostsIngester extends JetstreamSubscriptionBase {
  private buffer: PendingRepost[] = []
  private flushTimer?: NodeJS.Timeout

  constructor(
    db: Database,
    endpoint: string,
    reconnectDelay: number,
    // The follows-feed author index, kept live from this stream.
    private readonly authorIndex?: RecentAuthorIndex,
    private readonly flushIntervalMs = 500,
    private readonly flushSize = 500,
  ) {
    super(db, 'jetstream-reposts', endpoint, [REPOST_COLLECTION], reconnectDelay)
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => console.error('repost flush failed', err))
    }, this.flushIntervalMs)
  }

  async handleEvent(evt: JetstreamEvent): Promise<void> {
    if (evt.kind !== 'commit' || !evt.commit) return
    const c = evt.commit
    if (c.collection !== REPOST_COLLECTION) return

    const repostUri = `at://${evt.did}/${REPOST_COLLECTION}/${c.rkey}`

    if (c.operation === 'delete') {
      // RETURNING gives us both halves of the edge the index needs to undo: the
      // event itself carries only the repost record's URI.
      const deleted = await this.db
        .deleteFrom('reposts')
        .where('uri', '=', repostUri)
        .returning(['reposter_did', 'subject_uri'])
        .executeTakeFirst()
      if (deleted) {
        this.authorIndex?.applyUnrepost(deleted.reposter_did, deleted.subject_uri)
      }
      return
    }

    if (c.operation !== 'create' || !c.record) return

    const subject = (c.record.subject ?? {}) as { uri?: unknown }
    const subjectUri = subject.uri
    // Only index reposts of posts (a repost subject is always a post, but the
    // record is user-supplied and this is a trust boundary).
    if (typeof subjectUri !== 'string' || !subjectUri.includes(POST_PATH)) return
    if (!isInternable(subjectUri) || !isInternable(evt.did)) return

    const rawCreatedAt = c.record.createdAt
    const createdAt =
      typeof rawCreatedAt === 'string' && !isNaN(Date.parse(rawCreatedAt))
        ? rawCreatedAt
        : new Date().toISOString()

    this.buffer.push({
      uri: repostUri,
      reposter_did: evt.did,
      subject_uri: subjectUri,
      created_at: createdAt,
      indexed_at: new Date().toISOString(),
    })

    // Ingest time, not the record's createdAt — same reasoning as likes.
    this.authorIndex?.applyRepost(evt.did, subjectUri, Date.now())

    if (this.buffer.length >= this.flushSize) {
      await this.flush()
    }
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return
    const batch = this.buffer
    this.buffer = []
    await this.db
      .insertInto('reposts')
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
//
// Likes on the picker account's posts (the onboarding "interest posts") are
// exempt when `pickerDid` is set: those posts are meant to be permanent hubs
// connecting interest-aligned users, so sweeping their edges after retention
// would silently sever a user who picked an interest long ago from newer
// onboarders who pick the same one.
export const startRetentionSweep = (
  db: Database,
  retentionHours: number,
  opts: {
    pickerDid?: string
    intervalMs?: number
    // Reward signal is kept longer than raw likes so parameter tuning has history.
    interactionsRetentionHours?: number
    // Sweep the follows feed's tables too. Off unless that feed is configured,
    // so a collaborative-filter-only deployment issues no extra queries.
    sweepFollowsTables?: boolean
    // Reposts only feed a ~48h candidate window, so they are kept far more
    // briefly than likes (which also serve the 90-day curator history).
    repostsRetentionHours?: number
    // A viewer's crawled follow list is dropped once they stop loading the
    // feed; a re-crawl refreshes indexed_at, so this only reaps the inactive.
    followsRetentionHours?: number
  } = {},
): NodeJS.Timeout => {
  const {
    pickerDid,
    intervalMs = 10 * 60 * 1000,
    interactionsRetentionHours = 30 * 24,
    sweepFollowsTables = false,
    repostsRetentionHours = 72,
    followsRetentionHours = 30 * 24,
  } = opts
  const sweep = async () => {
    const cutoff = new Date(
      Date.now() - retentionHours * 60 * 60 * 1000,
    ).toISOString()
    const interactionsCutoff = new Date(
      Date.now() - interactionsRetentionHours * 60 * 60 * 1000,
    ).toISOString()
    try {
      let likesToDelete = db.deleteFrom('likes').where('indexed_at', '<', cutoff)
      if (pickerDid) {
        // DIDs contain no LIKE wildcards, so this prefix match is exact.
        likesToDelete = likesToDelete.where(
          'subject_uri',
          'not like',
          `at://${pickerDid}${POST_PATH}%`,
        )
      }
      const likes = await likesToDelete.executeTakeFirst()
      const posts = await db
        .deleteFrom('post_meta')
        .where('created_at', '<', cutoff)
        .executeTakeFirst()
      const interactions = await db
        .deleteFrom('interactions')
        .where('created_at', '<', interactionsCutoff)
        .executeTakeFirst()
      let followsNote = ''
      if (sweepFollowsTables) {
        const reposts = await db
          .deleteFrom('reposts')
          .where(
            'indexed_at',
            '<',
            new Date(
              Date.now() - repostsRetentionHours * 60 * 60 * 1000,
            ).toISOString(),
          )
          .executeTakeFirst()
        const follows = await db
          .deleteFrom('follows')
          .where(
            'indexed_at',
            '<',
            new Date(
              Date.now() - followsRetentionHours * 60 * 60 * 1000,
            ).toISOString(),
          )
          .executeTakeFirst()
        followsNote =
          `, ${Number(reposts.numDeletedRows ?? 0)} reposts` +
          `, ${Number(follows.numDeletedRows ?? 0)} follows`
      }
      console.log(
        `🧹 retention sweep removed ${Number(likes.numDeletedRows ?? 0)} likes, ` +
          `${Number(posts.numDeletedRows ?? 0)} post_meta, ` +
          `${Number(interactions.numDeletedRows ?? 0)} interactions` +
          `${followsNote} (cutoff ${cutoff})`,
      )
    } catch (err) {
      console.error('retention sweep failed', err)
    }
  }
  // run once shortly after boot, then on the interval
  setTimeout(() => sweep(), 30 * 1000)
  return setInterval(sweep, intervalMs)
}
