// Reading answers aloud with the browser's own voices, only when the user turns it on.
// The most natural voice for the answer language is picked (the "Natural", "Neural" and
// "Online" voices Edge and Chrome offer, Siri and enhanced voices on Apple devices).

const LOCALES: Record<string, string> = {
  en: 'en-US',
  de: 'de-DE',
  fr: 'fr-FR',
  es: 'es-ES',
  it: 'it-IT',
  zh: 'zh-CN',
  ja: 'ja-JP',
  ko: 'ko-KR',
  ar: 'ar-SA',
}

/** Chrome stops long utterances part-way, so answers are read in pieces of about this size. */
const PIECE_CHARS = 220

export type SpeechResult = 'done' | 'blocked' | 'failed'

export class Speaker {
  private session = 0

  get supported(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined'
  }

  constructor() {
    // Voices load late in Chrome; asking once early gets the list ready.
    if (this.supported) {
      try {
        window.speechSynthesis.getVoices()
      } catch {
        // no voices yet
      }
    }
  }

  /**
   * Reads text aloud. onDone runs once when it finishes, fails or is stopped: "blocked" when the
   * browser refused to speak before the page was tapped or clicked, "failed" when it could not speak.
   */
  speak(
    text: string,
    language: string,
    onStart: () => void,
    onDone: (result: SpeechResult) => void,
    /** Each word as it is read, with its length: the HUD bounces on it. */
    onWord?: (length: number) => void,
  ): void {
    this.stop()
    const pieces = split(text.replace(/^[ \t]*- /gm, '').trim())
    if (!this.supported || !pieces.length) return onDone('done')
    const session = ++this.session
    const synth = window.speechSynthesis
    const locale = localeFor(language)
    const voice = pickVoice(synth.getVoices(), language)
    let left = pieces.length
    let started = false
    const finish = (result: SpeechResult = 'done') => {
      if (session !== this.session) return
      this.session++
      onDone(result)
    }
    for (const piece of pieces) {
      const utterance = new SpeechSynthesisUtterance(piece)
      utterance.lang = voice?.lang || locale
      if (voice) utterance.voice = voice
      utterance.rate = 1.02
      utterance.onstart = () => {
        if (!started && session === this.session) {
          started = true
          onStart()
        }
      }
      utterance.onend = () => {
        if (--left === 0) finish()
      }
      utterance.onboundary = (event) => {
        if (session === this.session && event.name === 'word') onWord?.(event.charLength || 4)
      }
      utterance.onerror = (event) =>
        finish(event.error === 'not-allowed' ? 'blocked' : event.error === 'interrupted' || event.error === 'canceled' ? 'done' : 'failed')
      synth.speak(utterance)
    }
  }

  /** Called inside a tap or click: lets browsers that need one speak later answers. */
  unlock(): void {
    if (!this.supported) return
    try {
      const silent = new SpeechSynthesisUtterance(' ')
      silent.volume = 0
      window.speechSynthesis.speak(silent)
    } catch {
      // nothing to unlock
    }
  }

  stop(): void {
    this.session++
    if (this.supported) {
      try {
        window.speechSynthesis.cancel()
      } catch {
        // nothing was speaking
      }
    }
  }
}

function localeFor(language: string): string {
  const own = (navigator.language || '').toLowerCase()
  return own.startsWith(`${language}-`) ? navigator.language : LOCALES[language] || 'en-US'
}

function pickVoice(voices: SpeechSynthesisVoice[], language: string): SpeechSynthesisVoice | null {
  const own = (navigator.language || '').toLowerCase()
  const score = (v: SpeechSynthesisVoice): number => {
    const name = v.name.toLowerCase()
    const lang = v.lang.toLowerCase().replace('_', '-')
    let points = 0
    if (/natural|neural|online|premium|enhanced|siri/.test(name)) points += 6
    if (/google/.test(name)) points += 3
    if (!v.localService) points += 1
    if (own && lang === own) points += 2
    if (/compact|espeak|robot/.test(name)) points -= 4
    return points
  }
  const matching = voices.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(language))
  return matching.sort((a, b) => score(b) - score(a))[0] || null
}

/** Sentences gathered into pieces of about PIECE_CHARS, never cutting a word. */
function split(text: string): string[] {
  const sentences = text.match(/[^.!?。！？\n]+[.!?。！？]*\s*|\n+/g) || [text]
  const pieces: string[] = []
  let current = ''
  for (const sentence of sentences) {
    if ((current + sentence).length > PIECE_CHARS && current.trim()) {
      pieces.push(current.trim())
      current = ''
    }
    current += sentence
    while (current.length > PIECE_CHARS * 1.5) {
      const cut = current.lastIndexOf(' ', PIECE_CHARS) > 40 ? current.lastIndexOf(' ', PIECE_CHARS) : PIECE_CHARS
      pieces.push(current.slice(0, cut).trim())
      current = current.slice(cut)
    }
  }
  if (current.trim()) pieces.push(current.trim())
  return pieces.filter(Boolean)
}
