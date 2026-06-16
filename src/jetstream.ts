import WebSocket from 'ws'
import { Database } from './db'

// Minimal shape of a Jetstream event. Jetstream emits lightweight JSON
// (~1/10 the size of the CBOR firehose) and lets us subscribe to just the
// collections we care about via `wantedCollections`.
// See https://github.com/bluesky-social/jetstream
export type JetstreamCommit = {
  rev: string
  operation: 'create' | 'update' | 'delete'
  collection: string
  rkey: string
  record?: Record<string, unknown>
  cid?: string
}

export type JetstreamEvent = {
  did: string
  time_us: number
  kind: 'commit' | 'identity' | 'account'
  commit?: JetstreamCommit
}

export abstract class JetstreamSubscriptionBase {
  private ws?: WebSocket
  private stopped = false
  private lastCursorSave = 0

  constructor(
    public db: Database,
    public service: string, // sub_state key
    public endpoint: string, // wss://jetstream2.us-west.bsky.network/subscribe
    public wantedCollections: string[],
    public reconnectDelay: number,
  ) {}

  abstract handleEvent(evt: JetstreamEvent): Promise<void>

  async run() {
    const cursor = await this.getCursor()
    const url = this.buildUrl(cursor)
    console.log(
      `📡 connecting to jetstream ${this.endpoint} (cursor=${cursor ?? 'live'})`,
    )

    const ws = new WebSocket(url)
    this.ws = ws

    ws.on('message', (data: WebSocket.RawData) => {
      let evt: JetstreamEvent
      try {
        evt = JSON.parse(data.toString())
      } catch {
        return
      }
      this.handleEvent(evt).catch((err) =>
        console.error('jetstream could not handle event', err),
      )
      this.maybeSaveCursor(evt.time_us)
    })

    ws.on('error', (err) => {
      console.error('jetstream websocket error', err)
      ws.close()
    })

    ws.on('close', () => {
      if (this.stopped) return
      console.warn(
        `jetstream connection closed; reconnecting in ${this.reconnectDelay}ms`,
      )
      setTimeout(() => this.run(), this.reconnectDelay)
    })
  }

  stop() {
    this.stopped = true
    this.ws?.close()
  }

  private buildUrl(cursor?: number): string {
    const params = new URLSearchParams()
    for (const c of this.wantedCollections) {
      params.append('wantedCollections', c)
    }
    if (cursor) params.append('cursor', String(cursor))
    return `${this.endpoint}?${params.toString()}`
  }

  // Throttle cursor persistence to ~once every 3s to keep write load low while
  // still bounding how much we'd reprocess after a restart.
  private maybeSaveCursor(timeUs: number) {
    if (!timeUs) return
    const now = Date.now()
    if (now - this.lastCursorSave < 3000) return
    this.lastCursorSave = now
    this.saveCursor(timeUs).catch((err) =>
      console.error('failed to save jetstream cursor', err),
    )
  }

  private async saveCursor(cursor: number) {
    await this.db
      .insertInto('sub_state')
      .values({ service: this.service, cursor })
      .onConflict((oc) =>
        oc.column('service').doUpdateSet({ cursor }),
      )
      .execute()
  }

  private async getCursor(): Promise<number | undefined> {
    const res = await this.db
      .selectFrom('sub_state')
      .selectAll()
      .where('service', '=', this.service)
      .executeTakeFirst()
    // pg returns bigint as a string; normalize to a number.
    return res ? Number(res.cursor) : undefined
  }
}
