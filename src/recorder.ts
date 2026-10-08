// Collects G2 microphone audio for one question and packages it as WAV.
//
// The glasses deliver PCM s16le, 16 kHz, mono in ~100 ms chunks through
// `event.audioEvent.audioPcm`. In hands-free (tap) mode a small voice-activity
// detector ends the recording once the wearer stops talking; in hold mode the
// release of the press ends it instead.

import { AudioSpeakerRole } from '@evenrealities/even_hub_sdk'

const SAMPLE_RATE = 16_000
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000

const MAX_MS = 30_000 // hard cap per question
const MIN_SPEECH_RMS = 700 // below this nothing counts as speech, however quiet the room
const QUIET_ROOM_RMS = 300 // starting guess for background noise
const SPEECH_TO_ARM_MS = 300 // speech needed before silence can end the recording
const SILENCE_TO_STOP_MS = 1_000 // pause length that means "I'm done"
const NO_SPEECH_GIVE_UP_MS = 8_000
// Silence kept either side of the speech when the recording is sent: enough that no word is
// clipped, without uploading (and transcribing) the quiet before and after (2.0).
const PADDING_MS = 350

export type StopReason = 'manual' | 'silence' | 'max' | 'no-speech'

export interface RecorderOptions {
  /** End automatically on a pause (tap mode). Hold mode waits for the release. */
  autoStop: boolean
  onAutoStop: (reason: StopReason) => void
}

export class Recorder {
  private chunks: Array<{ audio: Uint8Array; own: boolean; speech: boolean }> = []
  private bytes = 0
  private floor = QUIET_ROOM_RMS // running estimate of background noise RMS
  private peakRms = 0
  private speechMs = 0
  private silenceMs = 0
  private stopped = false
  private readonly levels: number[] = []

  constructor(private readonly options: RecorderOptions) {}

  get durationMs(): number {
    return this.bytes / BYTES_PER_MS
  }

  /** Whether enough speech was heard to be worth sending. */
  get heardSpeech(): boolean {
    return this.speechMs >= SPEECH_TO_ARM_MS
  }

  /** How long the recording is once other people's voices are left out. */
  get sendableMs(): number {
    return this.chunks.reduce((bytes, chunk) => bytes + (chunk.own ? chunk.audio.byteLength : 0), 0) / BYTES_PER_MS
  }

  /** Recent input levels, 0..1, oldest first. Used for the level meter. */
  get recentLevels(): readonly number[] {
    return this.levels
  }

  push(raw: Uint8Array | number[], role?: AudioSpeakerRole): void {
    if (this.stopped) return
    const chunk = raw instanceof Uint8Array ? raw.slice() : Uint8Array.from(raw)
    if (!chunk.byteLength) return

    // Frames the Even app says came from someone else are kept out of the question
    // itself, so a conversation nearby doesn't end up being asked (1.7.0).
    const entry = { audio: chunk, own: role !== AudioSpeakerRole.Other, speech: false }
    this.chunks.push(entry)
    this.bytes += chunk.byteLength

    const rms = rmsOf(chunk)
    this.peakRms = Math.max(this.peakRms, rms)
    this.levels.push(Math.min(1, Math.sqrt(rms / 6000)))
    if (this.levels.length > 24) this.levels.shift()

    // The floor starts at a quiet-room guess, falls quickly and rises slowly,
    // so it tracks the quiet between words. Talking straight away can't
    // convince it the speech itself is background noise.
    if (rms < this.floor) this.floor = this.floor * 0.7 + rms * 0.3
    else this.floor += (rms - this.floor) * 0.01

    // The Even app classifies each glasses frame as the wearer's voice or
    // someone else's. Trust that when present; fall back to loudness otherwise.
    const loud = rms > Math.max(this.floor * 2.5, MIN_SPEECH_RMS)
    const speech =
      role === AudioSpeakerRole.Self
        ? rms > Math.max(this.floor * 1.5, MIN_SPEECH_RMS / 2)
        : role === AudioSpeakerRole.Other
          ? false
          : loud

    const ms = chunk.byteLength / BYTES_PER_MS
    entry.speech = speech
    if (speech) {
      this.speechMs += ms
      this.silenceMs = 0
    } else {
      this.silenceMs += ms
    }

    if (this.durationMs >= MAX_MS) return this.autoStop('max')
    if (!this.options.autoStop) return
    if (this.heardSpeech && this.silenceMs >= SILENCE_TO_STOP_MS) return this.autoStop('silence')
    // Only give up when nothing loud arrived at all; never discard real sound.
    if (!this.heardSpeech && this.peakRms < MIN_SPEECH_RMS && this.durationMs >= NO_SPEECH_GIVE_UP_MS) {
      return this.autoStop('no-speech')
    }
  }

  /** Stop accepting audio. Safe to call more than once. */
  stop(): void {
    this.stopped = true
  }

  /**
   * The recording as a base64 WAV file, ready for /api/chat. Frames the Even app put down
   * to someone else are left out, so the question is the wearer's voice and nothing else.
   * Hosts that don't say (older ones, and the phone microphone) mark nothing, so everything
   * they send is kept.
   */
  toWavBase64(): string {
    const own = this.chunks.filter((chunk) => chunk.own)
    // The quiet before the first word and after the last is cut, short of a little padding,
    // so less goes up from the phone and the transcriber starts sooner. With no speech
    // detected at all (a tap sends what it caught), everything is sent.
    const first = own.findIndex((chunk) => chunk.speech)
    const last = own.length - 1 - [...own].reverse().findIndex((chunk) => chunk.speech)
    let start = 0
    let end = own.length
    if (first >= 0) {
      start = first
      for (let ms = 0; start > 0 && ms < PADDING_MS; ) ms += own[--start].audio.byteLength / BYTES_PER_MS
      end = last + 1
      for (let ms = 0; end < own.length && ms < PADDING_MS; ) ms += own[end++].audio.byteLength / BYTES_PER_MS
    }
    const audio = own.slice(start, end).map((chunk) => chunk.audio)
    return toBase64(encodeWav(audio, audio.reduce((total, chunk) => total + chunk.byteLength, 0)))
  }

  private autoStop(reason: StopReason): void {
    if (this.stopped) return
    this.stopped = true
    this.options.onAutoStop(reason)
  }
}

function rmsOf(chunk: Uint8Array): number {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  const samples = chunk.byteLength >> 1
  let sum = 0
  for (let i = 0; i < samples; i++) {
    const s = view.getInt16(i * 2, true)
    sum += s * s
  }
  return samples ? Math.sqrt(sum / samples) : 0
}

function encodeWav(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const dataBytes = totalBytes - (totalBytes % 2)
  const out = new Uint8Array(44 + dataBytes)
  const view = new DataView(out.buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i)
  }

  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)

  let offset = 44
  for (const chunk of chunks) {
    const n = Math.min(chunk.byteLength, 44 + dataBytes - offset)
    out.set(chunk.subarray(0, n), offset)
    offset += n
  }
  normalise(out.subarray(44))
  return out
}

/** Boost quiet recordings so the transcriber gets a usable signal. */
function normalise(pcm: Uint8Array): void {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const samples = pcm.byteLength >> 1
  let peak = 0
  for (let i = 0; i < samples; i++) peak = Math.max(peak, Math.abs(view.getInt16(i * 2, true)))
  if (peak === 0 || peak >= 6000) return
  const gain = Math.min(8, 26_000 / peak)
  for (let i = 0; i < samples; i++) {
    const s = Math.round(view.getInt16(i * 2, true) * gain)
    view.setInt16(i * 2, Math.max(-32768, Math.min(32767, s)), true)
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x2000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x2000))
  }
  return btoa(binary)
}
