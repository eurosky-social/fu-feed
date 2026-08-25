import { parentPort, workerData } from 'worker_threads'
import { createDb } from '../db'
import { GraphConfig } from '../config'
import { buildCsrSnapshot, csrSnapshotBuffers } from './csr-build'

// Worker-thread entry for the CSR graph build.
//
// The build is the one genuinely CPU-bound thing this service does: interning
// hundreds of millions of keys and counting-sorting them into CSR arrays. Node
// is single-threaded, so on the main thread it does not merely slow requests
// down — it starves them. Measured in production: a 552M-edge build pinned the
// process at 131% CPU for ~40 minutes, during which feed requests exceeded the
// PDS's ~10s budget and came back to clients as 502s. The service kept serving
// from the previous graph the whole time, exactly as designed; it simply never
// got the CPU to answer in time.
//
// Running it here makes it genuinely parallel rather than merely concurrent. The
// result crosses back as transferred ArrayBuffers, so handing over a multi-GB
// graph costs no copy.
//
// This worker opens its own database connection: a Kysely/pg pool belongs to the
// thread that created it and cannot be shared across threads.

export type BuildWorkerInput = {
  databaseUrl: string
  graph: GraphConfig
  buildCeilingMs: number
}

const input = workerData as BuildWorkerInput

const run = async (): Promise<void> => {
  const db = createDb(input.databaseUrl)
  try {
    const snapshot = await buildCsrSnapshot(db, input.graph, input.buildCeilingMs)
    parentPort?.postMessage(
      { ok: true, snapshot },
      csrSnapshotBuffers(snapshot),
    )
  } finally {
    await db.destroy().catch(() => undefined)
  }
}

run().catch((err) => {
  parentPort?.postMessage({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  })
})
