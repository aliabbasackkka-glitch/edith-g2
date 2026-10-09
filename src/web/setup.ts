// EDITH's AI setup, in the style of JARVIS's "INITIALISATION REQUIRED" overlay: the AI
// providers as a row of buttons, the key with CHECK, the model, a second key for voice when
// that AI can't hear, CONNECT OPENROUTER, how answers come back, and INITIALISE SYSTEMS.
// Keys are checked with EDITH's server before they are kept, and kept only in this browser
// (store.ts). Every string from the server is set as text, never as HTML.

import type { Access, ConnectLink, EdithApi, ModelInfo, ProviderInfo, VoiceInfo } from '../api'
import { LANGUAGES, guessLanguage } from '../i18n'
import { fillModelSelect, matchModel, modelChoices } from '../models'
import type { AnswerStyle } from '../prefs'
import { $, setStatus } from './dom'
import type { WebSettings } from './store'

/** Providers that can hear, in the order the voice row offers them: free keys first. */
const VOICE_ORDER = ['groq', 'gemini', 'openai', 'mistral', 'xai', 'openrouter']
/** A server address, with or without its scheme: "ai.example.com/v1" is enough. */
const ADDRESS = /^(https:\/\/)?[^\s/]+\.[^\s]+$/i
const plausibleKey = (key: string) => /^[\x21-\x7e]{16,400}$/.test(key)
const CONNECT_POLL_MS = 3000
const STYLES: AnswerStyle[] = ['short', 'normal', 'detailed']
/** What the voice sample says. */
const SAMPLE = "Hi, I'm E.D.I.T.H. This is how I'll sound when I answer you."

// Keys that say which company they are from (2.1): pasting one picks that company.
const KEY_COMPANIES: Array<[string, RegExp]> = [
  ['anthropic', /^sk-ant-/],
  ['openrouter', /^sk-or-/],
  ['groq', /^gsk_/],
  ['xai', /^xai-/],
  ['gemini', /^(AIza|AQ\.)/],
  ['openai', /^sk-(proj|svcacct|admin)-/],
]
/** The company a key obviously belongs to, or "". */
export const companyOfKey = (key: string): string => KEY_COMPANIES.find(([, re]) => re.test(key.trim()))?.[0] ?? ''

/** "Anthropic (Claude)" -> "Claude", "Google Gemini" -> "Gemini", "Your own server" -> "Own server". */
export function shortName(label: string): string {
  const inner = label.match(/\(([^)]+)\)/)?.[1]
  if (inner) return inner
  if (/^your own server$/i.test(label)) return 'Own server'
  return label.replace(/^Google\s+/i, '')
}

/** A model id as JARVIS shows one: "gemini-2.5-flash" -> "2.5-FLASH", "openai/gpt-oss-120b" -> "GPT-OSS-120B". */
export function modelShort(id: string): string {
  if (!id) return '--'
  const bare = (id.split('/').pop() || id).replace(/^(gemini|claude|grok|mistral|deepseek)-/i, '')
  return bare.toUpperCase()
}

/** A provider's key page as a link: the catalog gives it without the scheme. */
const keyPage = (url: string): string => (/^https:\/\//i.test(url) ? url : `https://${url.replace(/^\/+/, '')}`)

export interface SavedSetup {
  settings: WebSettings
  /** The provider's name and the model chosen, for the log. */
  label: string
  modelName: string
  voiceLabel: string
  freeTier: boolean
  /** Only the answer preferences changed. */
  prefsOnly: boolean
}

export interface SetupHost {
  api: EdithApi
  providers(): ProviderInfo[]
  loadProviders(): Promise<ProviderInfo[]>
  settings(): WebSettings
  hasAccess(): boolean
  saved(result: SavedSetup): void
  /** Deletes this browser's data on EDITH's server and here. False when the server couldn't be reached. */
  forget(): Promise<boolean>
  closed(): void
  /** Access built from keys typed here and not saved yet, for the voice sample. */
  accessFor(provider: string, key: string, voiceProvider: string, voiceKey: string): Access
  /** Plays a voice sample (the page's audio player). Resolves when it ends or fails. */
  playSample(wav: ArrayBuffer): Promise<void>
}

interface Checked {
  provider: string
  key: string
  base: string
  models: ModelInfo[]
  defaultModel: string
  freeTier: boolean
}

export class Setup {
  private readonly root = $<HTMLElement>('#setup')
  private readonly providerRow = $<HTMLElement>('#suProviders')
  private readonly voiceRow = $<HTMLElement>('#suVoiceProviders')
  private readonly styleRow = $<HTMLElement>('#suStyle')
  private readonly key = $<HTMLInputElement>('#suKey')
  private readonly base = $<HTMLInputElement>('#suBase')
  private readonly model = $<HTMLSelectElement>('#suModel')
  private readonly modelText = $<HTMLInputElement>('#suModelText')
  private readonly voiceKey = $<HTMLInputElement>('#suVoiceKey')
  private readonly language = $<HTMLSelectElement>('#suLang')
  private readonly checkStatus = $<HTMLElement>('#suCheckStatus')
  private readonly saveStatus = $<HTMLElement>('#suSaveStatus')
  private readonly connectStatus = $<HTMLElement>('#suConnectStatus')
  private provider = ''
  private voiceProvider = ''
  private style: AnswerStyle = 'normal'
  private checked: Checked | null = null
  private busy = false
  private connect: { link: ConnectLink; timer: number; expires: number; polling: boolean } | null = null
  private returnFocus: HTMLElement | null = null
  private liveModels = 0
  /** The voice chosen: a company voice id, "browser", or "off" (2.1). */
  private ttsVoice = 'off'
  private ttsVia: '' | 'chat' | 'voice' = ''
  private sampling = 0
  /** Whether a voice was chosen by hand (or saved before): if not, the company's default is offered. */
  private ttsTouched = false

  constructor(private readonly host: SetupHost) {
    for (const { code, name } of LANGUAGES) this.language.append(new Option(name, code))
    for (const style of STYLES) {
      const button = this.button(style.toUpperCase(), style, () => this.pickStyle(style))
      this.styleRow.append(button)
    }
    this.key.addEventListener('input', () => this.keyEdited())
    this.base.addEventListener('input', () => this.keyEdited())
    $('#suShow').addEventListener('click', () => {
      const show = this.key.type === 'password'
      this.key.type = show ? 'text' : 'password'
      $('#suShow').textContent = show ? 'HIDE' : 'SHOW'
      $('#suShow').setAttribute('aria-pressed', String(show))
    })
    $('#suCheck').addEventListener('click', () => void this.check())
    $('#suTtsPlay').addEventListener('click', () => void this.playSample())
    this.voiceKey.addEventListener('input', () => this.showVoices())
    this.key.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void this.check()
    })
    $('#suSave').addEventListener('click', () => void this.save())
    $('#suConnect').addEventListener('click', () => void this.startConnect())
    $('#suConnectCancel').addEventListener('click', () => this.stopConnect(''))
    $('#suForget').addEventListener('click', () => void this.forget())
    $('#suClose').addEventListener('click', () => this.close())
    this.root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.host.hasAccess()) this.close()
      if (event.key === 'Tab') this.trapFocus(event)
    })
    this.root.addEventListener('click', (event) => {
      if (event.target === this.root && this.host.hasAccess()) this.close()
    })
  }

  get isOpen(): boolean {
    return !this.root.hidden
  }

  /** Opens the setup with the saved settings. `reason` says why it opened by itself. */
  async open({ reason = '', voice = false } = {}): Promise<void> {
    const settings = this.host.settings()
    const first = !this.host.hasAccess()
    if (!this.isOpen) this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    $('#suTitle').textContent = first ? '◈  INITIALISATION REQUIRED' : '◈  AI LINK SETUP'
    $('#suSub').textContent = first
      ? 'Choose an AI and paste its key to start E.D.I.T.H.'
      : 'Change the AI, its key, or how E.D.I.T.H answers.'
    $('#suClose').hidden = first
    $('#suForgetWrap').hidden = first
    $('#suReason').hidden = !reason
    $('#suReason').textContent = reason
    this.key.value = ''
    this.key.type = 'password'
    $('#suShow').textContent = 'SHOW'
    this.voiceKey.value = ''
    this.base.value = settings.base
    this.checked = null
    setStatus(this.checkStatus, '')
    setStatus(this.saveStatus, '')
    this.pickStyle(settings.style)
    this.language.value = settings.language || guessLanguage()
    this.root.hidden = false
    document.body.style.overflow = 'hidden'

    let providers = this.host.providers()
    if (!providers.length) {
      setStatus(this.checkStatus, 'Connecting to EDITH...')
      try {
        providers = await this.host.loadProviders()
        setStatus(this.checkStatus, '')
      } catch {
        setStatus(this.checkStatus, "Can't reach EDITH's server. Check your connection, then press CHECK to try again.", 'error')
      }
    }
    this.fillProviders(providers, settings.provider)
    this.fillVoiceProviders(providers, settings.voiceProvider)
    this.ttsVoice = !settings.speak ? 'off' : settings.voiceName || 'browser'
    this.ttsVia = settings.voiceVia
    this.ttsTouched = this.host.hasAccess()
    this.providerChanged({ keepModel: settings.model })
    const voiceBox = $('#suVoiceWrap')
    if (voice && !voiceBox.hidden) {
      voiceBox.scrollIntoView({ block: 'center' })
      this.voiceKey.focus({ preventScroll: true })
    } else {
      const on = this.providerRow.querySelector<HTMLButtonElement>('.su-btn.on') ?? this.providerRow.querySelector<HTMLButtonElement>('.su-btn')
      on?.focus()
    }
  }

  close(): void {
    if (!this.isOpen) return
    this.stopConnect('')
    this.root.hidden = true
    document.body.style.overflow = ''
    this.key.value = ''
    this.voiceKey.value = ''
    this.returnFocus?.focus?.()
    this.host.closed()
  }

  // ── Buttons ─────────────────────────────────────────────────────────

  private button(label: string, value: string, onPick: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'su-btn'
    button.dataset.value = value
    button.textContent = label
    button.setAttribute('aria-pressed', 'false')
    button.addEventListener('click', onPick)
    return button
  }

  private mark(row: HTMLElement, value: string): void {
    for (const button of row.querySelectorAll<HTMLButtonElement>('.su-btn')) {
      const on = button.dataset.value === value
      button.classList.toggle('on', on)
      button.setAttribute('aria-pressed', String(on))
    }
  }

  private pickStyle(style: AnswerStyle): void {
    this.style = STYLES.includes(style) ? style : 'normal'
    this.mark(this.styleRow, this.style)
  }

  // ── Providers and models ────────────────────────────────────────────

  private info(id = this.provider): ProviderInfo | undefined {
    return this.host.providers().find((p) => p.id === id)
  }

  private fillProviders(providers: ProviderInfo[], selected: string): void {
    this.providerRow.replaceChildren(
      ...providers.map((p) => {
        const button = this.button(shortName(p.label).toUpperCase(), p.id, () => {
          if (this.provider === p.id) return
          this.provider = p.id
          this.mark(this.providerRow, p.id)
          this.providerChanged()
        })
        button.title = p.note ? `${p.label}: ${p.note}` : p.label
        return button
      }),
    )
    this.provider = providers.some((p) => p.id === selected) ? selected : ''
    this.mark(this.providerRow, this.provider)
  }

  private fillVoiceProviders(providers: ProviderInfo[], selected: string): void {
    const voices = providers.filter((p) => p.voice && !p.needsBase).sort((a, b) => rank(a.id) - rank(b.id))
    this.voiceRow.replaceChildren(
      ...voices.map((p) =>
        this.button(shortName(p.label).toUpperCase(), p.id, () => {
          this.voiceProvider = p.id
          this.mark(this.voiceRow, p.id)
          this.voiceChanged()
          this.showVoices()
        }),
      ),
    )
    this.voiceProvider = voices.some((p) => p.id === selected) ? selected : voices[0]?.id ?? ''
    this.mark(this.voiceRow, this.voiceProvider)
    this.voiceChanged()
  }

  /** The key for the chosen provider: what was typed, or the saved one when it is the same provider. */
  private effectiveKey(): string {
    const typed = this.key.value.trim()
    if (typed) return typed
    const settings = this.host.settings()
    return this.provider === settings.provider ? settings.key : ''
  }

  private effectiveBase(): string {
    const typed = this.base.value.trim()
    return typed && !/^https:\/\//i.test(typed) ? `https://${typed}` : typed
  }

  private providerChanged({ keepModel = '' } = {}): void {
    const info = this.info()
    const settings = this.host.settings()
    this.checked = null
    this.liveModels++
    setStatus(this.checkStatus, '')
    $('#suProvNote').textContent = info
      ? `${info.label}${info.note ? ` - ${info.note}` : ''}`
      : 'Gemini and Groq give free keys.'
    const link = $<HTMLAnchorElement>('#suKeyLink')
    link.hidden = !info?.keyUrl
    if (info?.keyUrl) {
      link.href = keyPage(info.keyUrl)
      link.textContent = `GET A ${shortName(info.label).toUpperCase()} KEY ↗`
    }
    $('#suBaseWrap').hidden = !info?.needsBase
    $('#suKeyLbl').textContent = info ? `${shortName(info.label).toUpperCase()} API KEY${info.keyOptional ? ' (OPTIONAL)' : ''}` : 'API KEY'
    const saved = info && info.id === settings.provider && settings.key
    this.key.placeholder = saved ? `Saved key ending ${settings.key.slice(-4)} (leave empty to keep it)` : 'Paste your key'

    const popular = info?.models ?? []
    const wanted = keepModel || (info?.id === settings.provider ? settings.model : '') || info?.defaultModel || ''
    this.showModels(modelChoices(popular, null), wanted, info)

    $('#suVoiceWrap').hidden = !info || info.voice
    if (info && !info.voice) {
      $('#suVoiceNote').textContent =
        `${shortName(info.label)} can't understand speech. To talk to E.D.I.T.H, add a key for voice ` +
        '(Groq and Gemini keys are free). Or leave it empty and type.'
      this.voiceChanged()
    }

    this.showVoices()

    // With a saved key, the models it can use come from EDITH's server.
    const key = this.effectiveKey()
    if (info && (key || info.keyOptional) && info.id === settings.provider) void this.loadLiveModels(info, key, this.effectiveBase(), wanted)
  }

  private async loadLiveModels(info: ProviderInfo, key: string, base: string, wanted: string): Promise<void> {
    const ticket = this.liveModels
    try {
      const live = await this.host.api.models(info.id, key, base)
      if (ticket !== this.liveModels || !this.isOpen) return
      if (live.models.length) this.showModels(modelChoices(info.models ?? [], live.models), matchModel(wanted, live.models) || live.defaultModel, info)
    } catch {
      // The catalog list stays; CHECK says what is wrong.
    }
  }

  private showModels(choices: { popular: ModelInfo[]; others: ModelInfo[] }, selected: string, info?: ProviderInfo): void {
    const any = choices.popular.length + choices.others.length > 0
    $('#suModelWrap').hidden = !any
    $('#suModelTextWrap').hidden = any || !info?.needsBase
    if (any) fillModelSelect(this.model, choices, selected, { popular: 'Popular', all: 'All models' })
    else this.modelText.value = selected
  }

  private keyEdited(): void {
    if (this.checked) {
      this.checked = null
      setStatus(this.checkStatus, '')
    }
    // A key that says which company it is from picks that company, and shows its voices.
    const company = companyOfKey(this.key.value)
    if (company && company !== this.provider && this.info(company)) {
      this.provider = company
      this.mark(this.providerRow, company)
      this.providerChanged()
      const info = this.info(company)!
      setStatus(
        this.checkStatus,
        `That's ${/^[AEIOU]/i.test(info.label) ? 'an' : 'a'} ${info.label} key, so ${shortName(info.label)} is selected${info.voices?.length ? ': pick its voice below.' : '.'}`,
        'ok',
      )
    }
  }

  // ── Voice (2.1): the AI company's own voices, a browser voice, or none ──

  /** Whose voices to offer: the AI's own, else the voice key's company, else none. */
  private voiceSource(): { info: ProviderInfo; via: 'chat' | 'voice' } | null {
    const info = this.info()
    if (info?.voices?.length) return { info, via: 'chat' }
    if (info && !info.voice) {
      const voiceInfo = this.info(this.voiceProvider)
      const settings = this.host.settings()
      const hasKey = this.voiceKey.value.trim() || (settings.voiceProvider === this.voiceProvider && settings.voiceKey)
      if (voiceInfo?.voices?.length && hasKey) return { info: voiceInfo, via: 'voice' }
    }
    return null
  }

  private showVoices(): void {
    const info = this.info()
    $('#suTtsWrap').hidden = !info
    if (!info) return
    const source = this.voiceSource()
    const voices: VoiceInfo[] = source?.info.voices ?? []
    const row = $<HTMLElement>('#suTtsVoices')
    const pick = (value: string, via: '' | 'chat' | 'voice') => {
      this.ttsVoice = value
      this.ttsVia = via
      this.mark(row, value)
      $<HTMLButtonElement>('#suTtsPlay').disabled = value === 'off'
      setStatus($('#suTtsStatus'), '')
    }
    const voiceButton = (v: VoiceInfo) => {
      const b = this.button('', v.id, () => {
        this.ttsTouched = true
        pick(v.id, source!.via)
      })
      b.classList.add('su-voice')
      const name = document.createElement('span')
      name.className = 'v-name'
      name.textContent = v.name
      const note = document.createElement('span')
      note.className = 'v-note'
      note.textContent = v.note
      b.append(name, note)
      b.title = `${v.name}: ${v.note}`
      return b
    }
    const extra = (label: string, value: string, note: string) => {
      const b = this.button('', value, () => {
        this.ttsTouched = true
        pick(value, '')
      })
      b.classList.add('su-voice')
      const name = document.createElement('span')
      name.className = 'v-name'
      name.textContent = label
      const n = document.createElement('span')
      n.className = 'v-note'
      n.textContent = note
      b.append(name, n)
      return b
    }
    row.replaceChildren(
      ...voices.map(voiceButton),
      extra('BROWSER', 'browser', 'Free, this device'),
      extra('SILENT', 'off', 'Text only'),
    )
    $('#suTtsNote').textContent = source
      ? `${source.info.label} voices${source.via === 'voice' ? ' (your voice key)' : ''}: pick how E.D.I.T.H sounds. It uses your key.`
      : `${shortName(info.label)} has no voices of its own. Use the browser's voice, or add a Groq, Gemini or OpenAI key for voice.`
    // Keep the choice when it is still on offer, else the company's default voice.
    const ids = new Set(voices.map((v) => v.id))
    let chosen = this.ttsVoice
    if (!this.ttsTouched && source) chosen = ''
    if (!chosen || (chosen !== 'browser' && chosen !== 'off' && !ids.has(chosen))) {
      chosen = source ? (source.info.defaultVoice && ids.has(source.info.defaultVoice) ? source.info.defaultVoice : voices[0]?.id ?? 'off') : 'off'
    }
    pick(chosen, ids.has(chosen) && source ? source.via : '')
  }

  private async playSample(): Promise<void> {
    const status = $('#suTtsStatus')
    if (this.ttsVoice === 'off') return
    if (this.ttsVoice === 'browser') {
      if (!('speechSynthesis' in window)) return setStatus(status, "This browser can't speak.", 'error')
      window.speechSynthesis.cancel()
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(SAMPLE))
      return
    }
    const source = this.voiceSource()
    if (!source) return
    const settings = this.host.settings()
    const key = this.effectiveKey()
    const voiceKey = this.voiceKey.value.trim() || (settings.voiceProvider === this.voiceProvider ? settings.voiceKey : '')
    if (source.via === 'chat' && !key) return setStatus(status, 'Paste the key first.', 'error')
    const ticket = ++this.sampling
    setStatus(status, 'Asking for a sample...')
    try {
      const wav = await this.host.api.speak(
        SAMPLE,
        this.ttsVoice,
        source.via,
        undefined,
        this.host.accessFor(this.provider, key, this.voiceProvider, voiceKey),
      )
      if (ticket !== this.sampling) return
      setStatus(status, '▶ Playing')
      await this.host.playSample(wav)
      if (ticket === this.sampling) setStatus(status, '')
    } catch (err) {
      if (ticket !== this.sampling) return
      const message = err instanceof Error ? err.message : ''
      setStatus(status, message || "Couldn't play that voice.", 'error')
    }
  }

  private voiceChanged(): void {
    const info = this.info(this.voiceProvider)
    const link = $<HTMLAnchorElement>('#suVoiceLink')
    link.hidden = !info?.keyUrl
    if (info?.keyUrl) {
      link.href = keyPage(info.keyUrl)
      link.textContent = `GET A ${shortName(info.label).toUpperCase()} KEY ↗`
    }
    const settings = this.host.settings()
    const saved = settings.voiceKey && settings.voiceProvider === this.voiceProvider
    this.voiceKey.placeholder = saved
      ? `Saved key ending ${settings.voiceKey.slice(-4)}`
      : `Paste a ${info ? shortName(info.label) : ''} key for voice`.replace('  ', ' ')
  }

  // ── Checking and saving ─────────────────────────────────────────────

  /** What is wrong before anything is sent, or "". */
  private problem(info: ProviderInfo | undefined, key: string, base: string): string {
    if (!info) return 'Pick an AI first.'
    if (info.needsBase && !ADDRESS.test(base)) return 'Give the https address of your server, e.g. https://ai.example.com/v1'
    if (!key && !info.keyOptional) return `Paste your ${info.label} key first.`
    if (key && !plausibleKey(key)) return `That doesn't look like a ${info.label} API key.`
    return ''
  }

  /** Checks the key with EDITH's server and lists its models. */
  private async check(): Promise<boolean> {
    if (this.busy) return false
    if (!this.host.providers().length) {
      try {
        const providers = await this.host.loadProviders()
        this.fillProviders(providers, this.provider || this.host.settings().provider)
        this.fillVoiceProviders(providers, this.host.settings().voiceProvider)
        this.providerChanged()
      } catch {
        setStatus(this.checkStatus, "Can't reach EDITH's server. Check your connection and try again.", 'error')
        return false
      }
    }
    const info = this.info()
    const key = this.effectiveKey()
    const base = this.effectiveBase()
    const problem = this.problem(info, key, base)
    if (problem || !info) {
      setStatus(this.checkStatus, problem, 'error')
      return false
    }
    this.setBusy(true, '#suCheck', '...')
    setStatus(this.checkStatus, `Checking with ${info.label}...`)
    try {
      const result = await this.host.api.checkKey(info.id, key, base)
      if (!result.ok) {
        setStatus(this.checkStatus, this.checkMessage(info, result), 'error')
        return false
      }
      this.checked = { provider: info.id, key, base, models: result.models, defaultModel: result.defaultModel, freeTier: result.freeTier }
      const current = !$('#suModelWrap').hidden ? this.model.value : this.modelText.value.trim()
      const pick = matchModel(current, result.models) || result.defaultModel || current
      this.showModels(modelChoices(info.models ?? [], result.models.length ? result.models : null), pick, info)
      const count = result.models.length
      setStatus(
        this.checkStatus,
        result.freeTier
          ? 'Key works. Your OpenRouter account has no credits yet, so EDITH starts on a free model.'
          : `Key works${count ? `: ${count} model${count === 1 ? '' : 's'} available` : ''}. Pick a model, then INITIALISE.`,
        'ok',
      )
      return true
    } catch {
      setStatus(this.checkStatus, "Can't reach EDITH's server. Check your connection and try again.", 'error')
      return false
    } finally {
      this.setBusy(false, '#suCheck', 'CHECK')
    }
  }

  private checkMessage(info: ProviderInfo, result: { code: string; other: string; error: string }): string {
    switch (result.code) {
      case 'provider':
        return 'Pick an AI first.'
      case 'address':
        return "EDITH couldn't reach that address. Check it, and that it is open to the internet."
      case 'format':
        return `That doesn't look like a ${info.label} API key.`
      case 'elsewhere': {
        const other = this.info(result.other)?.label ?? result.other
        return `That looks like a ${other} key. Choose ${other} instead.`
      }
      case 'rejected':
        return `${info.label} rejected this key. Copy it again from ${info.keyUrl || 'your account'}.`
      case 'network':
        return info.needsBase
          ? "EDITH couldn't reach that address. Check it, and that it is open to the internet."
          : `Couldn't reach ${info.label} to check the key. Try again.`
      case 'rate':
        return 'Too many key checks from this network. Try again in a few minutes.'
      default:
        return result.error || "Couldn't check the key. Try again."
    }
  }

  private async save(): Promise<void> {
    if (this.busy) return
    const settings = this.host.settings()
    const info = this.info()
    const key = this.effectiveKey()
    const base = this.effectiveBase()
    const prefs = { style: this.style, language: this.language.value }
    const sameAi = info?.id === settings.provider && key === settings.key && base === settings.base && this.host.hasAccess()

    const problem = this.problem(info, key, base)
    if (problem || !info) return setStatus(this.saveStatus, problem, 'error')
    if (!sameAi && !(this.checked && this.checked.provider === info.id && this.checked.key === key && this.checked.base === base)) {
      if (!(await this.check())) return setStatus(this.saveStatus, 'Fix the key above first.', 'error')
    }

    const model = !$('#suModelWrap').hidden ? this.model.value : !$('#suModelTextWrap').hidden ? this.modelText.value.trim().slice(0, 200) : ''
    const chosenModel = model || this.checked?.defaultModel || info.defaultModel || ''

    // A second key for voice, only when this AI can't hear.
    let voiceProvider = ''
    let voiceKey = ''
    let voiceLabel = ''
    if (!info.voice) {
      voiceProvider = this.voiceProvider
      const typed = this.voiceKey.value.trim()
      voiceKey = typed || (settings.voiceProvider === voiceProvider ? settings.voiceKey : '')
      if (typed) {
        const voiceInfo = this.info(voiceProvider)
        if (!voiceInfo || !plausibleKey(typed)) return setStatus(this.saveStatus, "That voice key doesn't look right.", 'error')
        this.setBusy(true, '#suSave', '▸  CHECKING VOICE KEY...')
        try {
          const result = await this.host.api.checkKey(voiceProvider, typed)
          if (!result.ok) return setStatus(this.saveStatus, `The voice key didn't work: ${this.checkMessage(voiceInfo, result)}`, 'error')
        } catch {
          return setStatus(this.saveStatus, "Can't reach EDITH's server. Check your connection and try again.", 'error')
        } finally {
          this.setBusy(false, '#suSave', '▸  INITIALISE SYSTEMS')
        }
      }
      if (!voiceKey) voiceProvider = ''
      else voiceLabel = this.info(voiceProvider)?.label ?? voiceProvider
    }

    const next: WebSettings = {
      ...settings,
      ...prefs,
      provider: info.id,
      key,
      base: info.needsBase ? base : '',
      model: chosenModel,
      voiceProvider,
      voiceKey,
      speak: this.ttsVoice !== 'off',
      voiceName: this.ttsVoice === 'browser' || this.ttsVoice === 'off' ? '' : this.ttsVoice,
      voiceVia: this.ttsVoice === 'browser' || this.ttsVoice === 'off' ? '' : this.ttsVia,
    }
    const modelName = [...this.model.options].find((o) => o.value === chosenModel)?.textContent || chosenModel
    this.host.saved({
      settings: next,
      label: info.label,
      modelName: chosenModel === 'auto' ? 'the fastest model available' : modelName.replace(/\s*\(recommended\)$/, ''),
      voiceLabel,
      freeTier: Boolean(this.checked?.freeTier),
      prefsOnly:
        sameAi &&
        voiceProvider === settings.voiceProvider &&
        voiceKey === settings.voiceKey &&
        chosenModel === settings.model &&
        next.voiceName === settings.voiceName &&
        next.speak === settings.speak,
    })
    this.close()
  }

  private setBusy(busy: boolean, button: string, label: string): void {
    this.busy = busy
    const el = $<HTMLButtonElement>(button)
    el.disabled = busy
    el.textContent = label
  }

  // ── Connect OpenRouter ──────────────────────────────────────────────

  private async startConnect(): Promise<void> {
    if (this.connect) return
    // Opened now, while the click still counts, so popup blockers allow it; it gets its
    // address once EDITH's server has made the link. It can't reach back to this page.
    let win: Window | null = null
    try {
      win = window.open('about:blank', '_blank')
      if (win) win.opener = null
    } catch {
      win = null
    }
    $('#suConnectWait').hidden = false
    $('#suConnectLink').hidden = true
    setStatus(this.connectStatus, 'Asking EDITH for a link...')
    let link: ConnectLink
    try {
      link = await this.host.api.startConnect()
      if (!/^https:\/\//i.test(link.url)) throw new Error('bad link')
    } catch {
      win?.close()
      setStatus(this.connectStatus, "Couldn't connect OpenRouter. Check your connection and try again.", 'error')
      return
    }
    if (win && !win.closed) win.location.href = link.url
    const anchor = $<HTMLAnchorElement>('#suConnectLink')
    anchor.href = link.url
    anchor.textContent = win ? 'OPEN THE OPENROUTER PAGE AGAIN ↗' : 'OPEN OPENROUTER ↗'
    anchor.hidden = false
    setStatus(
      this.connectStatus,
      win
        ? 'Sign in to OpenRouter in the new tab and press Authorize. E.D.I.T.H connects by itself.'
        : 'Open OpenRouter, sign in and press Authorize. E.D.I.T.H connects by itself.',
    )
    const pending = { link, timer: 0, expires: Date.now() + link.expiresIn * 1000, polling: false }
    pending.timer = window.setInterval(() => void this.pollConnect(pending), CONNECT_POLL_MS)
    this.connect = pending
  }

  private async pollConnect(pending: NonNullable<Setup['connect']>): Promise<void> {
    if (this.connect !== pending || pending.polling) return
    if (Date.now() > pending.expires) return this.stopConnect('The OpenRouter link expired. Press CONNECT OPENROUTER to get a new one.')
    pending.polling = true
    let result: Awaited<ReturnType<EdithApi['pollConnect']>>
    try {
      result = await this.host.api.pollConnect(pending.link)
    } catch {
      return // a blip: ask again on the next tick
    } finally {
      pending.polling = false
    }
    if (this.connect !== pending || result.status === 'pending') return
    if (result.status !== 'connected') {
      return this.stopConnect(
        result.status === 'failed'
          ? "Couldn't connect OpenRouter. Try again."
          : 'The OpenRouter link expired. Press CONNECT OPENROUTER to get a new one.',
      )
    }
    this.stopConnect('')
    $('#suConnectWait').hidden = false
    $('#suConnectLink').hidden = true
    setStatus(this.connectStatus, 'OpenRouter approved E.D.I.T.H. Checking the key...')
    let check: Awaited<ReturnType<EdithApi['checkKey']>>
    try {
      check = await this.host.api.checkKey('openrouter', result.key)
    } catch {
      setStatus(this.connectStatus, "Couldn't reach EDITH's server to finish connecting. Try again.", 'error')
      return
    }
    if (!check.ok) return setStatus(this.connectStatus, check.error || "Couldn't connect OpenRouter. Try again.", 'error')
    const info = this.info('openrouter')
    const settings = this.host.settings()
    this.host.saved({
      settings: {
        ...settings,
        style: this.style,
        language: this.language.value,
        provider: 'openrouter',
        key: result.key,
        base: '',
        model: check.defaultModel,
        voiceProvider: '',
        voiceKey: '',
      },
      label: info?.label ?? 'OpenRouter',
      modelName: check.defaultModel || 'its recommended model',
      voiceLabel: '',
      freeTier: check.freeTier,
      prefsOnly: false,
    })
    this.close()
  }

  private stopConnect(problem: string): void {
    if (this.connect) window.clearInterval(this.connect.timer)
    this.connect = null
    if (problem) {
      $('#suConnectWait').hidden = false
      $('#suConnectLink').hidden = true
      setStatus(this.connectStatus, problem, 'error')
    } else {
      $('#suConnectWait').hidden = true
      setStatus(this.connectStatus, '')
    }
  }

  // ── Forgetting ──────────────────────────────────────────────────────

  private async forget(): Promise<void> {
    const sure = window.confirm(
      "Forget this browser?\n\nEDITH's memories, saved chats and lists for this browser are deleted from EDITH's server, " +
        'and your keys and settings are removed from this browser. This cannot be undone.',
    )
    if (!sure) return
    this.setBusy(true, '#suForget', '...')
    const ok = await this.host.forget()
    this.setBusy(false, '#suForget', '✕ FORGET')
    if (!ok) setStatus(this.saveStatus, "Couldn't reach EDITH's server, so nothing was deleted. Try again.", 'error')
  }

  /** Keeps Tab inside the setup while it is open. */
  private trapFocus(event: KeyboardEvent): void {
    const items = [...this.root.querySelectorAll<HTMLElement>('button, a[href], input, select')].filter(
      (el) => !el.closest('[hidden]') && !(el as HTMLButtonElement).disabled,
    )
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
}

function rank(id: string): number {
  const at = VOICE_ORDER.indexOf(id)
  return at < 0 ? VOICE_ORDER.length : at
}
