// The browser's microphone, for one question at a time. The microphone is opened when the
// user starts talking and closed again when they stop, so the browser's recording light is
// only on while EDITH is listening.

import workletUrl from './capture-worklet.js?url&no-inline'
import { TARGET_RATE, encodeWav, resample, rms, toBase64 } from './wav'

export const MAX_RECORDING_MS = 60_000

export type MicProblem = 'unsupported' | 'insecure' | 'denied' | 'none' | 'busy' | 'failed'

export class MicError extends Error {
  constructor(readonly problem: MicProblem) {
    super(problem)
  }
}

export interface Recording {
  /** 16 kHz mono 16-bit WAV, base64. */
  data: string
  ms: number
  /** The loudest block, 0..1: near zero means nothing was said. */
  peak: number
}

export class Mic {
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private node: AudioWorkletNode | ScriptProcessorNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private sink: GainNode | null = null
  private chunks: Float32Array[] = []
  private samples = 0
  private rate = 48_000
  private peak = 0
  private flushed: (() => void) | null = null
  /** Samples are being kept. */
  private live = false
  /** The microphone is open (it stays open past the time limit until stop() collects the audio). */
  private open = false

  constructor(
    /** Each block's level, 0..1, while recording. */
    private readonly onLevel: (level: number) => void,
    /** Called once when the recording reaches its limit. */
    private readonly onLimit: () => void,
  ) {}

  get recording(): boolean {
    return this.open
  }

  /** Opens the microphone and starts recording. Throws a MicError saying what stopped it. */
  async start(): Promise<void> {
    if (this.open) return
    if (!window.isSecureContext) throw new MicError('insecure')
    if (!navigator.mediaDevices?.getUserMedia) throw new MicError('unsupported')
    // The audio context is made (and resumed) right away, while the tap or key press still
    // counts as one: Safari keeps a context made after the permission prompt suspended.
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioCtx) throw new MicError('unsupported')
    let ctx: AudioContext
    try {
      ctx = new AudioCtx()
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    } catch {
      throw new MicError('failed')
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch (err) {
      void ctx.close().catch(() => {})
      const name = (err as DOMException)?.name || ''
      if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') throw new MicError('denied')
      if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') throw new MicError('none')
      if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') throw new MicError('busy')
      throw new MicError('failed')
    }

    this.reset()
    this.stream = stream
    try {
      this.ctx = ctx
      if (ctx.state === 'suspended') await Promise.race([ctx.resume(), new Promise((resolve) => setTimeout(resolve, 1500))])
      this.rate = ctx.sampleRate
      this.source = ctx.createMediaStreamSource(stream)
      // Nothing is played: the capture node's output goes to the speakers through a silent gain,
      // which keeps every browser pulling audio through it.
      this.sink = ctx.createGain()
      this.sink.gain.value = 0
      this.sink.connect(ctx.destination)
      this.node = await this.captureNode(ctx)
      this.source.connect(this.node)
      this.node.connect(this.sink)
      this.open = true
      this.live = true
    } catch {
      this.close()
      throw new MicError('failed')
    }
  }

  /** Stops recording and closes the microphone. */
  async stop(): Promise<Recording> {
    if (!this.open) return { data: '', ms: 0, peak: 0 }
    this.live = false
    if (this.node instanceof AudioWorkletNode) {
      // What is left in the worklet's last block, briefly waited for.
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 150)
        this.flushed = () => {
          window.clearTimeout(timer)
          resolve()
        }
        ;(this.node as AudioWorkletNode).port.postMessage('flush')
      })
    }
    this.close()
    const all = new Float32Array(this.samples)
    let at = 0
    for (const chunk of this.chunks) {
      all.set(chunk, at)
      at += chunk.length
    }
    const peak = this.peak
    const rate = this.rate
    this.reset()
    const pcm = resample(all, rate, TARGET_RATE)
    return { data: toBase64(encodeWav(pcm, TARGET_RATE)), ms: Math.round((pcm.length / TARGET_RATE) * 1000), peak }
  }

  /** Stops without keeping anything. */
  cancel(): void {
    this.live = false
    this.close()
    this.reset()
  }

  private async captureNode(ctx: AudioContext): Promise<AudioWorkletNode | ScriptProcessorNode> {
    if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        await ctx.audioWorklet.addModule(workletUrl)
        const node = new AudioWorkletNode(ctx, 'edith-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 })
        node.port.onmessage = (event) => {
          if (event.data === 'flushed') this.flushed?.()
          else if (event.data instanceof Float32Array) this.push(event.data)
        }
        return node
      } catch {
        // Older browsers: the ScriptProcessor below.
      }
    }
    const node = ctx.createScriptProcessor(4096, 1, 1)
    node.onaudioprocess = (event) => {
      if (this.live) this.push(new Float32Array(event.inputBuffer.getChannelData(0)))
    }
    return node
  }

  private push(block: Float32Array): void {
    if (!this.live && !this.flushed) return
    this.chunks.push(block)
    this.samples += block.length
    const level = rms(block)
    if (level > this.peak) this.peak = level
    this.onLevel(Math.min(1, level * 6))
    if (this.live && (this.samples / this.rate) * 1000 >= MAX_RECORDING_MS) {
      this.live = false
      this.onLimit()
    }
  }

  private close(): void {
    try {
      this.source?.disconnect()
      this.node?.disconnect()
      this.sink?.disconnect()
    } catch {
      // already disconnected
    }
    if (this.node && 'port' in this.node) this.node.port.onmessage = null
    this.stream?.getTracks().forEach((track) => track.stop())
    void this.ctx?.close().catch(() => {})
    this.open = false
    this.stream = null
    this.ctx = null
    this.node = null
    this.source = null
    this.sink = null
    this.flushed = null
    this.onLevel(0)
  }

  private reset(): void {
    this.chunks = []
    this.samples = 0
    this.peak = 0
  }
}
