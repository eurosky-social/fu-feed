import type { Database } from '../db'
import type { RankingConfig } from '../config'

// One of the viewer's own likes, as handed to score(). The like time is what
// splits a seed post's other likers into those who got there before the viewer
// (tastemakers) and those who arrived after — see RankingConfig.lateLikerWeight.
// Passed as epoch ms: each layout converts with its own internal encoding
// (minutes for recency, seconds for the chronology comparison — see toTsSec),
// so a caller can never mismatch epochs.
export type SeedLike = {
  uri: string
  likedAtMs: number
}

// Shared surface for the in-memory like-graph engines. Two implementations,
// selected via FEEDGEN_GRAPH_LAYOUT:
//   - LikeGraph ('arrays'): Map + number[][] adjacency. Simpler.
//   - CsrLikeGraph ('csr'): typed-array CSR + arena interners. More compact,
//     supports larger retention windows.
export interface ILikeGraph {
  ready: boolean
  applyCreate(likerDid: string, subjectUri: string, createdAtMs: number): void
  buildFromPostgres(db: Database): Promise<boolean>
  score(
    viewerDid: string,
    seed: SeedLike[],
    r: RankingConfig,
    // how many top candidates to return; defaults to r.maxCandidates. Content
    // feeds pass a larger value so enough survive the downstream media filter.
    candidateLimit?: number,
  ): Map<string, number>
  stats(): { ready: boolean; users: number; posts: number }
}
