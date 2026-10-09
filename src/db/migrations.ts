import { Kysely, Migration, MigrationProvider } from 'kysely'

const migrations: Record<string, Migration> = {}

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations
  },
}

migrations['001'] = {
  async up(db: Kysely<unknown>) {
    // --- like edges (the user <-> post bipartite graph) ---
    await db.schema
      .createTable('likes')
      .addColumn('uri', 'varchar', (col) => col.primaryKey())
      .addColumn('liker_did', 'varchar', (col) => col.notNull())
      .addColumn('subject_uri', 'varchar', (col) => col.notNull())
      .addColumn('created_at', 'varchar', (col) => col.notNull())
      .addColumn('indexed_at', 'varchar', (col) => col.notNull())
      .execute()

    // who liked a given post (co-liker lookup)
    await db.schema
      .createIndex('likes_subject_idx')
      .on('likes')
      .column('subject_uri')
      .execute()

    // a user's recent likes (seed + candidate fetch). created_at desc.
    await db.schema
      .createIndex('likes_liker_created_idx')
      .on('likes')
      .columns(['liker_did', 'created_at'])
      .execute()

    // pruning by ingest time
    await db.schema
      .createIndex('likes_indexed_idx')
      .on('likes')
      .column('indexed_at')
      .execute()

    // --- lazily-hydrated post metadata ---
    await db.schema
      .createTable('post_meta')
      .addColumn('uri', 'varchar', (col) => col.primaryKey())
      .addColumn('author_did', 'varchar', (col) => col.notNull())
      .addColumn('created_at', 'varchar', (col) => col.notNull())
      .addColumn('like_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('is_quote', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('is_adult', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('hydrated_at', 'varchar', (col) => col.notNull())
      .execute()

    await db.schema
      .createIndex('post_meta_created_idx')
      .on('post_meta')
      .column('created_at')
      .execute()

    // --- seen (reserved for interactionSeen ingestion) ---
    await db.schema
      .createTable('seen')
      .addColumn('viewer_did', 'varchar', (col) => col.notNull())
      .addColumn('subject_uri', 'varchar', (col) => col.notNull())
      .addColumn('seen_at', 'varchar', (col) => col.notNull())
      .addPrimaryKeyConstraint('seen_pk', ['viewer_did', 'subject_uri'])
      .execute()

    // --- firehose cursor ---
    await db.schema
      .createTable('sub_state')
      .addColumn('service', 'varchar', (col) => col.primaryKey())
      .addColumn('cursor', 'bigint', (col) => col.notNull())
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('likes').execute()
    await db.schema.dropTable('post_meta').execute()
    await db.schema.dropTable('seen').execute()
    await db.schema.dropTable('sub_state').execute()
  },
}

migrations['002'] = {
  async up(db: Kysely<unknown>) {
    // 1 if the post is a reply; the feed serves top-level posts only.
    await db.schema
      .alterTable('post_meta')
      .addColumn('is_reply', 'integer', (col) => col.notNull().defaultTo(0))
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.alterTable('post_meta').dropColumn('is_reply').execute()
  },
}

migrations['003'] = {
  async up(db: Kysely<unknown>) {
    // media flags for content-typed feed variants (image / video)
    await db.schema
      .alterTable('post_meta')
      .addColumn('is_image', 'integer', (col) => col.notNull().defaultTo(0))
      .execute()
    await db.schema
      .alterTable('post_meta')
      .addColumn('is_video', 'integer', (col) => col.notNull().defaultTo(0))
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.alterTable('post_meta').dropColumn('is_image').execute()
    await db.schema.alterTable('post_meta').dropColumn('is_video').execute()
  },
}

migrations['004'] = {
  async up(db: Kysely<unknown>) {
    // durable reward signal from sendInteractions (see schema Interaction).
    await db.schema
      .createTable('interactions')
      .addColumn('viewer_did', 'varchar', (col) => col.notNull())
      .addColumn('subject_uri', 'varchar', (col) => col.notNull())
      .addColumn('event', 'varchar', (col) => col.notNull())
      .addColumn('weight', 'integer', (col) => col.notNull())
      .addColumn('created_at', 'varchar', (col) => col.notNull())
      .addPrimaryKeyConstraint('interactions_pk', [
        'viewer_did',
        'subject_uri',
        'event',
      ])
      .execute()

    // per-viewer recent reward lookups + retention sweeps by ingest time
    await db.schema
      .createIndex('interactions_viewer_idx')
      .on('interactions')
      .columns(['viewer_did', 'created_at'])
      .execute()
    await db.schema
      .createIndex('interactions_created_idx')
      .on('interactions')
      .column('created_at')
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('interactions').execute()
  },
}

migrations['005'] = {
  async up(db: Kysely<unknown>) {
    // BCP-47 language subtags declared on the post record, normalized to primary
    // subtags and comma-joined (e.g. 'en,de'); '' when the post declares none.
    // Powers the cold-start language allowlist (see ranker/finalize.ts).
    await db.schema
      .alterTable('post_meta')
      .addColumn('langs', 'varchar', (col) => col.notNull().defaultTo(''))
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.alterTable('post_meta').dropColumn('langs').execute()
  },
}

migrations['006'] = {
  async up(db: Kysely<unknown>) {
    // Per-viewer follow edges for the follows feed (see db/schema.ts). Crawled
    // from the viewer's PDS, not the firehose, so this table only ever holds
    // viewers who have requested that feed.
    await db.schema
      .createTable('follows')
      .addColumn('viewer_did', 'varchar', (col) => col.notNull())
      .addColumn('subject_did', 'varchar', (col) => col.notNull())
      .addColumn('created_at', 'varchar', (col) => col.notNull())
      .addColumn('indexed_at', 'varchar', (col) => col.notNull())
      .addPrimaryKeyConstraint('follows_pk', ['viewer_did', 'subject_did'])
      .execute()

    // The only read shape: one viewer's whole follow list, newest follows
    // first (that ordering is what the maxFollows cap keeps when it bites).
    await db.schema
      .createIndex('follows_viewer_created_idx')
      .on('follows')
      .columns(['viewer_did', 'created_at'])
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('follows').execute()
  },
}

migrations['007'] = {
  async up(db: Kysely<unknown>) {
    // Repost edges for the follows feed (see db/schema.ts). Written by a
    // separate Jetstream subscription that only runs when a follows feed is
    // configured, so a collaborative-filter-only deployment stays empty here.
    await db.schema
      .createTable('reposts')
      .addColumn('uri', 'varchar', (col) => col.primaryKey())
      .addColumn('reposter_did', 'varchar', (col) => col.notNull())
      .addColumn('subject_uri', 'varchar', (col) => col.notNull())
      .addColumn('created_at', 'varchar', (col) => col.notNull())
      .addColumn('indexed_at', 'varchar', (col) => col.notNull())
      .execute()

    // The index seed pages by ingest time, and the retention sweep prunes by
    // it — the same two access patterns `likes` has.
    await db.schema
      .createIndex('reposts_indexed_idx')
      .on('reposts')
      .column('indexed_at')
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('reposts').execute()
  },
}

migrations['008'] = {
  async up(db: Kysely<unknown>) {
    // Resolving "which repost record put this post in the feed" for the URIs of
    // one finished ranked list is a lookup by subject, which nothing else in the
    // schema needs. Without this index it seq-scans `reposts`.
    await db.schema
      .createIndex('reposts_subject_idx')
      .on('reposts')
      .column('subject_uri')
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropIndex('reposts_subject_idx').execute()
  },
}

migrations['009'] = {
  async up(db: Kysely<unknown>) {
    // Which feed — and which path through it — a reward event belongs to. Every
    // feed this service publishes reports to the same sendInteractions endpoint,
    // so without it a like cannot be told apart by feed.
    await db.schema
      .alterTable('interactions')
      .addColumn('feed_context', 'varchar')
      .execute()

    // Event totals per day and feed context, views included (see schema
    // InteractionCount). A handful of rows per day; nothing sweeps it.
    await db.schema
      .createTable('interaction_counts')
      .addColumn('day', 'varchar', (col) => col.notNull())
      .addColumn('feed_context', 'varchar', (col) => col.notNull())
      .addColumn('event', 'varchar', (col) => col.notNull())
      .addColumn('n', 'integer', (col) => col.notNull())
      .addPrimaryKeyConstraint('interaction_counts_pk', [
        'day',
        'feed_context',
        'event',
      ])
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('interaction_counts').execute()
    await db.schema
      .alterTable('interactions')
      .dropColumn('feed_context')
      .execute()
  },
}
