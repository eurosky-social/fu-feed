import type { Database } from '../db'
import type { RankingConfig } from '../config'

// Optional inputs/outputs for ILikeGraph.score's durable-curator path.
//
// The curator selection (the users who co-liked the viewer's seed posts, with
// their incoming weights) is normally recomputed live each request from the
// like graph, which only holds likes within the retention window. When a
// co-like ages out, that curator stops being discovered — even if they are
// still active and their other recent likes would make good candidates. The
// ranker persists the selection in the `curators` table (which survives the
// likes sweep) and feeds it back in here:
//
//   - durableCurators: the viewer's persisted selection (curator DID → weight),
//     already decayed by age. score() merges curators that the live pass missed
//     (their seed co-like is gone) back into the candidate walk, provided they
//     still have forward edges in the graph (recent likes in the window) — a
//     curator with no in-window likes would contribute nothing and is skipped
//     so they don't take a top-N slot. A curator present both live and durable
//     keeps the live weight (the freshest signal wins).
//   - onCurators: receives the final selected curator set (DID → weight) the
//     graph actually used (live + merged durable, after the top-maxCurators
//     cut), for the ranker to upsert back into the durable table. Refreshing
//     active curators this way keeps their decay clock reset and their row
//     alive; a curator that stops being active is no longer refreshed and ages
//     out on its own (longer) horizon.
export type ScoreOptions = {
  durableCurators?: Map<string, number>
  onCurators?: (curators: Map<string, number>) => void
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
    seedUris: string[],
    r: RankingConfig,
    // how many top candidates to return; defaults to r.maxCandidates. Content
    // feeds pass a larger value so enough survive the downstream media filter.
    candidateLimit?: number,
    // durable curator selection (see ScoreOptions). Omitted = the original
    // live-only behaviour, so callers and tests that don't pass it are unchanged.
    opts?: ScoreOptions,
  ): Map<string, number>
  stats(): { ready: boolean; users: number; posts: number }
}
