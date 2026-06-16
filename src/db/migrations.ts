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
