import { AtpAgent, RichText } from '@atproto/api'
import { TID } from '@atproto/common-web'
import { ids } from '../lexicon/lexicons'

/*
 * Idempotently creates one "interest post" per onboarding interest on the picker
 * account. Onboarding likes these posts (one per interest the user selects) to
 * seed the fu feed's collaborative-filter ranker, and they act as durable hubs
 * connecting interest-aligned users (the retention sweep exempts likes on this
 * account's posts - see FEEDGEN_PICKER_DID / startRetentionSweep).
 *
 * app.bsky.feed.post records require a TID record key, so rkeys are NOT derived
 * from the interest id. Instead each post carries a #<interestId> tag, and both
 * this tool and the social-app match posts to interests by that tag. This tool
 * is idempotent via that tag: an interest that already has a post keeps its rkey
 * (updated in place only if the text changed); a missing one gets a new TID. The
 * social-app discovers the posts at runtime the same way, so nothing (beyond the
 * picker DID) is hard-coded on either side.
 *
 * Lives in src/ (not scripts/) so `npm run build` compiles it into dist/ and it
 * can run inside the production image (node dist/tools/createInterestPosts.js),
 * which the eurosky-infra foreu role invokes on deploy. Credentials come from
 * PICKER_HANDLE / PICKER_PASSWORD / PICKER_SERVICE; when run locally without them
 * it falls back to interactive prompts (dev-only deps, loaded lazily so the
 * production image never needs them).
 *
 * Run locally: npm run createInterestPosts
 */

/*
 * Interest ids MUST stay in sync with the social-app's src/lib/interests.ts
 * (the onboarding interest picker). The label is the human-readable name; the
 * hashtag is the interest id, matching Bluesky's standard interest tags.
 */
const INTERESTS: { id: string; label: string }[] = [
  { id: 'animals', label: 'Animals' },
  { id: 'art', label: 'Art' },
  { id: 'books', label: 'Books' },
  { id: 'comedy', label: 'Comedy' },
  { id: 'comics', label: 'Comics' },
  { id: 'culture', label: 'Culture' },
  { id: 'dev', label: 'Software Dev' },
  { id: 'education', label: 'Education' },
  { id: 'finance', label: 'Finance' },
  { id: 'food', label: 'Food' },
  { id: 'gaming', label: 'Video Games' },
  { id: 'journalism', label: 'Journalism' },
  { id: 'movies', label: 'Movies' },
  { id: 'music', label: 'Music' },
  { id: 'nature', label: 'Nature' },
  { id: 'news', label: 'News' },
  { id: 'pets', label: 'Pets' },
  { id: 'photography', label: 'Photography' },
  { id: 'politics', label: 'Politics' },
  { id: 'science', label: 'Science' },
  { id: 'sports', label: 'Sports' },
  { id: 'tv', label: 'TV' },
  { id: 'tech', label: 'Tech' },
  { id: 'writers', label: 'Writers' },
]

const postText = (interest: { id: string; label: string }) =>
  `Like this post during onboarding to see more ${interest.label} in your feed. #${interest.id}`

/** The interest id whose #tag appears in a post's text, if any. */
const interestOf = (text: unknown): string | undefined => {
  if (typeof text !== 'string') return undefined
  return INTERESTS.find(i => text.includes(`#${i.id}`))?.id
}

/*
 * Credentials: env first (how the infra role runs this). If handle/password are
 * missing (local dev), fall back to interactive prompts. dotenv and inquirer are
 * dev-only conveniences imported lazily so the production image - which always
 * sets the env - never has to ship them.
 */
const resolveCreds = async (): Promise<{
  handle: string
  password: string
  service: string
}> => {
  try {
    const dotenv = await import('dotenv')
    dotenv.config()
  } catch {
    // dotenv is dev-only; ignore when unavailable (production image).
  }

  let handle = process.env.PICKER_HANDLE
  let password = process.env.PICKER_PASSWORD
  const service = process.env.PICKER_SERVICE ?? 'https://bsky.social'

  if (!handle || !password) {
    const inquirer = (await import('inquirer')).default
    // Typed loosely: inquirer is a dev-only fallback and its question types vary
    // across versions; the tool's real interface is the PICKER_* env vars.
    const questions: any[] = []
    if (!handle) {
      questions.push({
        type: 'input',
        name: 'handle',
        message: 'Enter the picker account handle:',
      })
    }
    if (!password) {
      questions.push({
        type: 'password',
        name: 'password',
        message:
          'Enter the picker account password (preferably an App Password):',
      })
    }
    const answers = await inquirer.prompt(questions)
    handle = handle ?? answers.handle
    password = password ?? answers.password
  }

  if (!handle || !password) throw new Error('missing picker credentials')
  return { handle, password, service }
}

const run = async () => {
  const { handle, password, service } = await resolveCreds()

  const agent = new AtpAgent({ service })
  await agent.login({ identifier: handle, password })
  const did = agent.session?.did
  if (!did) throw new Error('login failed: no session did')

  // Existing interest posts, keyed by interest id (via their #tag).
  const existing = new Map<
    string,
    { rkey: string; text: string; createdAt?: string }
  >()
  let cursor: string | undefined
  do {
    const { data } = await agent.com.atproto.repo.listRecords({
      repo: did,
      collection: ids.AppBskyFeedPost,
      limit: 100,
      cursor,
    })
    for (const rec of data.records) {
      const value = rec.value as { text?: string; createdAt?: string }
      const interest = interestOf(value.text)
      if (interest && !existing.has(interest)) {
        existing.set(interest, {
          rkey: rec.uri.split('/').pop() as string,
          text: value.text ?? '',
          createdAt: value.createdAt,
        })
      }
    }
    cursor = data.cursor
  } while (cursor)

  const uris: Record<string, string> = {}
  let created = 0
  let updated = 0
  let unchanged = 0

  for (const interest of INTERESTS) {
    const rt = new RichText({ text: postText(interest) })
    await rt.detectFacets(agent)

    const ex = existing.get(interest.id)
    let rkey = ex?.rkey

    if (ex && ex.text === rt.text) {
      unchanged++
      console.log(`= ${interest.id} (unchanged)`)
    } else {
      rkey = ex?.rkey ?? TID.nextStr()
      await agent.com.atproto.repo.putRecord({
        repo: did,
        collection: ids.AppBskyFeedPost,
        rkey,
        record: {
          $type: ids.AppBskyFeedPost,
          text: rt.text,
          facets: rt.facets,
          langs: ['en'],
          // Preserve the original createdAt on update so the post keeps its place.
          createdAt: ex?.createdAt ?? new Date().toISOString(),
        },
      })
      if (ex) {
        updated++
        console.log(`~ ${interest.id} (updated) -> ${rkey}`)
      } else {
        created++
        console.log(`+ ${interest.id} (created) -> ${rkey}`)
      }
    }

    uris[interest.id] = `at://${did}/${ids.AppBskyFeedPost}/${rkey}`
  }

  console.log(
    `\nDone: ${created} created, ${updated} updated, ${unchanged} unchanged.`,
  )
  console.log(`\nPicker DID (set as FEEDGEN_PICKER_DID on the feedgen):\n  ${did}`)
  console.log(
    `\nInterest post URIs (informational - the app discovers these at runtime ` +
      `by #tag, it does not hard-code them):\n${JSON.stringify(uris, null, 2)}`,
  )
}

run()
