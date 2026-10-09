// EDITH's answers read aloud by the voice of the wearer's AI company (EDITH 2.1): OpenAI,
// Google Gemini or Groq, through EDITH's server with the wearer's own key (POST /api/speak).
// The answer is spoken a few sentences at a time: the first piece is short so the voice starts
// quickly, and the next piece is fetched while the current one plays. Everything plays through
// an analyser, so the HUD's core can bounce with the real loudness of the voice.

export type VoiceResult = 'done' | 'blocked' | 'failed'

/** Fetches one piece of speech as audio (a WAV file from EDITH's server). */
export type FetchSpeech = (text: string, signal: AbortSignal) => Promise<ArrayBuffer>

/** An answer cut into pieces: a short first one, then up to `max` characters at sentence breaks. */
export function speechPieces(text: string, first = 160, max = 380): string[] {
  const clean = text.replace(/^[ \t]*- /gm, '').replace(/\s+/g, ' ').trim()
  const sentences = clean.match(/[^.!?。！？]+[.!?。！？]+["')\]]*\s*|[^.!?。！？]+$/g) ?? [clean]
  const out: string[] = []
  let cur = ''
  for (const s of sentences) {
    const limit = out.length === 0 ? first : max
    if (cur && (cur + s).length > limit) {
      out.push(cur.trim())
      cur = ''
    }
    cur += s
    while (cur.length > max) {
      const cut = cur.lastIndexOf(' ', max) > 40 ? cur.lastIndexOf(' ', max) : max
      out.push(cur.slice(0, cut).trim())
      cur = cur.slice(cut)
    }
  }
  if (cur.trim()) out.push(cur.trim())
  return out.filter(Boolean)
}

export class CloudVoice {
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private samples: Float32Array<ArrayBuffer> | null = null
  private source: AudioBufferSourceNode | null = null
  private aborter: AbortController | null = null
  private session = 0

  get supported(): boolean {
    return typeof window !== 'undefined' && ('AudioContext' in window || 'webkitAudioContext' in window)
  }

  /** Called inside a tap or click, so browsers let the answer play when it arrives later. */
  unlock(): void {
    const ctx = this.context()
    if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => {})
  }

  /** How loud the voice is right now, 0..1. */
  level(): number {
    if (!this.analyser || !this.samples || !this.source) return 0
    this.analyser.getFloatTimeDomainData(this.samples)
    let sum = 0
    for (let i = 0; i < this.samples.length; i++) sum += this.samples[i] * this.samples[i]
    return Math.min(1, Math.sqrt(sum / this.samples.length) * 4.5)
  }

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx
    if (!this.supported) return null
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    try {
      this.ctx = new Ctor()
      this.analyser = this.ctx.createAnalyser()
      this.analyser.fftSize = 1024
      this.samples = new Float32Array(this.analyser.fftSize)
      this.analyser.connect(this.ctx.destination)
    } catch {
      this.ctx = null
    }
    return this.ctx
  }

  /**
   * Speaks text. onStart runs when the first sound plays; onDone once when it ends, fails or
   * is stopped: "blocked" when the browser wouldn't play sound yet, "failed" with the error
   * when a piece couldn't be fetched or played (nothing has played yet in that case if
   * `started` is false, so the caller can fall back to another voice).
   */
  speak(
    text: string,
    fetchSpeech: FetchSpeech,
    onStart: () => void,
    onDone: (result: VoiceResult, error?: unknown, started?: boolean) => void,
  ): void {
    this.stop()
    const ctx = this.context()
    const pieces = speechPieces(text)
    if (!ctx || !pieces.length) return onDone(ctx ? 'done' : 'failed')
    const session = ++this.session
    const aborter = new AbortController()
    this.aborter = aborter
    let started = false
    const live = () => session === this.session
    const finish = (result: VoiceResult, error?: unknown) => {
      if (!live()) return
      this.session++
      this.source = null
      onDone(result, error, started)
    }
    const load = (i: number) =>
      fetchSpeech(pieces[i], aborter.signal).then((wav) => ctx.decodeAudioData(wav.slice(0)))
    const run = async () => {
      if (ctx.state === 'suspended') {
        await ctx.resume().catch(() => {})
        if ((ctx.state as AudioContextState) !== 'running') return finish('blocked')
      }
      let next = load(0)
      for (let i = 0; i < pieces.length; i++) {
        let buffer: AudioBuffer
        try {
          buffer = await next
        } catch (err) {
          return finish(aborter.signal.aborted ? 'done' : 'failed', err)
        }
        if (!live()) return
        // Fetch the next piece while this one plays.
        if (i + 1 < pieces.length) {
          next = load(i + 1)
          next.catch(() => {}) // handled when it is awaited
        }
        await new Promise<void>((resolve) => {
          const source = ctx.createBufferSource()
          source.buffer = buffer
          source.connect(this.analyser!)
          source.onended = () => resolve()
          this.source = source
          source.start()
          if (!started) {
            started = true
            onStart()
          }
        })
        if (!live()) return
      }
      finish('done')
    }
    void run()
  }

  stop(): void {
    this.session++
    this.aborter?.abort()
    this.aborter = null
    const source = this.source
    this.source = null
    try {
      source?.stop()
    } catch {
      // already stopped
    }
  }
}
