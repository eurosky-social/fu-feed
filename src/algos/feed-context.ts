// The feedContext attached to every post this service serves. The AppView hands
// it to the client with the post, and the client sends it back with each
// interaction it reports (sendInteractions), which is what lets engagement be
// attributed to the feed and the path that put a post there — without it, a
// like reported to this service could have come from any of its feeds.
//
//   <rkey>;src=<source>[;lang=<0|1>]
//
//   source  cf       the collaborative filter (the viewer's taste-neighbours)
//           follows  the follows feed's engagement ranking
//           popular  the cold-start popularity list: the whole feed for a
//                    viewer with no personalization, or the fill under a thin one
//   lang    whether the post declares one of the viewer's preferred languages;
//           present only when the request carried any (Accept-Language)
//
// No `|`: clients join interaction fields with it when de-duplicating them, and
// a context containing one is split apart on its way back.
export type ContextSource = 'cf' | 'follows' | 'popular'

export const feedContext = (
  rkey: string,
  source: ContextSource,
  inLanguage?: boolean,
): string =>
  `${rkey};src=${source}` +
  (inLanguage === undefined ? '' : `;lang=${inLanguage ? 1 : 0}`)

// rkey characters per the record-key syntax, which contains neither `;` nor `=`.
const CONTEXT =
  /^[A-Za-z0-9._:~-]{1,512};src=(cf|follows|popular)(;lang=[01])?$/

// Whether a client-supplied value is a context this service could have issued.
// Interactions arrive from clients, so anything else is not stored.
export const isFeedContext = (value: unknown): value is string =>
  typeof value === 'string' && CONTEXT.test(value)
