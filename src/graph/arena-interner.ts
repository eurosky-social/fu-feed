// Maximum key length we accept (bytes). Valid DIDs / at:// post URIs are far
// shorter; this bounds the Uint16 length store and rejects malformed/huge keys.
export const MAX_KEY_LEN = 2048

// True for well-formed DIDs / at-URIs: pure ASCII and within length. The arena
// stores one byte per char, so non-ASCII keys must be rejected upstream (they'd
// otherwise truncate and silently collide). Valid atproto identifiers are ASCII.
export const isInternable = (s: string): boolean => {
  if (s.length === 0 || s.length > MAX_KEY_LEN) return false
  for (let k = 0; k < s.length; k++) {
    if (s.charCodeAt(k) > 0x7f) return false
  }
  return true
}

// Open-addressed string interner backed by flat typed arrays — the memory key
// to the CSR graph. Keys' ASCII bytes live in a chunked arena (an array of
// Uint8Array chunks), so total key bytes can exceed a single TypedArray's
// 4.29 GB / 2^32 ceiling — required to hold hundreds of millions of post URIs at
// large retention windows. Each key is stored wholly within one chunk (a new
// chunk is started rather than straddling), so reads touch a single chunk.
//
// Callers MUST pass only isInternable() keys (ASCII, ≤ MAX_KEY_LEN).
export class ArenaInterner {
  private readonly chunkSize: number
  private chunks: Uint8Array[]
  private curChunk = 0
  private curPos = 0
  private keyChunk: Uint32Array // per id: which chunk
  private keyStart: Uint32Array // per id: byte offset within the chunk
  private keyLen: Uint16Array // per id: byte length (≤ MAX_KEY_LEN)
  private slots: Int32Array // hash table: id at slot, -1 = empty
  private mask: number
  count = 0

  constructor(expectedKeys = 1024, chunkSize = 1 << 28 /* 256 MB */) {
    this.chunkSize = chunkSize
    this.chunks = [new Uint8Array(chunkSize)]
    this.keyChunk = new Uint32Array(expectedKeys)
    this.keyStart = new Uint32Array(expectedKeys)
    this.keyLen = new Uint16Array(expectedKeys)
    const cap = nextPow2(Math.ceil(expectedKeys / 0.6) || 16)
    this.slots = new Int32Array(cap).fill(-1)
    this.mask = cap - 1
  }

  // Returns the existing id for `s`, or assigns + returns a new dense id.
  // `s` must satisfy isInternable(); behaviour is otherwise undefined.
  intern(s: string): number {
    let i = hashStr(s) & this.mask
    while (this.slots[i] !== -1) {
      const id = this.slots[i]
      if (this.equals(id, s)) return id
      i = (i + 1) & this.mask
    }
    const id = this.count
    this.writeKey(id, s)
    this.slots[i] = id
    this.count++
    if (this.count * 10 >= this.slots.length * 6) this.resizeSlots() // load > 0.6
    return id
  }

  get(s: string): number | undefined {
    let i = hashStr(s) & this.mask
    while (this.slots[i] !== -1) {
      const id = this.slots[i]
      if (this.equals(id, s)) return id
      i = (i + 1) & this.mask
    }
    return undefined
  }

  keyAt(id: number): string {
    const chunk = this.chunks[this.keyChunk[id]]
    const start = this.keyStart[id]
    const end = start + this.keyLen[id]
    let out = ''
    for (let k = start; k < end; k += 8192) {
      out += String.fromCharCode(...chunk.subarray(k, Math.min(end, k + 8192)))
    }
    return out
  }

  private writeKey(id: number, s: string): void {
    const len = s.length
    if (this.curPos + len > this.chunkSize) {
      this.chunks.push(new Uint8Array(this.chunkSize))
      this.curChunk++
      this.curPos = 0
    }
    const chunk = this.chunks[this.curChunk]
    const start = this.curPos
    for (let k = 0; k < len; k++) chunk[start + k] = s.charCodeAt(k) & 0xff
    this.curPos += len
    this.ensureKeyArrays(id + 1)
    this.keyChunk[id] = this.curChunk
    this.keyStart[id] = start
    this.keyLen[id] = len
  }

  private equals(id: number, s: string): boolean {
    if (this.keyLen[id] !== s.length) return false
    const chunk = this.chunks[this.keyChunk[id]]
    const start = this.keyStart[id]
    for (let k = 0; k < s.length; k++) {
      if (chunk[start + k] !== (s.charCodeAt(k) & 0xff)) return false
    }
    return true
  }

  private ensureKeyArrays(needLen: number): void {
    if (needLen <= this.keyChunk.length) return
    let n = this.keyChunk.length || 1024
    while (n < needLen) n *= 2
    const kc = new Uint32Array(n)
    kc.set(this.keyChunk)
    this.keyChunk = kc
    const ks = new Uint32Array(n)
    ks.set(this.keyStart)
    this.keyStart = ks
    const kl = new Uint16Array(n)
    kl.set(this.keyLen)
    this.keyLen = kl
  }

  private resizeSlots(): void {
    const cap = this.slots.length * 2
    const slots = new Int32Array(cap).fill(-1)
    const mask = cap - 1
    for (let id = 0; id < this.count; id++) {
      const chunk = this.chunks[this.keyChunk[id]]
      const start = this.keyStart[id]
      let i = hashBytes(chunk, start, start + this.keyLen[id]) & mask
      while (slots[i] !== -1) i = (i + 1) & mask
      slots[i] = id
    }
    this.slots = slots
    this.mask = mask
  }
}

const nextPow2 = (x: number): number => {
  let n = 1
  while (n < x) n <<= 1
  return n
}

// FNV-1a (32-bit). hashStr(s) and hashBytes over the same stored bytes agree
// because we store charCodeAt(k) & 0xff per char (keys are ASCII).
const hashStr = (s: string): number => {
  let h = 0x811c9dc5
  for (let k = 0; k < s.length; k++) {
    h ^= s.charCodeAt(k) & 0xff
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const hashBytes = (b: Uint8Array, start: number, end: number): number => {
  let h = 0x811c9dc5
  for (let k = start; k < end; k++) {
    h ^= b[k]
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
