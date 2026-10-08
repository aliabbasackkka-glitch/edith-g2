// Turning what the browser's microphone recorded into what EDITH's server takes for a
// question: 16 kHz, mono, 16-bit PCM WAV, as base64. Pure functions, no browser APIs
// beyond btoa, so they can be checked on their own.

export const TARGET_RATE = 16_000

/**
 * Resamples mono audio to `to` Hz. Going down, each output sample is the average of the
 * input it covers (a box filter, enough to keep speech clean); going up, it interpolates.
 */
export function resample(input: Float32Array, from: number, to = TARGET_RATE): Float32Array {
  if (!input.length || from <= 0) return new Float32Array(0)
  if (from === to) return input.slice()
  const ratio = from / to
  const length = Math.floor(input.length / ratio)
  const out = new Float32Array(length)
  if (ratio > 1) {
    for (let i = 0; i < length; i++) {
      const start = i * ratio
      const end = start + ratio
      let sum = 0
      let weight = 0
      for (let j = Math.floor(start); j < Math.min(input.length, Math.ceil(end)); j++) {
        const w = Math.min(end, j + 1) - Math.max(start, j)
        if (w > 0) {
          sum += input[j] * w
          weight += w
        }
      }
      out[i] = weight ? sum / weight : 0
    }
  } else {
    for (let i = 0; i < length; i++) {
      const at = i * ratio
      const j = Math.floor(at)
      const next = j + 1 < input.length ? input[j + 1] : input[j]
      out[i] = input[j] + (next - input[j]) * (at - j)
    }
  }
  return out
}

/** 16-bit little-endian PCM in a WAV file. */
export function encodeWav(samples: Float32Array, rate = TARGET_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true) // bytes per second
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return bytes
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** Root-mean-square level of a block of samples, 0..1. */
export function rms(samples: Float32Array): number {
  if (!samples.length) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}
