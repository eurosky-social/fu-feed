import type { Database } from '../db'
import type { RankingConfig } from '../config'

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
    seedUris: string[],
    r: RankingConfig,
    // how many top candidates to return; defaults to r.maxCandidates. Content
    // feeds pass a larger value so enough survive the downstream media filter.
    candidateLimit?: number,
  ): Map<string, number>
  stats(): { ready: boolean; users: number; posts: number }
}
