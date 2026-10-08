// Listening to the room (EDITH 1.8.0): what the person in front of you is saying, on your
// display, and kept for a moment so you can ask about it afterwards.
//
// EDITH 1.7 throws these frames away. The Even app marks every glasses frame as the
// wearer's voice or someone else's (AudioSpeakerRole), and a question must only ever
// carry the wearer's - otherwise the room asks EDITH things by mistake. Here it is the
// other way round: the other voices are the point, and the wearer's are dropped, so your
// own words never come back at you as subtitles.
//
// Audio arrives in ~100 ms frames of PCM s16le, 16 kHz, mono. A segment is cut when the
// speaker pauses, or when it has run long enough that waiting would feel slow.

import { AudioSpeakerRole } from '@evenrealities/even_hub_sdk'

const SAMPLE_RATE = 16_000
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000

/** Cut a segment at a pause this long, so a sentence arrives whole. */
const PAUSE_MS = 700
/** ...but never wait longer than this: subtitles that lag are worse than split ones. */
const MAX_SEGMENT_MS = 6_000
/** Below this there is nothing worth sending. */
const MIN_SEGMENT_MS = 900
/** Speech has to be at least this loud over the room to count. */
const SPEECH_RMS = 600
/** Carried into the next segment so a word cut in half is still heard once. */
const OVERLAP_MS = 250
/** What is kept to look back at: enough for "what did they just say?" and for notes. */
const KEEP_LINES = 400

export interface RoomLine {
  /** Milliseconds since listening started, so lines can be read back in order. */
  at: number
  text: string
}

export interface RoomSegment {
  wav: string
  ms: number
}

/**
 * Collects what other people say into segments to transcribe, and keeps the lines that
 * come back. One of these lives for as long as the wearer is listening.
 */
export class RoomEars {
  private readonly frames: Uint8Array[] = []
  private bytes = 0
  private quietMs = 0
  private speechMs = 0
  private carry: Uint8Array | null = null
  private startedAt = Date.now()
  private lines: RoomLine[] = []
  private live = ''

  /** Milliseconds of other people's speech heard since this started. */
  private heardMs = 0

  get sinceStartMs(): number {
    return Date.now() - this.startedAt
  }

  /** How much was actually worth transcribing, which is what a session costs. */
  get spokenMs(): number {
    return this.heardMs
  }

  /** Everything heard so far, oldest first. */
  get heard(): readonly RoomLine[] {
    return this.lines
  }

  /** The words still being said, if any: shown greyer than the settled ones. */
  get pending(): string {
    return this.live
  }

  /** One glasses frame. Only other people's voices are kept. */
  push(raw: Uint8Array | number[], role?: AudioSpeakerRole): void {
    // Unknown frames are treated as the wearer's: a subtitle of your own voice is
    // confusing, while missing one line of someone else's is not.
    if (role !== AudioSpeakerRole.Other) return
    const frame = raw instanceof Uint8Array ? raw.slice() : Uint8Array.from(raw)
    if (!frame.byteLength) return

    this.frames.push(frame)
    this.bytes += frame.byteLength
    const ms = frame.byteLength / BYTES_PER_MS
    if (rmsOf(frame) >= SPEECH_RMS) {
      this.speechMs += ms
      this.heardMs += ms
      this.quietMs = 0
    } else {
      this.quietMs += ms
    }
  }

  /** Whether there is a whole thought to send: they paused, or they have gone on a while. */
  get ready(): boolean {
    const ms = this.bytes / BYTES_PER_MS
    if (this.speechMs < MIN_SEGMENT_MS) return false
    return this.quietMs >= PAUSE_MS || ms >= MAX_SEGMENT_MS
  }

  /** Takes what has been collected as a WAV, leaving a little overlap behind. */
  take(): RoomSegment | null {
    if (!this.frames.length || this.speechMs < MIN_SEGMENT_MS) return null
    const parts = this.carry ? [this.carry, ...this.frames] : [...this.frames]
    const audio = join(parts)
    const ms = audio.byteLength / BYTES_PER_MS

    this.carry = tail(audio, OVERLAP_MS * BYTES_PER_MS)
    this.frames.length = 0
    this.bytes = 0
    this.speechMs = 0
    this.quietMs = 0
    return { wav: wavBase64(audio), ms }
  }

  /** Words that came back for a segment. Empty ones (a cough, a door) are ignored. */
  add(text: string): void {
    const line = text.trim()
    if (!line) return
    this.lines.push({ at: this.sinceStartMs, text: line })
    if (this.lines.length > KEEP_LINES) this.lines = this.lines.slice(-KEEP_LINES)
    this.live = ''
  }

  /** What is being said right now, before the final words arrive. */
  setPending(text: string): void {
    this.live = text.trim()
  }

  /** The last few seconds, for "what did they just say?". */
  recent(ms: number): string {
    const from = this.sinceStartMs - ms
    return this.lines.filter((line) => line.at >= from).map((line) => line.text).join(' ')
  }

  /** Everything said, as one transcript for notes or a summary. */
  transcript(): string {
    return this.lines.map((line) => line.text).join('\n')
  }

  /** Nothing is kept once listening stops: the audio never leaves this object. */
  forget(): void {
    this.frames.length = 0
    this.bytes = 0
    this.carry = null
    this.lines = []
    this.live = ''
  }
}

const rmsOf = (chunk: Uint8Array): number => {
  const samples = new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 2))
  if (!samples.length) return 0
  let total = 0
  for (const sample of samples) total += sample * sample
  return Math.sqrt(total / samples.length)
}

const join = (parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((bytes, part) => bytes + part.byteLength, 0)
  const all = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    all.set(part, at)
    at += part.byteLength
  }
  return all
}

const tail = (audio: Uint8Array, bytes: number): Uint8Array | null =>
  audio.byteLength > bytes ? audio.slice(audio.byteLength - bytes) : audio.slice()

/** PCM as a WAV file, base64, the way the transcribe endpoint wants it. */
function wavBase64(pcm: Uint8Array): string {
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i))
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, pcm.byteLength, true)

  const file = new Uint8Array(44 + pcm.byteLength)
  file.set(new Uint8Array(header), 0)
  file.set(pcm, 44)
  let binary = ''
  for (let i = 0; i < file.length; i += 0x8000) binary += String.fromCharCode(...file.subarray(i, i + 0x8000))
  return btoa(binary)
}
