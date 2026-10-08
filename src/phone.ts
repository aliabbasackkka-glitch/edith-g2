// The companion screen shown on the phone inside the Even app: first-run setup, a talk
// button, the conversation, a text box, and a short settings panel. Every label comes from
// the i18n dictionaries (data-i18n attributes in the template, t() in code).
//
// EDITH 2.0 is the simple EDITH: talk to an AI, with whichever key you have, plus the few
// extras people asked to keep: accounts, saved chats, discreet mode, subtitles and live
// translation, a second opinion and calendars. The rest of 1.4-1.8 (specialists, smart
// home, routines, photos, the glasses keypad) is gone from the app.

import type { ChatSummary, ModelInfo, ProviderInfo } from './api'
import { LANGUAGES, getLanguage, isRtl, t, type Key, type Lang } from './i18n'
import { fillModelSelect, matchModel, modelChoices } from './models'
import { DEFAULT_PREFS, MAX_CALENDARS, TRANSLATE_TARGETS, type CalendarLink, type Prefs } from './prefs'
import { stripMarkdown } from './text'

/** What the browser link panel is for: signing in to an account, or connecting OpenRouter. */
export type LinkKind = 'account' | 'openrouter'

/** The saved chats panel: the chat this phone is in, and the list or search results. */
export interface ChatsView {
  current: string
  title: string
  chats: ChatSummary[]
  searching: boolean
}

export type PhoneState = 'boot' | 'setup' | 'idle' | 'listening' | 'thinking' | 'error'

export interface PendingLine {
  update(text: string): void
}

/** An answer that is still arriving. */
export interface LiveAnswer {
  append(text: string): void
  reset(): void
  finish(text: string, toolsUsed?: string[]): void
  discard(): void
}

/** One configured AI in the settings list. */
export interface AiRow {
  id: string // provider id
  label: string
  detail: string
  active: boolean
  model: string
  models: ModelInfo[]
}

export interface VoiceOption {
  value: string
  label: string
}

/** What the setup card collected: the AI, its model and key, and an optional voice key. */
export interface SetupChoice {
  provider: string
  model: string
  key: string
  voiceProvider: string
  voiceKey: string
  /** "Your own server": the https address it answers on. */
  base: string
}

export interface KeyCheck {
  ok: boolean
  error: string
  models: ModelInfo[]
  defaultModel: string
  /** OpenRouter only: the account has never bought credits, so only free models work. */
  freeTier?: boolean
}

const TEMPLATE = /* html */ `
  <main class="shell">
    <header class="top">
      <div class="brand">
        <div class="wordmark">E.D.I.T.H</div>
        <div class="tagline" data-i18n="app.tagline"></div>
      </div>
      <div class="pill" data-state="boot"><span class="dot"></span><span class="pill-label"></span></div>
    </header>

    <section class="setup" hidden>
      <h2 class="setup-title"></h2>

      <div class="connect-box">
        <button class="button connect-openrouter" type="button" data-i18n="connect.button"></button>
        <span class="help" data-i18n="connect.help"></span>
      </div>
      <p class="setup-or" data-i18n="connect.or"></p>
      <p class="setup-intro" data-i18n="setup.intro"></p>

      <label class="field">
        <span class="field-label"><span class="step">1</span><span data-i18n="setup.provider"></span></span>
        <select class="setup-provider" data-i18n-aria="setup.provider"></select>
        <span class="help" data-i18n="setup.recommend"></span>
      </label>

      <label class="field">
        <span class="field-label"><span class="step">2</span><span data-i18n="setup.model"></span></span>
        <select class="setup-model" data-i18n-aria="setup.model"></select>
        <span class="help setup-model-help"></span>
      </label>

      <label class="field setup-base-field" hidden>
        <span class="field-label" data-i18n="setup.address"></span>
        <input class="setup-base mono" dir="ltr" type="url" autocomplete="off" spellcheck="false" autocapitalize="off" data-i18n-placeholder="setup.addressPlaceholder" data-i18n-aria="setup.address" />
        <span class="help" data-i18n="setup.addressHelp"></span>
      </label>

      <label class="field">
        <span class="field-label"><span class="step">3</span><span data-i18n="setup.key"></span></span>
        <input class="setup-key mono" dir="ltr" type="password" autocomplete="off" spellcheck="false" autocapitalize="off" data-i18n-placeholder="setup.keyPlaceholder" data-i18n-aria="setup.key" />
        <span class="help setup-where"></span>
      </label>

      <div class="voice-box" hidden>
        <p class="voice-title"></p>
        <p class="help voice-why"></p>
        <label class="field">
          <span class="field-label"><span class="step">4</span><span data-i18n="setup.voiceProvider"></span></span>
          <select class="setup-voice-provider" data-i18n-aria="setup.voiceProvider"></select>
        </label>
        <label class="field">
          <span class="field-label" data-i18n="setup.voiceKey"></span>
          <input class="setup-voice-key mono" dir="ltr" type="password" autocomplete="off" spellcheck="false" autocapitalize="off" data-i18n-placeholder="setup.voiceKeyPlaceholder" data-i18n-aria="setup.voiceKey" />
          <span class="help setup-voice-where"></span>
        </label>
      </div>
      <p class="help voice-covered" hidden></p>

      <div class="actions setup-actions">
        <button class="button setup-save" type="button"></button>
        <button class="button quiet setup-cancel" type="button" data-i18n="setup.cancel" hidden></button>
        <button class="button quiet setup-signin" type="button" data-i18n="account.signInInstead" hidden></button>
      </div>
      <p class="setup-status" aria-live="polite"></p>
      <p class="help" data-i18n="setup.privacy"></p>
    </section>

    <section class="signin" hidden>
      <h2 class="signin-title"></h2>
      <p class="help signin-intro"></p>
      <p data-i18n="account.step1"></p>
      <input class="signin-link mono" dir="ltr" type="text" readonly />
      <div class="actions">
        <button class="button signin-copy" type="button" data-i18n="account.copy"></button>
        <button class="button quiet signin-cancel" type="button" data-i18n="account.cancel"></button>
      </div>
      <p class="signin-code"></p>
      <p class="setup-status signin-status" aria-live="polite"></p>
    </section>

    <section class="stage">
      <button class="talk" type="button" data-state="boot" data-i18n-aria="talk.aria">
        <span class="talk-glow" aria-hidden="true"></span>
        <span class="talk-label"></span>
      </button>
      <ul class="controls">
        <li data-i18n-rich="controls.hold"></li>
        <li data-i18n-rich="controls.tap"></li>
        <li data-i18n-rich="controls.doubleTap"></li>
      </ul>
    </section>

    <details class="chats">
      <summary>
        <span class="chats-label" data-i18n="chats.title"></span>
        <span class="chats-current" dir="auto"></span>
      </summary>
      <div class="chats-panel">
        <div class="chats-tools">
          <input class="chats-search" type="search" enterkeyhint="search" autocomplete="off" data-i18n-placeholder="chats.search" data-i18n-aria="chats.search" />
          <button class="button chats-new" type="button" data-i18n="chats.new"></button>
        </div>
        <div class="chats-list"></div>
        <p class="help" data-i18n="chats.help"></p>
      </div>
    </details>

    <section class="log" aria-live="polite"></section>

    <form class="compose" autocomplete="off">
      <div class="compose-field">
        <input class="compose-input" type="text" enterkeyhint="send" data-i18n-placeholder="compose.placeholder" data-i18n-aria="compose.placeholder" />
        <button class="compose-send" type="submit" data-i18n="compose.send" data-i18n-aria="compose.send"></button>
      </div>
    </form>

    <details class="settings">
      <summary data-i18n="settings.title"></summary>

      <div class="field account" hidden>
        <span class="field-label" data-i18n="settings.account"></span>
        <span class="account-who" dir="auto" hidden></span>
        <span class="help account-help"></span>
        <div class="actions">
          <button class="button quiet account-signin" type="button" data-i18n="account.signIn"></button>
          <button class="button quiet account-signout" type="button" data-i18n="account.signOut" hidden></button>
          <button class="button quiet account-delete" type="button" data-i18n="account.delete" hidden></button>
        </div>
      </div>

      <div class="field">
        <span class="field-label" data-i18n="settings.yourAi"></span>
        <div class="ai-list"></div>
        <div class="actions">
          <button class="button quiet add-ai" type="button" data-i18n="settings.addAi"></button>
        </div>
      </div>

      <label class="field">
        <span class="field-label" data-i18n="settings.voice"></span>
        <select class="voice-select" data-i18n-aria="settings.voice"></select>
        <span class="help voice-help"></span>
      </label>

      <label class="field">
        <span class="field-label" data-i18n="settings.language"></span>
        <select class="language-select" data-i18n-aria="settings.language"></select>
      </label>

      <div class="field">
        <span class="field-label" data-i18n="settings.glasses"></span>
        <label class="check">
          <input class="pref-follow" type="checkbox" />
          <span data-i18n="knows.followUp"></span>
        </label>
        <label class="check">
          <input class="pref-discreet" type="checkbox" />
          <span data-i18n="glasses.discreet"></span>
        </label>
        <label class="pref">
          <span class="help" data-i18n="glasses.roomLanguage"></span>
          <select class="room-language" data-i18n-aria="glasses.roomLanguage"></select>
        </label>
        <span class="help" data-i18n="glasses.roomHelp"></span>
      </div>

      <div class="field">
        <span class="field-label" data-i18n="settings.calendar"></span>
        <span class="help" data-i18n="calendar.help"></span>
        <div class="calendar-list"></div>
        <div class="actions">
          <button class="button quiet calendar-add" type="button" data-i18n="calendar.add"></button>
        </div>
      </div>

      <div class="field">
        <span class="field-label" data-i18n="settings.yourData"></span>
        <div class="actions">
          <button class="button quiet clear" type="button" data-i18n="settings.clear"></button>
          <button class="button quiet forget" type="button" data-i18n="settings.forget"></button>
        </div>
        <span class="help" data-i18n="settings.forgetHelp"></span>
      </div>

      <div class="field">
        <span class="field-label" data-i18n="settings.about"></span>
        <span class="help"><span data-i18n="settings.version"></span> <span class="version mono" dir="ltr"></span></span>
        <span class="help"><span data-i18n="settings.privacy"></span> <span class="privacy mono" dir="ltr"></span></span>
      </div>
    </details>
  </main>
`

const TALK_KEYS: Record<PhoneState, Key> = {
  boot: 'talk.boot',
  setup: 'talk.talk',
  idle: 'talk.talk',
  listening: 'talk.send',
  thinking: 'talk.thinking',
  error: 'talk.talk',
}

// Notes the server catalog gives in English, worded here in the phone's language.
const PROVIDER_NOTES: Record<string, Key> = {
  gemini: 'provider.freeKey',
  groq: 'provider.recommended',
  openrouter: 'provider.manyModels',
}

// The AI picker lists the ones that work best for most people first: Groq (free, fastest,
// hears you), then Gemini (free), then the rest.
const PROVIDER_ORDER = ['groq', 'gemini', 'openrouter', 'openai', 'anthropic', 'xai', 'mistral', 'deepseek']
const RECOMMENDED_PROVIDER = 'groq'

// Free keys first: the order the voice picker suggests providers that can hear.
const VOICE_PICKER_ORDER = ['groq', 'gemini', 'openai', 'mistral', 'xai', 'openrouter']
const CHECK_DELAY_MS = 700
/** A server address, with or without its scheme: "ai.example.com/v1" is enough. */
const ADDRESS = /^(https:\/\/)?[^\s/]+\.[^\s]+$/i

/** "Anthropic (Claude)" -> "Claude", "Groq" -> "Groq". */
export function shortName(label: string): string {
  return label.match(/\(([^)]+)\)/)?.[1] ?? label
}

const plausibleKey = (key: string) => /^[\x21-\x7e]{16,400}$/.test(key)

/** A catalog model's name in the phone's language: "Claude Haiku 4.5: fastest". */
function modelName(m: ModelInfo): string {
  if (!m.label) return m.name
  const hints = m.hints ?? []
  const words = hints.filter((h) => h !== 'recommended').map((h) => t(`hint.${h}` as Key))
  return `${m.label}${words.length ? `: ${words.join(t('list.sep'))}` : ''}${hints.includes('recommended') ? ` (${t('hint.recommended')})` : ''}`
}

const localized = (models: ModelInfo[] = []): ModelInfo[] => models.map((m) => ({ ...m, name: modelName(m) }))

/** Fills an element with text where **marked** parts are bold. */
function setRich(el: HTMLElement, text: string): void {
  el.replaceChildren(
    ...text.split('**').map((part, i) => {
      if (i % 2 === 0) return document.createTextNode(part)
      const bold = document.createElement('b')
      bold.textContent = part
      return bold
    }),
  )
}

function fillOptions(select: HTMLSelectElement, options: Array<{ value: string; label: string }>): void {
  const previous = select.value
  select.replaceChildren(
    ...options.map(({ value, label }) => {
      const option = document.createElement('option')
      option.value = value
      option.textContent = label
      return option
    }),
  )
  if (options.some((o) => o.value === previous)) select.value = previous
}

// For WebViews without Intl.DisplayNames.
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', nl: 'Dutch', ru: 'Russian',
  el: 'Greek', tr: 'Turkish', pl: 'Polish', id: 'Indonesian', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', ar: 'Arabic',
}

/** A language's name in the phone's language: "Spanisch" for es, in German. */
function languageLabel(code: string): string {
  try {
    const name = new Intl.DisplayNames([getLanguage()], { type: 'language' }).of(code)
    if (name && name !== code) return name.charAt(0).toLocaleUpperCase(getLanguage()) + name.slice(1)
  } catch {
    // Falls back to English below.
  }
  return LANGUAGE_NAMES[code] ?? code
}

/** When a chat was last used: the time if it was today, otherwise the date. */
function lastUsed(ms: number): string {
  const date = new Date(ms)
  const now = new Date()
  const lang = getLanguage()
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString(lang, { hour: 'numeric', minute: '2-digit' })
  const year = date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' as const }
  return date.toLocaleDateString(lang, { day: 'numeric', month: 'short', ...year })
}

/** Deleting asks for a second tap first: true once the button has been armed and tapped again. */
function confirmed(button: HTMLButtonElement, ask: Key, label: Key): boolean {
  if (button.dataset.armed !== 'true') {
    button.dataset.armed = 'true'
    button.textContent = t(ask)
    window.setTimeout(() => {
      button.dataset.armed = 'false'
      button.textContent = t(label)
    }, 4000)
    return false
  }
  button.dataset.armed = 'false'
  button.textContent = t(label)
  return true
}

export class Phone {
  private readonly $: <T extends HTMLElement>(selector: string) => T
  private providers: ProviderInfo[] = []
  private voiceCoverage = ''
  private state: PhoneState = 'boot'
  private addingAnother = false
  private busy = false
  private readonly liveModels = new Map<string, KeyCheck>()
  private checkTimer: number | undefined
  private checkSeq = 0
  private setupHandlers: { check?: (provider: string, key: string, base?: string) => Promise<KeyCheck>; save?: (choice: SetupChoice) => void } = {}
  private aiHandlers: { use?: (id: string) => void; remove?: (id: string) => void; model?: (id: string, model: string) => void } = {}
  private languageHandler: ((code: Lang) => void) | undefined
  private accountHandlers: { signIn?: () => void; signOut?: () => void; remove?: () => void; cancel?: () => void; connect?: () => void } = {}
  private accountsOn = false
  private signedIn = false
  private prefs: Prefs = DEFAULT_PREFS
  private prefsHandler: ((change: Partial<Prefs>) => void) | undefined
  /** The calendar list is being filled in right now, so nothing may redraw it. */
  private editingCalendars = false
  private editingTimer: number | undefined
  private chatsView: ChatsView | null = null
  private chatHandlers: {
    create?: () => void
    open?: (id: string) => void
    remove?: (id: string) => void
    search?: (query: string) => void
    opened?: () => void
  } = {}

  constructor(private readonly root: HTMLElement) {
    root.innerHTML = TEMPLATE
    this.$ = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!

    this.$('.language-select').addEventListener('change', (event) =>
      this.languageHandler?.((event.target as HTMLSelectElement).value as Lang),
    )

    this.$('.setup-provider').addEventListener('change', () => this.renderSetup({ resetModel: true }))
    this.$('.setup-model').addEventListener('change', () => this.renderModelHelp())
    this.$('.setup-voice-provider').addEventListener('change', () => this.renderVoiceWhere())
    this.$('.setup-key').addEventListener('input', () => this.onKeyInput())
    this.$('.setup-base').addEventListener('input', () => this.onKeyInput())
    this.$('.setup-cancel').addEventListener('click', () => this.showSetup(false))
    this.$('.setup-save').addEventListener('click', () => this.submitSetup())
    for (const input of ['.setup-key', '.setup-voice-key']) {
      this.$(input).addEventListener('keydown', (event) => {
        if ((event as KeyboardEvent).key === 'Enter' && !(event as KeyboardEvent).isComposing) {
          event.preventDefault()
          this.submitSetup()
        }
      })
    }

    this.$('.ai-list').addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]')
      if (!button) return
      const id = button.closest<HTMLElement>('.ai-row')?.dataset.id ?? ''
      if (button.dataset.action === 'use') this.aiHandlers.use?.(id)
      if (button.dataset.action === 'remove') this.aiHandlers.remove?.(id)
    })
    this.$('.ai-list').addEventListener('change', (event) => {
      const select = event.target as HTMLSelectElement
      const id = select.closest<HTMLElement>('.ai-row')?.dataset.id ?? ''
      if (select.classList.contains('ai-model')) this.aiHandlers.model?.(id, select.value)
    })

    for (const selector of ['.account-signin', '.setup-signin']) {
      this.$(selector).addEventListener('click', () => this.accountHandlers.signIn?.())
    }
    this.$('.account-signout').addEventListener('click', () => this.accountHandlers.signOut?.())
    this.$('.account-delete').addEventListener('click', (event) => {
      if (confirmed(event.currentTarget as HTMLButtonElement, 'account.deleteConfirm', 'account.delete')) this.accountHandlers.remove?.()
    })
    this.$('.connect-openrouter').addEventListener('click', () => this.accountHandlers.connect?.())
    this.$('.signin-cancel').addEventListener('click', () => this.accountHandlers.cancel?.())
    this.$('.signin-copy').addEventListener('click', () => void this.copyLink())
    this.$('.signin-link').addEventListener('focus', (event) => (event.target as HTMLInputElement).select())

    this.wireChats()
    this.wirePrefs()
    this.applyLanguage()
  }

  private wireChats(): void {
    const panel = this.$<HTMLDetailsElement>('.chats')
    panel.addEventListener('toggle', () => {
      if (panel.open) this.chatHandlers.opened?.()
    })
    this.$('.chats-new').addEventListener('click', () => this.chatHandlers.create?.())
    this.$('.chats-search').addEventListener('input', (event) => this.chatHandlers.search?.((event.target as HTMLInputElement).value))
    this.$('.chats-list').addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]')
      const id = target?.closest<HTMLElement>('.chat-row')?.dataset.id
      if (!target || !id) return
      if (target.dataset.action === 'open') return this.chatHandlers.open?.(id)
      if (confirmed(target, 'chats.deleteConfirm', 'chats.delete')) this.chatHandlers.remove?.(id)
    })
  }

  private wirePrefs(): void {
    const change = (patch: Partial<Prefs>) => this.prefsHandler?.(patch)
    this.$('.pref-follow').addEventListener('change', (event) => change({ followUp: (event.target as HTMLInputElement).checked }))
    this.$('.pref-discreet').addEventListener('change', (event) => change({ discreet: (event.target as HTMLInputElement).checked }))
    this.$('.room-language').addEventListener('change', (event) => change({ roomLanguage: (event.target as HTMLSelectElement).value }))

    // Calendar links: a name and an address per row, saved as they change. While a row is
    // being filled in nothing redraws it, so a half-finished row isn't wiped from under
    // the person typing.
    const box = this.$('.calendar-list')
    box.addEventListener('change', () => this.saveCalendars())
    box.addEventListener('focusin', () => {
      this.editingCalendars = true
      window.clearTimeout(this.editingTimer)
    })
    box.addEventListener('focusout', () => {
      window.clearTimeout(this.editingTimer)
      this.editingTimer = window.setTimeout(() => (this.editingCalendars = false), 2500)
    })
    box.addEventListener('click', (event) => {
      const remove = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action="remove-row"]')
      if (!remove) return
      remove.closest('.edit-row')?.remove()
      this.$('.calendar-add').hidden = box.childElementCount >= MAX_CALENDARS
      this.saveCalendars()
    })
    this.$('.calendar-add').addEventListener('click', () => {
      if (box.childElementCount >= MAX_CALENDARS) return
      this.editingCalendars = true
      const row = this.calendarRow({ name: '', url: '' })
      box.append(row)
      this.$('.calendar-add').hidden = box.childElementCount >= MAX_CALENDARS
      row.querySelector('input')?.focus()
    })
  }

  private readCalendars(): CalendarLink[] {
    return [...this.$('.calendar-list').querySelectorAll<HTMLElement>('.edit-row')].map((row) => ({
      name: row.querySelector<HTMLInputElement>('[data-name="name"]')?.value.trim() ?? '',
      url: row.querySelector<HTMLInputElement>('[data-name="url"]')?.value.trim() ?? '',
    }))
  }

  private saveCalendars(): void {
    this.prefsHandler?.({ calendars: this.readCalendars() })
  }

  private calendarRow(link: CalendarLink): HTMLElement {
    const row = document.createElement('div')
    row.className = 'edit-row'
    for (const [name, placeholder, mono] of [['name', 'calendar.name', false], ['url', 'calendar.url', true]] as const) {
      const input = document.createElement('input')
      input.type = 'text'
      input.dataset.name = name
      input.value = link[name]
      input.dir = 'auto'
      if (mono) input.className = 'mono'
      input.setAttribute('placeholder', t(placeholder))
      input.setAttribute('aria-label', t(placeholder))
      row.append(input)
    }
    // Reading a calendar takes a moment, so each one says where it got to.
    const light = document.createElement('span')
    light.className = 'row-status'
    light.dataset.state = link.url ? 'wait' : 'new'
    light.textContent = t(link.url ? 'calendar.checking' : 'calendar.paste')
    const actions = document.createElement('div')
    actions.className = 'actions'
    actions.append(button(t('glassesMenu.remove'), 'remove-row'))
    row.append(light, actions)
    return row
  }

  /** How a calendar link is getting on: waiting, read (with how many events), or not working. */
  setCalendarStatus(url: string, state: 'wait' | 'ok' | 'bad', text: string): void {
    for (const row of this.$('.calendar-list').querySelectorAll<HTMLElement>('.edit-row')) {
      if (row.querySelector<HTMLInputElement>('[data-name="url"]')?.value.trim() !== url) continue
      const light = row.querySelector<HTMLElement>('.row-status')
      if (!light) continue
      light.dataset.state = state
      light.textContent = text
    }
  }

  /** Shows the preferences this app has, leaving alone a calendar row that's being typed in. */
  renderPrefs(prefs: Prefs): void {
    this.prefs = prefs
    this.$<HTMLInputElement>('.pref-follow').checked = prefs.followUp
    this.$<HTMLInputElement>('.pref-discreet').checked = prefs.discreet
    this.$<HTMLSelectElement>('.room-language').value = prefs.roomLanguage
    const box = this.$('.calendar-list')
    const shown = this.readCalendars().filter((c) => c.name || c.url)
    const busy = this.editingCalendars || box.contains(document.activeElement)
    if (!busy && JSON.stringify(shown) !== JSON.stringify(prefs.calendars)) {
      box.replaceChildren(...prefs.calendars.map((c) => this.calendarRow(c)))
    }
    this.$('.calendar-add').hidden = box.childElementCount >= MAX_CALENDARS
  }

  onPrefsChange(handler: (change: Partial<Prefs>) => void): void {
    this.prefsHandler = handler
  }

  // ── language ───────────────────────────────────────────────────────────

  /** Rewrites every label in the current language, and turns the page right to left for Arabic. */
  applyLanguage(): void {
    document.documentElement.lang = getLanguage()
    document.documentElement.dir = isRtl() ? 'rtl' : 'ltr'
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n as Key)
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-i18n-placeholder]')) {
      el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder as Key))
    }
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria as Key))
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-i18n-rich]')) setRich(el, t(el.dataset.i18nRich as Key))
    this.$('.log').dataset.empty = t('log.empty')
    this.$('.version').textContent = __APP_VERSION__
    this.$('.setup-title').textContent = t(this.addingAnother ? 'setup.titleAdd' : 'setup.title')
    this.setState(this.state)
    this.setSetupBusy(this.busy)
    this.renderLanguages()
    if (this.providers.length) this.setProviders(this.providers)
    const targets = TRANSLATE_TARGETS.map((code) => ({ value: code, label: languageLabel(code) })).sort((a, b) =>
      a.label.localeCompare(b.label, getLanguage()),
    )
    fillOptions(this.$('.room-language'), [{ value: '', label: t('glasses.roomLanguageAuto') }, ...targets])
    this.renderPrefs(this.prefs)
    for (const row of this.root.querySelectorAll<HTMLElement>('.calendar-list .edit-row')) {
      for (const [name, key] of [['name', 'calendar.name'], ['url', 'calendar.url']] as const) {
        row.querySelector(`[data-name="${name}"]`)?.setAttribute('placeholder', t(key))
      }
    }
    if (this.chatsView) this.renderChats(this.chatsView)
  }

  /** A language picked in Settings. */
  onChooseLanguage(handler: (code: Lang) => void): void {
    this.languageHandler = handler
  }

  private renderLanguages(): void {
    const select = this.$<HTMLSelectElement>('.language-select')
    select.replaceChildren(
      ...LANGUAGES.map(({ code, name }) => {
        const option = document.createElement('option')
        option.value = code
        option.textContent = name
        return option
      }),
    )
    select.value = getLanguage()
  }

  // ── state ──────────────────────────────────────────────────────────────

  setState(state: PhoneState): void {
    this.state = state
    const talk = this.$<HTMLButtonElement>('.talk')
    this.$('.pill').dataset.state = state
    this.$('.pill-label').textContent = t(`pill.${state}`)
    talk.dataset.state = state
    this.$('.talk-label').textContent = t(TALK_KEYS[state])
    talk.disabled = state === 'boot' || state === 'thinking'
    if (state !== 'listening') this.setLevel(0)
  }

  /** Microphone level, 0..1, drives the glow around the talk button. */
  setLevel(level: number): void {
    this.$('.talk').style.setProperty('--level', level.toFixed(2))
  }

  setPrivacyUrl(url: string): void {
    this.$('.privacy').textContent = url
  }

  // ── setup ──────────────────────────────────────────────────────────────

  setProviders(providers: ProviderInfo[]): void {
    this.providers = providers
    const noteFor = (p: ProviderInfo) => {
      // The picker is narrow on phones; the card explains the rest.
      if (!p.voice) return t('provider.noVoice')
      if (PROVIDER_NOTES[p.id]) return t(PROVIDER_NOTES[p.id])
      return getLanguage() === 'en' ? p.note : ''
    }
    const option = (p: ProviderInfo, note: string) => {
      const el = document.createElement('option')
      el.value = p.id
      el.textContent = note ? `${p.label} - ${note}` : p.label
      return el
    }

    const select = this.$<HTMLSelectElement>('.setup-provider')
    const previous = select.value
    const place = (id: string) => (PROVIDER_ORDER.indexOf(id) + 1 || 99)
    select.replaceChildren(...[...providers].sort((a, b) => place(a.id) - place(b.id)).map((p) => option(p, noteFor(p))))
    if (providers.some((p) => p.id === previous)) select.value = previous
    else if (providers.some((p) => p.id === RECOMMENDED_PROVIDER)) select.value = RECOMMENDED_PROVIDER

    const voiceSelect = this.$<HTMLSelectElement>('.setup-voice-provider')
    const voicePrevious = voiceSelect.value
    const rank = (id: string) => (VOICE_PICKER_ORDER.indexOf(id) + 1 || 99)
    voiceSelect.replaceChildren(
      ...providers
        .filter((p) => p.voice)
        .sort((a, b) => rank(a.id) - rank(b.id))
        .map((p) => option(p, noteFor(p))),
    )
    if (voicePrevious && [...voiceSelect.options].some((o) => o.value === voicePrevious)) voiceSelect.value = voicePrevious
    this.renderSetup({ resetModel: !previous || previous !== select.value })
  }

  /**
   * The AI this phone already hears with ("" if none). When set, choosing an AI that
   * can't hear needs no second key.
   */
  setVoiceCoverage(label: string): void {
    this.voiceCoverage = label
    this.renderVoiceBox()
  }

  /**
   * Shows or hides the setup card. `addingAnother` shows a Cancel button and a
   * different title for adding a second AI from settings.
   */
  showSetup(visible: boolean, options: { addingAnother?: boolean; provider?: string; reason?: string } = {}): void {
    this.$('.setup').hidden = !visible
    if (!visible) {
      this.setSetupStatus('')
      this.setSetupBusy(false)
      return
    }
    this.addingAnother = Boolean(options.addingAnother)
    this.$('.setup-title').textContent = t(this.addingAnother ? 'setup.titleAdd' : 'setup.title')
    this.$('.setup-cancel').hidden = !this.addingAnother
    this.$('.setup-signin').hidden = this.addingAnother || !this.accountsOn || this.signedIn
    if (options.provider && this.providers.some((p) => p.id === options.provider)) {
      this.$<HTMLSelectElement>('.setup-provider').value = options.provider
      this.renderSetup({ resetModel: true })
    }
    this.setSetupStatus(options.reason || '', options.reason ? 'error' : 'info')
    if (this.addingAnother) this.$('.setup').scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  setSetupStatus(text: string, tone: 'info' | 'error' | 'ok' = 'info'): void {
    const status = this.$('.setup-status')
    status.textContent = text
    status.dataset.tone = tone
  }

  setSetupBusy(busy: boolean): void {
    this.busy = busy
    const save = this.$<HTMLButtonElement>('.setup-save')
    save.disabled = busy
    save.textContent = t(busy ? 'setup.checking' : 'setup.save')
  }

  /** Called while a key is typed or pasted, to list the models it can use. */
  onCheckKey(handler: (provider: string, key: string, base?: string) => Promise<KeyCheck>): void {
    this.setupHandlers.check = handler
  }

  onSaveSetup(handler: (choice: SetupChoice) => void): void {
    this.setupHandlers.save = handler
  }

  clearSetupInput(): void {
    this.$<HTMLInputElement>('.setup-key').value = ''
    this.$<HTMLInputElement>('.setup-base').value = ''
    this.$<HTMLInputElement>('.setup-voice-key').value = ''
    this.renderSetup({ resetModel: true })
  }

  /** Remembers a checked key's models, so the picker can list them. */
  rememberKeyCheck(provider: string, key: string, check: KeyCheck, base = ''): void {
    if (check.ok) this.liveModels.set(`${provider}\n${key}\n${base}`, check)
  }

  /** The address typed for a server of the wearer's own, or "" for every other provider. */
  private baseTyped(): string {
    return this.selected()?.needsBase ? this.$<HTMLInputElement>('.setup-base').value.trim() : ''
  }

  private selected(): ProviderInfo | undefined {
    return this.providers.find((p) => p.id === this.$<HTMLSelectElement>('.setup-provider').value)
  }

  private voiceBoxShown(): boolean {
    const provider = this.selected()
    return Boolean(provider && !provider.voice && !this.voiceCoverage)
  }

  private renderSetup({ resetModel }: { resetModel: boolean }): void {
    const provider = this.selected()
    // A server of their own is described by its address, not by where to get a key.
    this.$('.setup-base-field').hidden = !provider?.needsBase
    this.$('.setup-where').textContent = !provider
      ? ''
      : provider.needsBase
        ? t('setup.keyOptional')
        : `${t('setup.getKey', { url: provider.keyUrl })}\n${t('setup.keySteps')}`
    this.renderModels(resetModel)
    this.renderVoiceBox()
    this.scheduleKeyCheck()
  }

  private renderModels(resetModel: boolean): void {
    const provider = this.selected()
    const select = this.$<HTMLSelectElement>('.setup-model')
    if (!provider) {
      select.replaceChildren()
      return
    }
    const key = this.$<HTMLInputElement>('.setup-key').value.trim()
    const live = this.liveModels.get(`${provider.id}\n${key}\n${this.baseTyped()}`)
    const popular = localized(provider.models)
    const previous = resetModel ? '' : select.value
    const choices = modelChoices(popular, live ? live.models : null)
    const fallback = live?.defaultModel || provider.defaultModel || popular[0]?.id || ''
    const keep = previous && (live ? matchModel(previous, live.models) : previous)
    const groups = { popular: t('model.groupPopular'), all: t('model.groupAll') }
    if (!choices.popular.length && !choices.others.length) {
      fillModelSelect(select, { popular: [{ id: '', name: t('model.recommendedForAi') }], others: [] }, '', groups)
    } else {
      const pick = keep || matchModel(fallback, [...choices.popular, ...choices.others]) || choices.popular[0]?.id || choices.others[0]?.id || ''
      fillModelSelect(select, choices, pick, groups)
    }
    this.renderModelHelp()
  }

  private renderModelHelp(text?: string): void {
    const provider = this.selected()
    const key = this.$<HTMLInputElement>('.setup-key').value.trim()
    const live = provider && this.liveModels.get(`${provider.id}\n${key}\n${this.baseTyped()}`)
    this.$('.setup-model-help').textContent = text ?? (live ? t('model.works', { n: live.models.length }) : t('model.popular'))
  }

  private renderVoiceBox(): void {
    const provider = this.selected()
    const box = this.$('.voice-box')
    const covered = this.$('.voice-covered')
    box.hidden = !this.voiceBoxShown()
    covered.hidden = !(provider && !provider.voice && this.voiceCoverage)
    if (!provider || provider.voice) return
    const name = shortName(provider.label)
    this.$('.voice-title').textContent = t('voice.cantTitle', { name })
    this.$('.voice-why').textContent = t('voice.cantWhy', { name })
    covered.textContent = t('voice.covered', { name, voice: this.voiceCoverage })
    this.renderVoiceWhere()
  }

  private renderVoiceWhere(): void {
    const voice = this.providers.find((p) => p.id === this.$<HTMLSelectElement>('.setup-voice-provider').value)
    this.$('.setup-voice-where').textContent = voice ? `${t('setup.getKey', { url: voice.keyUrl })}\n${t('setup.keySteps')}` : ''
  }

  /** A key was typed or pasted: list its models if it's already checked, otherwise check it shortly. */
  private onKeyInput(): void {
    const provider = this.selected()
    const key = this.$<HTMLInputElement>('.setup-key').value.trim()
    if (provider && this.liveModels.has(`${provider.id}\n${key}\n${this.baseTyped()}`)) this.setSetupStatus('')
    this.renderModels(false)
    this.scheduleKeyCheck()
  }

  private scheduleKeyCheck(): void {
    window.clearTimeout(this.checkTimer)
    const provider = this.selected()
    const key = this.$<HTMLInputElement>('.setup-key').value.trim()
    const base = this.baseTyped()
    // A server of their own is checked by its address; the key can be empty.
    const enough = provider?.needsBase ? ADDRESS.test(base) && (!key || plausibleKey(key)) : plausibleKey(key)
    if (!provider || !enough || this.liveModels.has(`${provider.id}\n${key}\n${base}`) || !this.setupHandlers.check) {
      this.renderModelHelp()
      return
    }
    this.checkTimer = window.setTimeout(() => void this.checkKeyNow(provider.id, key, base), CHECK_DELAY_MS)
  }

  private async checkKeyNow(provider: string, key: string, base = ''): Promise<void> {
    const seq = ++this.checkSeq
    this.renderModelHelp(t('model.checking'))
    if (this.$('.setup-status').dataset.tone === 'error') this.setSetupStatus('')
    let check: KeyCheck
    try {
      check = await this.setupHandlers.check!(provider, key, base)
    } catch {
      check = { ok: false, error: t('setup.serverDown'), models: [], defaultModel: '' }
    }
    const stillShown =
      seq === this.checkSeq &&
      this.selected()?.id === provider &&
      this.$<HTMLInputElement>('.setup-key').value.trim() === key &&
      this.baseTyped() === base
    if (!stillShown) return
    if (check.ok) {
      this.rememberKeyCheck(provider, key, check, base)
      this.renderModels(false)
      this.setSetupStatus('')
    } else {
      this.renderModelHelp()
      this.setSetupStatus(check.error, 'error')
    }
  }

  private submitSetup(): void {
    const provider = this.selected()
    const key = this.$<HTMLInputElement>('.setup-key').value.trim()
    const base = this.baseTyped()
    if (!provider) return this.setSetupStatus(t('setup.noProviders'), 'error')
    if (provider.needsBase && !ADDRESS.test(base)) return this.setSetupStatus(t('setup.addressFirst'), 'error')
    if (!key && !provider.keyOptional) return this.setSetupStatus(t('setup.pasteKeyFirst', { provider: provider.label }), 'error')
    const voiceKey = this.voiceBoxShown() ? this.$<HTMLInputElement>('.setup-voice-key').value.trim() : ''
    window.clearTimeout(this.checkTimer)
    this.setupHandlers.save?.({
      provider: provider.id,
      model: this.$<HTMLSelectElement>('.setup-model').value,
      key,
      base,
      voiceProvider: voiceKey ? this.$<HTMLSelectElement>('.setup-voice-provider').value : '',
      voiceKey,
    })
  }

  // ── Account, and the browser link panel ────────────────────────────────

  /** Shows signing in (Settings, and the setup card) once the server offers accounts. */
  setAccountsAvailable(on: boolean): void {
    this.accountsOn = on
    this.$('.account').hidden = !on
    this.$('.setup-signin').hidden = this.addingAnother || !on || this.signedIn
  }

  /** The Account section: who is signed in and how, or an invitation to sign in. */
  renderAccount(account: { who: string; method: string } | null): void {
    this.signedIn = Boolean(account)
    const who = this.$('.account-who')
    who.hidden = !account
    who.textContent = account ? t('account.signedInAs', account) : ''
    this.$('.account-help').textContent = t(account ? 'account.syncHelp' : 'account.signedOutHelp')
    this.$('.account-signin').hidden = Boolean(account)
    this.$('.account-signout').hidden = !account
    this.$('.account-delete').hidden = !account
    this.$('.setup-signin').hidden = this.addingAnother || !this.accountsOn || Boolean(account)
  }

  /**
   * The browser link panel, for signing in or connecting OpenRouter: waiting for a link,
   * showing the link (and, for signing in, the code to check), or hidden.
   */
  showSignIn(state: { url: string; code: string } | 'starting' | null, kind: LinkKind = 'account'): void {
    const panel = this.$('.signin')
    panel.hidden = state === null
    if (state === null) return this.setSignInStatus('')
    this.$('.signin-title').textContent = t(kind === 'account' ? 'account.title' : 'connect.title')
    this.$('.signin-intro').textContent = t(kind === 'account' ? 'account.intro' : 'connect.intro')
    const link = state === 'starting' ? null : state
    const input = this.$<HTMLInputElement>('.signin-link')
    input.value = link?.url ?? ''
    input.hidden = !link
    this.$('.signin-copy').hidden = !link
    const next = this.$('.signin-code')
    next.hidden = !link
    if (link) setRich(next, kind === 'account' ? t('account.step2', { code: `**${link.code}**` }) : t('connect.step2'))
    this.setSignInStatus(t(link ? 'account.waiting' : 'account.starting'))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  private setSignInStatus(text: string, tone: 'info' | 'error' | 'ok' = 'info'): void {
    const status = this.$('.signin-status')
    status.textContent = text
    status.dataset.tone = tone
  }

  onSignIn(handler: () => void): void {
    this.accountHandlers.signIn = handler
  }

  onSignOut(handler: () => void): void {
    this.accountHandlers.signOut = handler
  }

  /** Delete account, after its second tap. */
  onDeleteAccount(handler: () => void): void {
    this.accountHandlers.remove = handler
  }

  onCancelSignIn(handler: () => void): void {
    this.accountHandlers.cancel = handler
  }

  /** Connect OpenRouter, on the setup card. */
  onConnect(handler: () => void): void {
    this.accountHandlers.connect = handler
  }

  /** Copies the link. If the WebView allows neither way, the link is left selected to copy by hand. */
  private async copyLink(): Promise<void> {
    const input = this.$<HTMLInputElement>('.signin-link')
    let copied = false
    try {
      await navigator.clipboard.writeText(input.value)
      copied = true
    } catch {
      input.focus()
      input.setSelectionRange(0, input.value.length)
      try {
        copied = document.execCommand('copy')
      } catch {
        copied = false
      }
    }
    if (copied) this.setSignInStatus(t('account.copied'), 'ok')
  }

  // ── settings ───────────────────────────────────────────────────────────

  renderAiList(rows: AiRow[]): void {
    const list = this.$('.ai-list')
    if (!rows.length) {
      const empty = document.createElement('p')
      empty.className = 'help'
      empty.textContent = t('settings.noAi')
      list.replaceChildren(empty)
      return
    }
    const groups = { popular: t('model.groupPopular'), all: t('model.groupAll') }
    list.replaceChildren(
      ...rows.map((row) => {
        const item = document.createElement('div')
        item.className = 'ai-row'
        item.dataset.id = row.id
        item.dataset.active = String(row.active)

        const head = document.createElement('div')
        head.className = 'ai-head'
        const name = document.createElement('b')
        name.textContent = row.label
        const detail = document.createElement('span')
        detail.className = 'help'
        detail.textContent = row.active ? `${t('ai.inUse')} · ${row.detail}` : row.detail
        head.append(name, detail)

        const select = document.createElement('select')
        select.className = 'ai-model'
        select.setAttribute('aria-label', `${row.label} ${t('setup.model')}`)
        const popular = localized(this.providers.find((p) => p.id === row.id)?.models)
        fillModelSelect(select, modelChoices(popular, row.models.length ? row.models : null), row.model, groups)
        if (!select.options.length) {
          fillModelSelect(select, { popular: [{ id: row.model, name: row.model || t('model.default') }], others: [] }, row.model, groups)
        }

        const actions = document.createElement('div')
        actions.className = 'actions'
        if (!row.active) actions.append(button(t('ai.use'), 'use'))
        actions.append(button(t('ai.remove'), 'remove'))

        item.append(head, select, actions)
        return item
      }),
    )
  }

  onUseAi(handler: (id: string) => void): void {
    this.aiHandlers.use = handler
  }

  onRemoveAi(handler: (id: string) => void): void {
    this.aiHandlers.remove = handler
  }

  onPickModel(handler: (id: string, model: string) => void): void {
    this.aiHandlers.model = handler
  }

  onAddAi(handler: () => void): void {
    this.$('.add-ai').addEventListener('click', handler)
  }

  onSettingsOpen(handler: () => void): void {
    const details = this.$<HTMLDetailsElement>('.settings')
    details.addEventListener('toggle', () => {
      if (details.open) handler()
    })
  }

  renderVoice(options: VoiceOption[], selected: string, help: string): void {
    const select = this.$<HTMLSelectElement>('.voice-select')
    select.replaceChildren(
      ...options.map((o) => {
        const option = document.createElement('option')
        option.value = o.value
        option.textContent = o.label
        return option
      }),
    )
    select.value = selected
    this.$('.voice-help').textContent = help
  }

  onPickVoice(handler: (value: string) => void): void {
    this.$<HTMLSelectElement>('.voice-select').addEventListener('change', (event) =>
      handler((event.target as HTMLSelectElement).value),
    )
  }

  // ── saved chats ────────────────────────────────────────────────────────

  /** The chat this phone is in, and the list of saved chats (or what a search found). */
  renderChats(view: ChatsView): void {
    this.chatsView = view
    this.$('.chats-current').textContent = view.title
    const list = this.$('.chats-list')
    if (!view.chats.length) {
      const empty = document.createElement('p')
      empty.className = 'help'
      empty.textContent = t(view.searching ? 'chats.noMatch' : 'chats.empty')
      list.replaceChildren(empty)
      return
    }
    list.replaceChildren(
      ...view.chats.map((chat) => {
        const row = document.createElement('div')
        row.className = 'chat-row'
        row.dataset.id = chat.id
        row.dataset.current = String(chat.id === view.current)
        const open = document.createElement('button')
        open.type = 'button'
        open.className = 'chat-open'
        open.dataset.action = 'open'
        const title = document.createElement('b')
        title.dir = 'auto'
        title.textContent = chat.title || t('chats.untitled')
        const detail = document.createElement('span')
        detail.className = 'help'
        detail.textContent = [lastUsed(chat.updated), t('chats.messages', { n: chat.count })].join(' · ')
        open.append(title, detail)
        row.append(open, button(t('chats.delete'), 'delete'))
        return row
      }),
    )
  }

  closeChats(): void {
    this.$<HTMLDetailsElement>('.chats').open = false
  }

  onNewChat(handler: () => void): void {
    this.chatHandlers.create = handler
  }

  onOpenChat(handler: (id: string) => void): void {
    this.chatHandlers.open = handler
  }

  /** Delete on a chat in the list, after its second tap. */
  onDeleteChat(handler: (id: string) => void): void {
    this.chatHandlers.remove = handler
  }

  /** What's typed in the chat search, as it's typed. */
  onSearchChats(handler: (query: string) => void): void {
    this.chatHandlers.search = handler
  }

  /** The chats panel was opened: a good moment to refresh the list. */
  onChatsOpen(handler: () => void): void {
    this.chatHandlers.opened = handler
  }

  /** Delete this chat, in Settings. */
  onClearConversation(handler: () => void): void {
    this.$('.clear').addEventListener('click', handler)
  }

  onForgetEverything(handler: () => void): void {
    this.$('.forget').addEventListener('click', handler)
  }

  // ── conversation ───────────────────────────────────────────────────────

  /** Adds the user's line; voice notes start as a placeholder until the transcript arrives. */
  addYou(text: string): PendingLine {
    const body = this.addEntry('you', t('entry.you'), text)
    return {
      update: (next) => {
        body.textContent = next
      },
    }
  }

  addEdith(text: string): void {
    this.addEntry('edith', 'EDITH', stripMarkdown(text))
  }

  /**
   * An EDITH entry that fills in as the answer streams. It appears with the first words.
   * `from` names the AI when the answer is a second opinion from another one.
   */
  addEdithLive(from = ''): LiveAnswer {
    let body: HTMLElement | null = null
    let text = ''
    const who = from ? `EDITH · ${from}` : 'EDITH'
    const ensure = () => (body ??= this.addEntry('edith', who, ''))
    return {
      append: (delta) => {
        text += delta
        ensure().textContent = text
        body?.scrollIntoView({ block: 'end' })
      },
      reset: () => {
        text = ''
        if (body) body.textContent = ''
      },
      finish: (final, toolsUsed = []) => {
        const el = ensure()
        el.textContent = stripMarkdown(final)
        this.addTools(el, toolsUsed)
      },
      discard: () => {
        body?.closest('.entry')?.remove()
        body = null
      },
    }
  }

  addNote(text: string, tone: 'info' | 'error' = 'info'): void {
    const note = document.createElement('div')
    note.className = `note ${tone}`
    note.textContent = text
    this.append(note)
  }

  clearLog(): void {
    this.$('.log').replaceChildren()
  }

  onTalk(handler: () => void): void {
    this.$('.talk').addEventListener('click', handler)
  }

  onSend(handler: (text: string) => void): void {
    const input = this.$<HTMLInputElement>('.compose-input')
    const send = () => {
      const text = input.value.trim()
      if (!text) return
      input.value = ''
      handler(text)
    }
    this.$('.compose').addEventListener('submit', (event) => {
      event.preventDefault()
      send()
    })
    // Some WebView keyboards don't submit the form on their Send key; handle Enter directly.
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return
      event.preventDefault()
      send()
    })
  }

  private addTools(body: HTMLElement, toolsUsed: string[]): void {
    const known = new Set(['web_search', 'wikipedia', 'weather_report', 'news_headlines', 'daily_briefing'])
    const tools = toolsUsed
      .filter((name) => known.has(name))
      .map((name) => t(`tool.${name}` as Key))
    if (!tools.length) return
    const meta = document.createElement('div')
    meta.className = 'meta'
    meta.textContent = t('tools.used', { tools: [...new Set(tools)].join(t('list.sep')) })
    body.after(meta)
  }

  private addEntry(kind: 'you' | 'edith', label: string, text: string): HTMLElement {
    const entry = document.createElement('article')
    entry.className = `entry ${kind}`
    const who = document.createElement('div')
    who.className = 'who'
    who.textContent = label
    const body = document.createElement('div')
    body.className = 'body'
    body.dir = 'auto'
    body.textContent = text
    entry.append(who, body)
    this.append(entry)
    return body
  }

  private append(node: HTMLElement): void {
    const log = this.$('.log')
    log.append(node)
    while (log.childElementCount > 60) log.firstElementChild?.remove()
    node.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }
}

function button(label: string, action: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'button quiet'
  b.dataset.action = action
  b.textContent = label
  return b
}
