// EDITH's state machine: glasses input -> microphone -> EDITH's server -> display.
//
//   setup ──AI key saved, OpenRouter connected, or signed in──▶ idle
//
//   idle ──hold / tap──▶ listening ──release / tap / pause──▶ thinking ──▶ idle
//     ▲                      │ double-tap                         │ double-tap
//     └──────────────────────┴────────────────────────────────────┘
//
//   idle ──menu: Subtitles / Live translation──▶ room ──double-tap──▶ idle
//
// EDITH 2.0 is the simple EDITH: you talk, an AI answers on your glasses, with whichever
// key you have. Kept from 1.x because people use them: accounts (keys and settings on every
// phone), saved chats, discreet mode, subtitles and live translation of whoever is talking
// to the wearer, a second opinion from another AI, and calendars sent along with questions.
//
// Double-tap on the idle and setup screens opens the host's exit dialogue, which Even Hub
// review requires. Tap then long press opens the glasses menu.
//
// Words on the phone come from t() and words on the glasses from tg(), in the phone's
// language or the one picked in Settings (see i18n/).

import { AudioInputSource, OsEventTypeList, type DeviceStatus, type EvenAppBridge, type EvenHubEvent } from '@evenrealities/even_hub_sdk'
import {
  ApiError,
  EdithApi,
  type Access,
  type AccountInfo,
  type AnswerOptions,
  type AskPayload,
  type CalendarSend,
  type ChatSummary,
  type ChatTurn,
  type ConnectLink,
  type ConnectPoll,
  type ModelInfo,
  type ProviderInfo,
  type SignInLink,
  type SignInPoll,
  type SyncedProfile,
} from './api'
import { BODY_CHARS_PER_LINE, BODY_LINES, Hud, type MenuItem } from './hud'
import { upcomingEvents } from './ical'
import { getLanguage, glassesLocale, guessLanguage, isLang, languageName, setLanguage, t, tg, type GlassesKey, type Key, type Lang } from './i18n'
import { matchModel } from './models'
import { shortName, type AiRow, type KeyCheck, type LiveAnswer, type Phone, type PendingLine, type PhoneState, type SetupChoice, type VoiceOption } from './phone'
import { DEFAULT_PREFS, cleanPrefs, type Prefs } from './prefs'
import { Recorder, type StopReason } from './recorder'
import { RoomEars } from './room'
import { clip, estimateLines, forGlasses, tailToFit } from './text'

type Mode = PhoneState
type Trigger = 'tap' | 'hold' | 'phone'

interface SavedKey {
  key: string
  model: string
  label: string
  voice: boolean
  /** "Your own server": the https address it answers on. */
  base?: string
}

// The same keys as EDITH 1.x, so an update keeps everyone's AIs, account and chats.
const STORAGE = {
  deviceId: 'edith.deviceId',
  language: 'edith.language',
  keys: 'edith.keys',
  active: 'edith.active',
  voice: 'edith.voice',
  providers: 'edith.providers',
  legacyGeminiKey: 'edith.geminiKey',
  session: 'edith.session',
  account: 'edith.account',
  profileUpdatedAt: 'edith.profileUpdatedAt',
  // The full 1.x preferences are kept (and synced), so a phone still on 1.x loses nothing;
  // 2.0 uses follow-ups, discreet, the room language and calendars.
  prefs: 'edith.prefs',
  chatId: 'edith.chatId',
}
// How often the phone asks whether the browser step (sign-in or OpenRouter) is done.
const SIGN_IN_POLL_MS = 3000
// Settings changes are saved to the account together, shortly after the last one.
const PROFILE_SAVE_DELAY_MS = 1500
// Voice falls back through these, fastest and free first.
const VOICE_ORDER = ['groq', 'gemini', 'openai', 'mistral', 'xai', 'openrouter']
const LEVEL_BARS = '▁▂▃▄▅▆▇█'
const THINKING_FRAMES = ['●○○', '○●○', '○○●', '○●○']
const TOOL_STATUS: Record<string, GlassesKey> = {
  weather_report: 'g.status.weather',
  web_search: 'g.status.searching',
  wikipedia: 'g.status.lookingUp',
  news_headlines: 'g.status.news',
  daily_briefing: 'g.status.briefing',
  recall_conversations: 'g.status.remembering',
  // EDITH 3: the wearer's own PC
  link_pc: 'g.status.linking',
  pc_status: 'g.status.pc',
  pc_find_files: 'g.status.pc',
  pc_list_folder: 'g.status.pc',
  pc_read_file: 'g.status.pc',
  pc_write_file: 'g.status.pc',
  pc_open: 'g.status.pc',
  pc_run_command: 'g.status.pc',
  pc_clipboard: 'g.status.pc',
  pc_notify: 'g.status.pc',
  pc_schedule_task: 'g.status.pc',
  pc_tasks: 'g.status.pc',
}

// The same ids as 1.x, so a menu tap means the same thing in every version.
const MENU = { newChat: 1, switchAi: 3, second: 10, discreet: 11, subtitles: 14, translate: 15, agent: 20 }
// EDITH 3: how often, and for how long, the glasses check on a long task of the wearer's agent.
const AGENT_POLL_MS = 4000
const AGENT_WAIT_MS = 30 * 60 * 1000
const AGENT_MODE_KEY = 'edith.agentMode'

// Questions and answers sent along as context, and messages shown when a chat opens.
const CHAT_TURNS = 20
const CHAT_SHOWN = 60
// A new chat's title arrives a few seconds after its first answer, and again after the sixth.
const TITLE_REFRESH_MS = 6000
// Starting EDITH carries on with the chat from before if it was this recent.
const CONTINUE_CHAT_MS = 12 * 60 * 60 * 1000
const SEARCH_DELAY_MS = 350
// The calendar is read again every quarter of an hour, for the next fortnight.
const CALENDAR_EVERY_MS = 15 * 60 * 1000
const CALENDAR_DAYS = 14
const CALENDAR_MAX = 60
// After an answer, EDITH keeps listening for a moment, so a follow-up needs no tap.
const FOLLOW_UP_AFTER_MS = 600
const FOLLOW_UPS_IN_A_ROW = 5
// A follow-up nobody speaks into closes the microphone again, even if the glasses stop
// sending audio and the recorder never hears the silence itself.
const FOLLOW_UP_WINDOW_MS = 9000
// Subtitles end by themselves so the glasses are never left listening all day.
const ROOM_MAX_MS = 45 * 60 * 1000
const ROOM_TICK_MS = 1000
const ROOM_LINES = 4
const ROOM_FAILURES_MAX = 3
// Counted narrower than the panel really is, since the font is proportional, so the newest
// words always stay in view.
const SAFE_CHARS_PER_LINE = 46

// The firmware can report one physical gesture twice, ~50-100 ms apart.
const INPUT_DEDUPE_MS = 250
const LIFECYCLE_DEDUPE_MS = 600
// A long press may be followed by a click as the finger lifts.
const CLICK_AFTER_HOLD_MS = 700
// The contextual menu opens on tap then long press, so a foreground event this
// soon after touch input is the menu, not a return from the background.
const MENU_GESTURE_MS = 2500

export class Edith {
  private mode: Mode = 'boot'
  private readonly hud: Hud
  private readonly api: EdithApi
  private deviceId = ''
  private firstName = ''
  private history: ChatTurn[] = []
  private last: { you: string; reply: string } | null = null
  /** EDITH 3: a job on the wearer's PC waiting for their tap to approve it. */
  private approval: { what: string; token: string } | null = null
  /** EDITH 3: questions go straight to the wearer's own agent on their PC. */
  private agentMode = readAgentMode()
  /** The last question as it was asked, for a second opinion. */
  private lastAsked = ''
  private prefs: Prefs = { ...DEFAULT_PREFS }

  // Saved chats: the one this phone is in, the list, and a search of it.
  private chatId = ''
  private chats: ChatSummary[] = []
  private chatsQuery = ''
  private chatsFound: ChatSummary[] = []
  private answersInChat = 0
  // Counts questions, and chats opened or started, so a slow chat list can't replace a newer chat.
  private chatEpoch = 0
  private chatsTimer: number | undefined
  private searchTimer: number | undefined

  private keys: Record<string, SavedKey> = {}
  private active = ''
  private voicePref = 'auto'
  private session = ''
  private account: AccountInfo | null = null
  private accountsOn = false
  private profileUpdatedAt = 0
  private profileTimer: number | undefined
  // A browser flow in progress: signing in to an account, or connecting OpenRouter. One at a time.
  private signIn:
    | ({ timer: number; expires: number; polling: boolean } & ({ kind: 'account'; link: SignInLink } | { kind: 'openrouter'; link: ConnectLink }))
    | null = null
  private sessionEnding = false
  private providers: ProviderInfo[] = []
  private readonly modelCache = new Map<string, ModelInfo[]>()
  private readonly keyChecks = new Map<string, Promise<KeyCheck>>()

  private recorder: Recorder | null = null
  private trigger: Trigger = 'tap'
  private micOpen = false
  private ticker: number | undefined
  private request: { controller: AbortController; you: PendingLine; live: LiveAnswer } | null = null
  private followUps = 0
  private followUpTimer: number | undefined
  private followUpStopTimer: number | undefined
  /** A follow-up listens without taking the answer off the glasses, until they speak. */
  private quietListening = false

  // Subtitles of whoever is talking to the wearer, translated or not.
  private room: { ears: RoomEars; controller: AbortController | null; failures: number; translate: boolean } | null = null
  private roomTicker: number | undefined

  // The wearer's calendars, read on the phone and sent along with each question.
  private calendar: CalendarSend[] = []
  private calendarAt = 0
  private calendarTimer: number | undefined

  private battery: { level?: number; charging?: boolean } = {}
  private statusKind: 'online' | 'more' | 'setup' = 'online'
  private clock = ''
  private clockTimers: number[] = []

  private exitDialogOpen = false
  private menuOpen = false
  private lastInputAt = 0
  private readonly lastEventAt = new Map<string, number>()
  private holdReleasedAt = 0
  private unsubscribers: Array<() => void> = []

  constructor(
    private readonly bridge: EvenAppBridge,
    private readonly phone: Phone,
  ) {
    this.hud = new Hud(bridge, { title: '◆ E.D.I.T.H', status: tg('g.status.starting'), body: tg('g.initialising') }, this.menuItems())
    this.api = new EdithApi(
      __API_BASE__,
      () => this.deviceId,
      () => this.access(),
      () => this.session,
      () => void this.onSessionEnded(),
    )
  }

  async start(): Promise<void> {
    this.unsubscribers.push(this.bridge.onEvenHubEvent((event) => this.onEvent(event)))
    window.addEventListener('pagehide', () => this.shutdown())
    this.wirePhone()

    const pageReady = this.hud.start()
    await Promise.all([this.loadAccess(), this.loadIdentity()])
    this.phone.applyLanguage()
    this.hud.setMenu(this.menuItems())
    this.renderSettings()
    await pageReady
    void this.hud.setDim(this.prefs.discreet)
    this.startClock()
    void this.watchBattery()

    // Deployed builds talk to their own site; only the dev server needs EDITH_URL to proxy to.
    if (import.meta.env.DEV && !__EDITH_URL__) {
      this.phone.addNote('EDITH_URL is not set. Add it to .env.local and restart npm run dev.', 'error')
      this.showError('NO SERVER', 'EDITH server not configured.', 'Set EDITH_URL in .env.local,\nthen restart the dev server.')
      return
    }

    // Development only, removed from builds entirely: drives the simulator for store
    // screenshots. ?demoProvider=groq&demoKey=...&demoName=&demoBattery=76&demoLanguage=ja&ask=question
    // plus demoKey2/demoProvider2/demoLabel2 and &second for a second opinion after the answer, and
    // demoRoom=subtitles|translate with demoLines=line|line for the subtitle screen (the
    // simulator never marks audio as someone else's, so the room can't fill itself there).
    if (import.meta.env.DEV) {
      const params = new URLSearchParams(location.search)
      const demoKey = params.get('demoKey')
      if (demoKey) {
        const provider = params.get('demoProvider') || 'gemini'
        this.keys = { [provider]: { key: demoKey, model: params.get('demoModel') || 'auto', label: params.get('demoLabel') || provider, voice: true } }
        this.active = provider
        const second = params.get('demoProvider2')
        const secondKey = params.get('demoKey2')
        if (second && secondKey) this.keys[second] = { key: secondKey, model: params.get('demoModel2') || 'auto', label: params.get('demoLabel2') || second, voice: true }
      }
      const demoRoom = params.get('demoRoom')
      if (demoRoom) {
        // Built without the microphone, which a PC simulator may not have.
        window.setTimeout(() => {
          const room = { ears: new RoomEars(), controller: null, failures: 0, translate: demoRoom === 'translate' }
          for (const line of (params.get('demoLines') || '').split('|').filter(Boolean)) room.ears.add(forGlasses(line))
          this.room = room
          this.setMode('idle')
          this.renderRoom()
          this.roomTicker = window.setInterval(() => this.roomTick(), ROOM_TICK_MS)
        }, 1500)
      }
      const demoName = params.get('demoName')
      if (demoName !== null) this.firstName = demoName
      const demoBattery = params.get('demoBattery')
      if (demoBattery) this.battery = { level: Number(demoBattery), charging: false }
      const demoLanguage = params.get('demoLanguage')
      if (demoLanguage && isLang(demoLanguage)) {
        setLanguage(demoLanguage)
        this.phone.applyLanguage()
      }
      const question = params.get('ask')
      if (question) {
        window.setTimeout(async () => {
          // Asked "from the phone", so the microphone doesn't reopen for a follow-up.
          this.trigger = 'phone'
          await this.ask({ text: question })
          if (params.has('second')) await this.secondOpinion()
        }, 1500)
      }
    }

    this.goHome()
    void this.loadProviders()
    void this.loadChats()
    void this.loadAccount()
    this.watchCalendar()
  }

  // ── Input ───────────────────────────────────────────────────────────────

  private onEvent(event: EvenHubEvent): void {
    const audio = event.audioEvent
    if (audio?.audioPcm) {
      this.recorder?.push(audio.audioPcm, audio.speakerRole)
      // Subtitles listen to the other half of the room: the frames a question ignores.
      if (this.room) {
        this.room.ears.push(audio.audioPcm, audio.speakerRole)
        this.pumpRoom()
      }
    }

    const menuItem = event.menuItemClickEvent?.itemID
    if (menuItem !== undefined) return this.onMenuItem(menuItem)

    const type = eventTypeOf(event)
    if (type === null) return

    const now = Date.now()
    const lifecycle = type >= OsEventTypeList.FOREGROUND_ENTER_EVENT && type <= OsEventTypeList.SYSTEM_EXIT_EVENT
    // One physical gesture can be reported twice.
    const same = String(type)
    if (now - (this.lastEventAt.get(same) ?? 0) < (lifecycle ? LIFECYCLE_DEDUPE_MS : INPUT_DEDUPE_MS)) return
    this.lastEventAt.set(same, now)
    if (!lifecycle && type !== OsEventTypeList.IMU_DATA_REPORT) this.lastInputAt = now

    switch (type) {
      case OsEventTypeList.CLICK_EVENT:
        return this.onTap()
      case OsEventTypeList.DOUBLE_CLICK_EVENT:
        return this.onDoubleTap()
      case OsEventTypeList.LONG_PRESS_EVENT:
        return this.onHoldStart()
      case OsEventTypeList.LONG_PRESS_RELEASE_EVENT:
        return this.onHoldEnd()
      case OsEventTypeList.FOREGROUND_ENTER_EVENT:
        return this.onForegroundEnter()
      case OsEventTypeList.FOREGROUND_EXIT_EVENT:
        return this.onForegroundExit()
      case OsEventTypeList.SYSTEM_EXIT_EVENT:
      case OsEventTypeList.ABNORMAL_EXIT_EVENT:
        return this.shutdown()
    }
  }

  private onTap(): void {
    if (Date.now() - this.holdReleasedAt < CLICK_AFTER_HOLD_MS) return
    if (this.approval && this.mode === 'idle') return void this.approve()
    if (this.mode === 'listening') return void this.finishListening('manual')
    if (this.canListen()) void this.startListening('tap')
  }

  /** Idle, after an error, or on the setup screen, where a tap or hold brings the setup card back. */
  private canListen(): boolean {
    if (this.room) return false
    return this.mode === 'idle' || this.mode === 'error' || this.mode === 'setup'
  }

  private onDoubleTap(): void {
    // A job for the PC waiting for a tap: a double-tap says no, and nothing runs.
    if (this.approval) {
      this.approval = null
      return this.goIdle(tg('g.approveCancelled'))
    }
    // Subtitles hold the display, so they are what a double-tap puts down first.
    if (this.room) return this.stopRoom()
    // A follow-up nobody has spoken into yet is still the home screen to the wearer: a
    // double-tap there must open the exit dialogue (Even Hub requires it), not just cancel.
    if (this.mode === 'listening' && this.quietListening) this.cancelListening(true)
    else if (this.mode === 'listening') return this.cancelListening()
    if (this.mode === 'thinking') return this.cancelRequest()
    this.exitDialogOpen = true
    void this.bridge.shutDownPageContainer(1)
  }

  private onHoldStart(): void {
    // Asking something else instead of approving: the job waits no longer.
    if (this.canListen()) this.approval = null
    if (this.canListen()) void this.startListening('hold')
  }

  private onHoldEnd(): void {
    this.holdReleasedAt = Date.now()
    if (this.mode === 'listening' && this.trigger === 'hold') void this.finishListening('manual')
  }

  private onForegroundEnter(): void {
    if (this.exitDialogOpen) {
      // The exit dialogue appeared and the host has already cleared our page.
      void this.hud.rebuild()
      return
    }
    if (Date.now() - this.lastInputAt < MENU_GESTURE_MS) {
      // The contextual menu opened. Its first tap may have started listening: stop quietly.
      // No rebuild here: on the glasses a rebuild would close the menu again.
      this.menuOpen = true
      if (this.mode === 'listening') this.cancelListening(true)
      return
    }
    void this.hud.rebuild() // back from the background
  }

  private onForegroundExit(): void {
    if (this.exitDialogOpen) {
      // The user answered "No" to the exit dialogue: carry on.
      this.exitDialogOpen = false
      void this.hud.rebuild()
      return
    }
    if (this.menuOpen) {
      this.menuOpen = false
      return
    }
    // Really backgrounded. Never leave the microphone running unseen.
    if (this.mode === 'listening') this.cancelListening()
    if (this.room) this.stopRoom()
  }

  private onMenuItem(id: number): void {
    if (this.mode === 'listening') this.cancelListening(true)
    if (this.mode === 'thinking') return
    if (!this.hasAccess()) return this.goHome()
    if (id === MENU.newChat) this.startChat()
    else if (id === MENU.switchAi) this.switchAi()
    else if (id === MENU.second) void this.secondOpinion()
    else if (id === MENU.discreet) void this.toggleDiscreet()
    else if (id === MENU.subtitles) void this.startRoom(false)
    else if (id === MENU.translate) void this.startRoom(true)
    else if (id === MENU.agent) void this.toggleAgentMode()
  }

  /** EDITH 3: agent mode on or off. On only works once a PC with an agent is linked. */
  private async toggleAgentMode(): Promise<void> {
    if (this.agentMode) {
      this.setAgentMode(false)
      return this.goIdle(tg('g.agentOff'))
    }
    const status = await this.api.agentStatus().catch(() => ({ linked: false, agent: undefined }))
    if (!status.linked || !status.agent) return this.goIdle(tg('g.agentNone'))
    this.setAgentMode(true)
    this.goIdle(tg('g.agentOn'))
  }

  private setAgentMode(on: boolean): void {
    this.agentMode = on
    try {
      localStorage.setItem(AGENT_MODE_KEY, on ? '1' : '')
    } catch {
      // private storage can refuse: agent mode lasts until the app closes
    }
  }

  /** EDITH 3: checks on a long task of the wearer's agent until its answer is in. */
  private waitForAgent(job: string): void {
    const started = Date.now()
    const check = async (): Promise<void> => {
      if (Date.now() - started > AGENT_WAIT_MS) return
      const got = await this.api.agentResult(job).catch(() => ({ done: false, said: undefined }))
      if (!got.done) {
        window.setTimeout(() => void check(), AGENT_POLL_MS)
        return
      }
      const line = `${tg('g.agentDone')}\n${got.said || ''}`
      this.phone.addNote(line)
      this.last = { you: '', reply: forGlasses(line) }
      if (this.mode === 'idle' && !this.approval && !this.room) this.goIdle()
    }
    window.setTimeout(() => void check(), AGENT_POLL_MS)
  }

  private menuItems(): MenuItem[] {
    return [
      { id: MENU.newChat, name: tg('menu.newChat') },
      { id: MENU.subtitles, name: tg('menu.subtitles') },
      { id: MENU.translate, name: tg('menu.translate') },
      { id: MENU.second, name: tg('menu.second') },
      // Says what the next tap will do.
      { id: MENU.discreet, name: this.prefs.discreet ? tg('menu.bright') : tg('menu.discreet') },
      { id: MENU.switchAi, name: tg('menu.switchAi') },
      // EDITH 3: talk straight to their own agent, or back to EDITH.
      { id: MENU.agent, name: this.agentMode ? tg('menu.edith') : tg('menu.agent') },
    ]
  }

  private wirePhone(): void {
    this.phone.onChooseLanguage((code) => void this.chooseLanguage(code))
    this.phone.onTalk(() => {
      if (this.mode === 'listening') void this.finishListening('manual')
      else if (this.canListen()) void this.startListening('phone')
    })
    this.phone.onSend((text) => {
      if (this.mode === 'thinking') {
        this.phone.addNote(t('note.stillAnswering'))
        return
      }
      if (this.mode === 'listening') this.cancelListening(true)
      // Without an AI there is nothing to ask yet: the setup card again.
      if (!this.hasAccess()) return this.showSetup({ phoneReason: t('err.needsKey') })
      void this.ask({ text })
    })
    this.phone.onCheckKey((provider, key, base) => this.checkKey(provider, key, base))
    this.phone.onSaveSetup((choice) => void this.saveSetup(choice))
    // With nothing that can hear yet, suggest a free voice-capable AI.
    this.phone.onAddAi(() =>
      this.phone.showSetup(true, { addingAnother: this.hasAccess(), provider: this.hearingSource() ? undefined : 'groq' }),
    )
    this.phone.onUseAi((id) => this.useAi(id))
    this.phone.onRemoveAi((id) => void this.removeAi(id))
    this.phone.onPickModel((id, model) => void this.pickModel(id, model))
    this.phone.onPickVoice((value) => void this.pickVoice(value))
    this.phone.onSettingsOpen(() => void this.loadModelLists())
    this.phone.onSignIn(() => void this.startSignIn())
    this.phone.onConnect(() => void this.startConnect())
    this.phone.onCancelSignIn(() => this.endSignIn())
    this.phone.onSignOut(() => void this.signOut())
    this.phone.onDeleteAccount(() => void this.deleteAccount())
    this.phone.onClearConversation(() => void this.deleteChat(this.chatId))
    this.phone.onForgetEverything(() => void this.forgetEverything())
    this.phone.onNewChat(() => this.startChat())
    this.phone.onOpenChat((id) => void this.openChat(id))
    this.phone.onDeleteChat((id) => void this.deleteChat(id))
    this.phone.onSearchChats((query) => this.searchChats(query))
    this.phone.onChatsOpen(() => void this.refreshChats())
    this.phone.onPrefsChange((change) => this.changePrefs(change))
  }

  // ── Language and preferences ───────────────────────────────────────────

  /** Switches the phone, the glasses and EDITH's answers to a language, and remembers it. */
  private async chooseLanguage(code: Lang): Promise<void> {
    setLanguage(code)
    await this.storageSet(STORAGE.language, code)
    this.phone.applyLanguage()
    this.hud.setMenu(this.menuItems())
    this.renderSettings()
    this.profileChanged()
    this.phone.addNote(t('note.languageSet', { language: languageName(code) }))
    if (this.mode === 'setup' || this.mode === 'idle' || this.mode === 'error') this.goHome()
  }

  /** Preferences changed on the phone: kept, synced, and put to use. */
  private changePrefs(change: Partial<Prefs>): void {
    const before = this.prefs
    this.prefs = cleanPrefs({ ...this.prefs, ...change })
    this.profileChanged()
    void this.storageSet(STORAGE.prefs, JSON.stringify(this.prefs))
    this.phone.renderPrefs(this.prefs)
    if (before.discreet !== this.prefs.discreet) {
      this.hud.setMenu(this.menuItems())
      void this.hud.setDim(this.prefs.discreet)
    }
    // A calendar that was just added or changed is read straight away, so the phone can
    // say whether the link works instead of waiting a quarter of an hour.
    if (JSON.stringify(before.calendars) !== JSON.stringify(this.prefs.calendars)) void this.refreshCalendar()
  }

  /** Discreet mode: every panel on the glasses dimmed, for meetings and dark rooms. */
  private async toggleDiscreet(): Promise<void> {
    this.changePrefs({ discreet: !this.prefs.discreet })
    this.goIdle(this.prefs.discreet ? tg('g.discreetOn') : tg('g.discreetOff'))
  }

  // ── Calendar ───────────────────────────────────────────────────────────

  private watchCalendar(): void {
    const tick = () => {
      if (this.prefs.calendars.length && Date.now() - this.calendarAt > CALENDAR_EVERY_MS) void this.refreshCalendar()
    }
    tick()
    window.clearInterval(this.calendarTimer)
    this.calendarTimer = window.setInterval(tick, 60_000)
  }

  /**
   * Reads the wearer's calendar links through EDITH's server and keeps the next fortnight,
   * worded in their language, to send with a question.
   */
  private async refreshCalendar(): Promise<void> {
    this.calendarAt = Date.now()
    const events: CalendarSend[] = []
    for (const link of this.prefs.calendars) {
      let ics: string
      this.phone.setCalendarStatus(link.url, 'wait', t('calendar.checking'))
      try {
        ics = await this.api.calendar(link.url)
      } catch {
        this.phone.setCalendarStatus(link.url, 'bad', t('calendar.failed'))
        continue
      }
      const found = upcomingEvents(ics, { days: CALENDAR_DAYS })
      this.phone.setCalendarStatus(link.url, 'ok', t('calendar.reading', { n: found.length }))
      for (const event of found) events.push(this.toCalendarSend(event))
    }
    this.calendar = events
      .filter((e, i, all) => all.findIndex((o) => o.when === e.when && o.title === e.title) === i)
      .sort((a, b) => a.day - b.day || a.when.localeCompare(b.when))
      .slice(0, CALENDAR_MAX)
  }

  /** One event as EDITH says it: "Today 09:00", "Tomorrow, all day", "Mon 18 Sep 14:00". */
  private toCalendarSend(event: ReturnType<typeof upcomingEvents>[number]): CalendarSend {
    const lang = getLanguage()
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    const day = Math.max(0, Math.round((new Date(event.start).setHours(0, 0, 0, 0) - midnight.getTime()) / 86_400_000))
    const time = event.allDay ? t('calendar.allDay') : event.start.toLocaleTimeString(lang, { hour: 'numeric', minute: '2-digit' })
    const named =
      day === 0 ? t('calendar.today') : day === 1 ? t('calendar.tomorrow') : event.start.toLocaleDateString(lang, { weekday: 'short', day: 'numeric', month: 'short' })
    return { when: `${named} ${time}`, title: event.title, where: event.where, day }
  }

  // ── Access: saved AI keys and voice ────────────────────────────────────

  private access(): Access {
    const chat = this.chatChoice()
    const voice = this.voiceChoice(chat.provider)
    return {
      provider: chat.provider,
      key: chat.key,
      model: chat.model,
      ...(chat.base ? { base: chat.base } : {}),
      voiceProvider: voice.provider,
      voiceKey: voice.key,
    }
  }

  private savedAccess(id: string): { provider: string; key: string; model: string; base?: string } {
    const saved = this.keys[id]
    return { provider: id, key: saved?.key ?? '', model: saved?.model ?? '', ...(saved?.base ? { base: saved.base } : {}) }
  }

  private chatChoice(): { provider: string; key: string; model: string; base?: string } {
    if (this.keys[this.active]) return this.savedAccess(this.active)
    const first = Object.keys(this.keys)[0]
    if (first) return this.savedAccess(first)
    return { provider: '', key: '', model: '' }
  }

  private voiceChoice(chatProvider: string): { provider: string; key: string } {
    const preferred = this.keys[this.voicePref]
    if (preferred?.voice) return { provider: this.voicePref, key: preferred.key }
    if (this.keys[chatProvider]?.voice) return { provider: chatProvider, key: this.keys[chatProvider].key }
    const other = VOICE_ORDER.find((id) => this.keys[id]?.voice) ?? Object.keys(this.keys).find((id) => this.keys[id].voice)
    if (other) return { provider: other, key: this.keys[other].key }
    return { provider: '', key: '' }
  }

  private hasAccess(): boolean {
    return this.chatChoice().provider !== ''
  }

  /** Whether EDITH can hear questions: the AI in use can, or another key does it for it. */
  private canHear(): boolean {
    return this.voiceChoice(this.chatChoice().provider).provider !== ''
  }

  /** What EDITH would listen with for an AI that can't hear: the Voice setting, or another key. */
  private hearingSource(): string {
    return this.voiceChoice('').provider
  }

  /** An AI's name on the phone. */
  private labelFor(id: string): string {
    return this.keys[id]?.label || this.providers.find((p) => p.id === id)?.label || id
  }

  /** An AI's name on the glasses. */
  private glassesLabel(id: string): string {
    return forGlasses(this.labelFor(id))
  }

  /** Checks a key with EDITH's server, once per key per session. A failed check is tried again next time. */
  private checkKey(provider: string, key: string, base = ''): Promise<KeyCheck> {
    const id = `${provider}\n${key}\n${base}`
    let pending = this.keyChecks.get(id)
    if (!pending) {
      pending = this.api.checkKey(provider, key, base).then(
        (result) => {
          if (!result.ok) this.keyChecks.delete(id)
          return { ...result, error: result.ok ? '' : this.checkKeyMessage(provider, result) }
        },
        (err) => {
          this.keyChecks.delete(id)
          throw err
        },
      )
      this.keyChecks.set(id, pending)
    }
    return pending
  }

  /** What was wrong with a key, in the phone's language. */
  private checkKeyMessage(provider: string, result: { code: string; other: string; error: string }): string {
    const info = this.providers.find((p) => p.id === provider)
    const label = info?.label ?? provider
    switch (result.code) {
      case 'provider':
        return t('check.provider')
      case 'address':
        return t('check.address')
      case 'format':
        return t('check.format', { provider: label })
      case 'elsewhere':
        return t('check.elsewhere', { other: this.providers.find((p) => p.id === result.other)?.label ?? result.other })
      case 'rejected':
        return t('check.rejected', { provider: label, url: info?.keyUrl ?? '' })
      case 'network':
        return info?.needsBase ? t('check.address') : t('check.network', { provider: label })
      default:
        return getLanguage() === 'en' && result.error ? result.error : t('check.other')
    }
  }

  /** Saves the AI picked on the setup card, with its model, and a second key for voice if one was given. */
  private async saveSetup(choice: SetupChoice): Promise<void> {
    const info = this.providers.find((p) => p.id === choice.provider)
    const voiceInfo = choice.voiceKey ? this.providers.find((p) => p.id === choice.voiceProvider) : undefined
    if (!info || (choice.voiceKey && !voiceInfo)) return this.phone.setSetupStatus(t('setup.noProviders'), 'error')
    this.phone.setSetupBusy(true)
    this.phone.setSetupStatus(
      voiceInfo ? t('setup.checkingTwo', { provider: info.label, voice: voiceInfo.label }) : t('setup.checkingOne', { provider: info.label }),
    )
    let chat: KeyCheck
    let voice: KeyCheck | null
    try {
      ;[chat, voice] = await Promise.all([
        this.checkKey(info.id, choice.key, choice.base),
        voiceInfo ? this.checkKey(voiceInfo.id, choice.voiceKey) : Promise.resolve(null),
      ])
    } catch {
      this.phone.setSetupBusy(false)
      return this.phone.setSetupStatus(t('setup.serverDown'), 'error')
    }
    this.phone.setSetupBusy(false)
    if (!chat.ok) return this.phone.setSetupStatus(chat.error, 'error')
    if (voice && !voice.ok) return this.phone.setSetupStatus(t('setup.voiceKeyProblem', { error: voice.error }), 'error')
    this.phone.rememberKeyCheck(info.id, choice.key, chat, choice.base)

    // Keep the picked model if this key can use it; otherwise the provider's recommended one.
    const available = chat.models.length ? matchModel(choice.model, chat.models) : choice.model || null
    const model = available || chat.defaultModel
    this.keys[info.id] = { key: choice.key, model, label: info.label, voice: info.voice, ...(choice.base ? { base: choice.base } : {}) }
    this.modelCache.set(info.id, chat.models)
    if (voice && voiceInfo) {
      this.keys[voiceInfo.id] = { key: choice.voiceKey, model: voice.defaultModel, label: voiceInfo.label, voice: true }
      this.modelCache.set(voiceInfo.id, voice.models)
      this.voicePref = voiceInfo.id
    }
    this.active = info.id
    await this.saveAccess()
    this.phone.clearSetupInput()
    this.phone.showSetup(false)

    const modelName = model && model !== 'auto' ? model : t('note.fastestModel')
    if (choice.model && !available) this.phone.addNote(t('note.modelUnavailable', { model: choice.model, chosen: modelName }))
    this.phone.addNote(t('note.added', { provider: info.label, model: modelName }))
    const name = shortName(info.label)
    if (voiceInfo) this.phone.addNote(t('note.voiceAdded', { voice: voiceInfo.label, name }))
    else if (!this.canHear()) this.phone.addNote(t('note.noVoiceYet', { name }), 'error')
    this.renderSettings()
    if (this.mode === 'setup' || this.mode === 'error' || this.mode === 'idle') this.goIdle()
  }

  private useAi(id: string): void {
    if (!this.keys[id]) return
    this.active = id
    void this.saveAccess()
    this.renderSettings()
    const model = this.chatChoice().model
    const shown = model && model !== 'auto' ? model : ''
    this.phone.addNote(t('note.nowUses', { label: `${this.labelFor(id)}${shown ? ` (${shown})` : ''}` }))
    if (this.mode === 'idle' || this.mode === 'error') {
      this.goIdle(`${tg('g.nowUsing', { label: this.glassesLabel(id) })}${shown ? `\n${shown}` : ''}`)
    }
  }

  private switchAi(): void {
    const options = Object.keys(this.keys)
    if (options.length < 2) return this.goIdle(tg('g.onlyOneAi'))
    const current = options.indexOf(this.chatChoice().provider)
    this.useAi(options[(current + 1) % options.length])
  }

  private async removeAi(id: string): Promise<void> {
    if (!this.keys[id]) return
    const label = this.labelFor(id)
    delete this.keys[id]
    this.modelCache.delete(id)
    if (this.voicePref === id) this.voicePref = 'auto'
    if (this.active === id) this.active = ''
    await this.saveAccess()
    this.renderSettings()
    this.phone.addNote(t('note.removed', { label }))
    if (!this.hasAccess() && this.mode !== 'listening' && this.mode !== 'thinking') this.showSetup()
    else if (!this.canHear() && (this.mode === 'idle' || this.mode === 'error')) this.goIdle(tg('g.removed', { label: forGlasses(label) }))
  }

  private async pickModel(id: string, model: string): Promise<void> {
    if (!this.keys[id]) return
    this.keys[id].model = model
    await this.saveAccess()
    this.renderSettings()
    this.phone.addNote(t('note.modelPicked', { label: this.labelFor(id), model: model === 'auto' ? t('note.fastestModel') : model }))
  }

  private async pickVoice(value: string): Promise<void> {
    this.voicePref = value
    await this.saveAccess()
    this.renderSettings()
  }

  private renderSettings(): void {
    const chat = this.chatChoice()
    const rows: AiRow[] = []
    for (const [id, saved] of Object.entries(this.keys)) {
      // Your own server is known by its address; a key is optional there.
      const parts = [saved.base ? hostOf(saved.base) : '', saved.key ? t('ai.keyEnds', { last4: saved.key.slice(-4) }) : '']
      if (!saved.voice) parts.push(t('ai.noSpeech'))
      rows.push({
        id,
        label: saved.label,
        detail: parts.filter(Boolean).join(' · '),
        active: chat.provider === id,
        model: saved.model,
        models: this.modelCache.get(id) ?? [],
      })
    }
    this.phone.renderAiList(rows)

    const options: VoiceOption[] = [{ value: 'auto', label: t('voice.automatic') }]
    for (const [id, saved] of Object.entries(this.keys)) if (saved.voice) options.push({ value: id, label: saved.label })
    const hearing = this.voiceChoice(chat.provider)
    const help = !this.hasAccess()
      ? ''
      : hearing.provider
        ? t('voice.listensWith', { label: this.labelFor(hearing.provider) })
        : t('voice.noneCanHear', { name: shortName(this.labelFor(chat.provider)) })
    this.phone.renderVoice(options, options.some((o) => o.value === this.voicePref) ? this.voicePref : 'auto', help)
    const source = this.hearingSource()
    this.phone.setVoiceCoverage(source ? this.labelFor(source) : '')
    this.phone.renderAccount(
      this.account ? { who: this.account.email || this.account.name, method: t(`account.method.${this.account.method}` as Key) } : null,
    )
    this.phone.renderPrefs(this.prefs)
    this.renderChats()
  }

  /** Fills the model dropdowns in settings, once per AI per session. */
  private async loadModelLists(): Promise<void> {
    const ids = Object.keys(this.keys).filter((id) => !this.modelCache.has(id))
    const results = await Promise.allSettled(ids.map((id) => this.api.models(id, this.keys[id].key, this.keys[id].base ?? '')))
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') this.modelCache.set(ids[i], r.value.models)
    })
    if (ids.length) this.renderSettings()
  }

  private async loadProviders(): Promise<void> {
    try {
      const providers = await this.api.providers()
      this.providers = providers
      this.phone.setProviders(providers)
      this.renderSettings() // model names in Your AI come from the catalog
      await this.storageSet(STORAGE.providers, JSON.stringify(providers))
    } catch (err) {
      if (!this.providers.length) this.phone.setSetupStatus(t('setup.serverDown'), 'error')
      console.warn('[edith] loading providers failed', err)
    }
  }

  // ── Listening ───────────────────────────────────────────────────────────

  /** The first-run screen: no AI yet, so tell the wearer exactly what to do. */
  private showSetup(options: { phoneReason?: string; glassesNote?: string; provider?: string } = {}): void {
    this.setMode('setup')
    // While signing in or connecting OpenRouter, the link panel stands in for the setup card.
    if (!this.signIn) this.phone.showSetup(true, { reason: options.phoneReason, provider: options.provider })
    this.statusKind = 'setup'
    this.hud.set({
      status: this.statusLine(),
      body: `${options.glassesNote ?? tg('g.setupNeeded')}\n\n${tg('g.setupHow')}\n\n${tg('g.doubleTapExit')}`,
    })
  }

  private async startListening(trigger: Trigger, { keepBody = false } = {}): Promise<void> {
    if (!this.canListen()) return
    // No AI yet: the microphone stays shut, and the setup card says what to do.
    if (!this.hasAccess()) return this.showSetup()
    if (!this.canHear()) {
      const name = shortName(this.labelFor(this.chatChoice().provider))
      this.phone.addNote(t('note.cantUnderstand', { name }), 'error')
      this.showError(tg('g.status.noVoice'), tg('g.cantUnderstand', { name: forGlasses(name) }), tg('g.addVoiceKey'))
      return
    }
    const recorder = new Recorder({
      autoStop: trigger !== 'hold',
      onAutoStop: (reason) => void this.finishListening(reason),
    })
    if (!keepBody) this.followUps = 0
    this.recorder = recorder
    this.trigger = trigger
    // A follow-up leaves the answer up until the wearer actually says something.
    this.quietListening = keepBody
    this.setMode('listening')
    this.hud.set({ status: `● ${tg('g.status.rec')} 0:00` })
    this.renderListeningBody()
    this.startTicker(() => this.renderListening(), 500)
    window.clearTimeout(this.followUpStopTimer)
    if (keepBody) {
      this.followUpStopTimer = window.setTimeout(() => {
        if (this.recorder === recorder && this.quietListening) this.cancelListening(true)
      }, FOLLOW_UP_WINDOW_MS)
    }

    const opened = await this.openMic()
    if (this.recorder !== recorder) {
      // Cancelled or finished while the mic was opening.
      if (opened) this.closeMic()
      return
    }
    if (!opened) {
      this.recorder = null
      this.stopTicker()
      this.phone.addNote(t('note.micFailed'), 'error')
      this.showError(tg('g.status.micOff'), tg('g.micFailed'), tg('g.micPermission'))
    }
  }

  private async finishListening(reason: StopReason): Promise<void> {
    const recorder = this.recorder
    if (this.mode !== 'listening' || !recorder) return
    this.recorder = null
    recorder.stop()
    this.stopTicker()
    window.clearTimeout(this.followUpStopTimer)
    this.closeMic()
    const quiet = this.quietListening
    this.quietListening = false

    // Nothing worth sending: nobody spoke, or all that arrived was the room. A tap still
    // sends what it caught, since the wearer meant to send something.
    const nothingSaid = reason === 'no-speech' || recorder.sendableMs < 600 || (!recorder.heardSpeech && reason !== 'manual')
    if (nothingSaid) {
      // Nobody spoke into a follow-up: leave the answer as it was.
      this.goHome(quiet ? undefined : tg('g.didntCatch'))
      return
    }
    await this.ask({ audio: { mime: 'audio/wav', data: recorder.toWavBase64() } })
  }

  /** Stops listening without sending. Quiet cancels (menu opened, typing instead) leave no note. */
  private cancelListening(quiet = false): void {
    this.recorder?.stop()
    this.recorder = null
    this.stopTicker()
    window.clearTimeout(this.followUpStopTimer)
    this.closeMic()
    this.quietListening = false
    this.goHome(quiet ? undefined : tg('g.cancelled'))
  }

  private renderListening(): void {
    const recorder = this.recorder
    if (this.mode !== 'listening' || !recorder) return
    const seconds = Math.floor(recorder.durationMs / 1000)
    const levels = recorder.recentLevels
    const meter = levels
      .slice(-8)
      .map((level) => LEVEL_BARS[Math.min(LEVEL_BARS.length - 1, Math.floor(level * LEVEL_BARS.length))])
      .join('')
    const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
    this.hud.set({ status: `● ${tg('g.status.rec')} ${clock}  ${meter}` })
    this.phone.setLevel(levels[levels.length - 1] ?? 0)
    // A follow-up only takes over the glasses once the wearer actually speaks.
    if (this.quietListening && recorder.heardSpeech) {
      this.quietListening = false
      this.renderListeningBody()
    }
  }

  private renderListeningBody(): void {
    if (this.quietListening) return
    const how = this.trigger === 'hold' ? tg('g.releaseToSend') : tg('g.tapToSend')
    this.hud.set({ body: `${tg('g.listening')}\n\n${how}\n${tg('g.doubleTapCancel')}` })
  }

  /** After an answer the mic opens again for a moment, so the wearer can just carry on. */
  private listenForFollowUp(): void {
    window.clearTimeout(this.followUpTimer)
    if (!this.prefs.followUp || this.trigger === 'phone' || this.followUps >= FOLLOW_UPS_IN_A_ROW) return
    this.followUpTimer = window.setTimeout(() => {
      if (this.mode !== 'idle' || this.recorder || this.room) return
      this.followUps++
      void this.startListening('tap', { keepBody: true })
    }, FOLLOW_UP_AFTER_MS)
  }

  // ── Subtitles and live translation ─────────────────────────────────────
  //
  // The glasses mark every audio frame as the wearer's voice or someone else's. A question
  // keeps only the wearer's; RoomEars keeps only the other, cuts it at a pause, and the
  // server turns each piece into words (and, for live translation, the wearer's language).
  // Nothing is recorded: the audio is dropped as soon as it is words.

  /** Starts subtitles. `translate` turns them into the wearer's language on the way. */
  private async startRoom(translate: boolean): Promise<void> {
    if (!this.hasAccess()) return this.showSetup()
    if (!this.voiceChoice(this.chatChoice().provider).provider) {
      const name = shortName(this.labelFor(this.chatChoice().provider))
      this.phone.addNote(t('err.voice', { name }), 'error')
      return this.showError(tg('g.status.noVoice'), tg('g.cantUnderstand', { name: forGlasses(name) }), tg('g.addVoiceKey'))
    }
    if (this.room) return this.stopRoom()
    window.clearTimeout(this.followUpTimer)

    const room = { ears: new RoomEars(), controller: null, failures: 0, translate }
    this.room = room
    this.setMode('idle')
    this.renderRoom()
    // The clock in the status line, and the stop once a session has run long enough.
    this.roomTicker = window.setInterval(() => this.roomTick(), ROOM_TICK_MS)

    // Only the glasses say whose voice a sound is; the phone microphone would hear nothing usable.
    if (!(await this.openMic({ glassesOnly: true }))) {
      this.room = null
      window.clearInterval(this.roomTicker)
      this.phone.addNote(t('note.micFailed'), 'error')
      return this.showError(tg('g.status.micOff'), tg('g.micFailed'), tg('g.micPermission'))
    }
    this.phone.addNote(t(translate ? 'note.roomTranslating' : 'note.roomListening'))
  }

  /** Stops subtitles and forgets the audio. */
  private stopRoom(note?: string): void {
    const room = this.room
    if (!room) return
    this.room = null
    window.clearInterval(this.roomTicker)
    this.roomTicker = undefined
    room.controller?.abort()
    room.ears.forget()
    this.closeMic()
    this.goIdle(note ?? tg('g.roomStopped'))
  }

  /** Every second: the clock, and the end of a session that has gone on long enough. */
  private roomTick(): void {
    const room = this.room
    if (!room) return
    if (room.ears.sinceStartMs >= ROOM_MAX_MS) return this.stopRoom(tg('g.roomEnough'))
    this.renderRoom()
  }

  /** Sends a segment as soon as one is whole, one at a time so lines stay in order. */
  private pumpRoom(): void {
    const room = this.room
    if (!room || room.controller || !room.ears.ready) return
    const segment = room.ears.take()
    if (!segment) return

    const controller = new AbortController()
    room.controller = controller
    this.api
      .room(
        { mime: 'audio/wav', data: segment.wav },
        { spoken: this.prefs.roomLanguage, translateTo: room.translate ? getLanguage() : '' },
        controller.signal,
      )
      .then(
        ({ text, translated }) => {
          if (this.room !== room) return
          room.failures = 0
          room.ears.add(forGlasses(translated || text))
          this.renderRoom()
        },
        (err) => {
          if (this.room !== room) return
          if (err instanceof ApiError && err.kind === 'cancelled') return
          // A few in a row means something is properly wrong; one is just a lost segment.
          if (++room.failures >= ROOM_FAILURES_MAX) {
            this.phone.addNote(err instanceof ApiError ? err.message : String(err), 'error')
            this.stopRoom(tg('g.roomTrouble'))
          }
        },
      )
      .finally(() => {
        if (room.controller === controller) room.controller = null
        // More may have arrived while that one was in the air.
        if (this.room === room) this.pumpRoom()
      })
  }

  /** The subtitle screen: the last few lines, newest at the bottom, with a clock. */
  private renderRoom(): void {
    const room = this.room
    if (!room) return
    const lines = room.ears.heard.map((line) => line.text)
    const body = lines.length ? tailToFit(lines.join('\n'), SAFE_CHARS_PER_LINE, ROOM_LINES) : `${tg('g.roomWaiting')}\n\n${tg('g.doubleTapStop')}`
    const seconds = Math.floor(room.ears.sinceStartMs / 1000)
    const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
    this.hud.set({ status: `● ${tg(room.translate ? 'g.status.translating' : 'g.status.subtitles')} ${clock}`, body })
  }

  private async openMic({ glassesOnly = false } = {}): Promise<boolean> {
    try {
      if (await this.bridge.audioControl(true, AudioInputSource.Glasses)) {
        this.micOpen = true
        return true
      }
      if (!glassesOnly && (await this.bridge.audioControl(true, AudioInputSource.Phone))) {
        this.micOpen = true
        this.phone.addNote(t('note.phoneMic'))
        return true
      }
    } catch (err) {
      console.error('[edith] audioControl failed', err)
    }
    return false
  }

  private closeMic(): void {
    if (!this.micOpen) return
    this.micOpen = false
    this.bridge.audioControl(false).catch((err) => console.warn('[edith] closing mic failed', err))
  }

  // ── Asking the server ──────────────────────────────────────────────────

  /** Asks EDITH and shows the answer as it arrives. `second` asks another AI instead. */
  private async ask(payload: AskPayload, { second }: { second?: { access: Access; label: string } } = {}): Promise<void> {
    window.clearTimeout(this.followUpTimer)
    const typed = 'text' in payload ? payload.text : ''
    const you = this.phone.addYou(typed || t('entry.transcribing'))
    const live = this.phone.addEdithLive(second ? shortName(second.label) : '')
    const request = { controller: new AbortController(), you, live }
    this.request = request
    this.chatEpoch++
    this.setMode('thinking')

    let question = clip(forGlasses(typed), 90)
    let answer = ''
    const options = this.answerOptions()
    // A second opinion says whose it is, above the answer itself.
    const from = second ? `${forGlasses(shortName(second.label))}:\n` : ''
    const renderBody = () => {
      if (this.request !== request) return
      const head = question ? `» ${question}\n\n${from}` : from
      const tail = answer ? forGlasses(answer) : question ? tg('g.working') : `${tg('g.working')}\n\n${tg('g.doubleTapCancel')}`
      this.hud.set({ body: clip(head + tail, 1990) })
    }
    renderBody()
    let frame = 0
    this.renderThinking(frame)
    this.startTicker(() => this.renderThinking(++frame), 400)

    try {
      // A second opinion is asked fresh: the other AI doesn't get to see the first answer.
      const last = this.history.length - 2
      const asked = second && last >= 0 && this.history[last].role === 'user' && this.history[last + 1].role === 'model'
        ? this.history.slice(0, last)
        : this.history
      const reply = await this.api.chat(payload, asked, options, {
        onTranscript: (text) => {
          question = clip(forGlasses(text), 90)
          you.update(text)
          renderBody()
        },
        onDelta: (delta) => {
          if (this.request !== request) return
          if (!answer) {
            this.stopTicker()
            this.hud.set({ status: `● ${tg('g.status.answering')}` })
          }
          answer += delta
          live.append(delta)
          renderBody()
        },
        onReset: () => {
          answer = ''
          live.reset()
          renderBody()
        },
        onTool: (names) => {
          if (this.request !== request) return
          this.stopTicker()
          const shown = names.find((n) => TOOL_STATUS[n])
          if (shown) this.hud.set({ status: `◆ ${tg(TOOL_STATUS[shown])}` })
        },
      }, request.controller.signal, second?.access)
      if (this.request !== request) return

      this.history = reply.history.slice(-CHAT_TURNS)
      const said = reply.userText || typed
      you.update(said)
      this.last = { you: forGlasses(said), reply: `${from}${forGlasses(reply.reply) || '...'}` }
      this.lastAsked = said
      live.finish(reply.reply, reply.toolsUsed)
      this.stopTicker()
      this.answered(said, options)
      // A rule was broken since the last question: said plainly, once.
      if (reply.warning) this.showWarning(reply.warning)
      if (reply.warning?.blocked) return
      // EDITH 3: a job on the wearer's PC that waits for their tap. No follow-up listening:
      // the next tap is the answer to this.
      if (reply.agentJob) this.waitForAgent(reply.agentJob)
      if (reply.confirm) return this.askApproval(reply.confirm, reply.reply)
      this.goIdle()
      this.listenForFollowUp()
    } catch (err) {
      if (this.request !== request) return
      live.discard()
      you.update(question || typed || t('entry.voiceMessage'))
      this.stopTicker()
      this.fail(err)
    } finally {
      if (this.request === request) this.request = null
    }
  }

  /** Which chat a question goes into, and the calendar this phone read. */
  private answerOptions(): AnswerOptions {
    return {
      chatId: this.chatId,
      style: 'normal',
      instructions: '',
      specialist: 'general',
      translateTo: '',
      ...(this.calendar.length ? { calendar: this.calendar } : {}),
      ...(this.agentMode ? { agentMode: true } : {}),
    }
  }

  private cancelRequest(): void {
    const request = this.request
    this.request = null
    request?.controller.abort()
    request?.you.update(t('entry.cancelled'))
    request?.live.discard()
    this.stopTicker()
    this.goHome(tg('g.cancelled'))
  }

  private renderThinking(frame: number): void {
    if (this.mode !== 'thinking') return
    this.hud.set({ status: `${tg('g.status.thinking')} ${THINKING_FRAMES[frame % THINKING_FRAMES.length]}` })
  }

  /** The last question again, answered by another AI, so both answers are there to compare. */
  private async secondOpinion(): Promise<void> {
    if (this.mode === 'thinking') return
    if (!this.lastAsked) return this.goIdle(tg('g.nothingToAsk'))
    const other = this.otherAi()
    if (!other) return this.goIdle(tg('g.noOtherAi'))
    this.phone.addNote(t('note.secondOpinion', { ai: other.label }))
    await this.ask({ text: this.lastAsked }, { second: other })
  }

  /** Another AI than the one answering now: the next key this phone has. */
  private otherAi(): { access: Access; label: string } | null {
    const current = this.chatChoice().provider
    const id = Object.keys(this.keys).find((other) => other !== current)
    if (!id) return null
    const voice = this.voiceChoice(id)
    return {
      label: this.labelFor(id),
      access: { ...this.savedAccess(id), voiceProvider: voice.provider, voiceKey: voice.key },
    }
  }

  private showWarning(warning: { label: string; blocked: boolean; left: number }): void {
    if (warning.blocked) {
      this.phone.addNote(t('warn.blocked', { rule: warning.label }), 'error')
      return this.showError(tg('g.status.blocked'), tg('g.warn.blocked'), '')
    }
    this.phone.addNote(t('warn.flagged', { rule: warning.label, left: warning.left }), 'error')
  }

  /** Tells the wearer what went wrong, on the phone and the glasses, in their language. */
  private fail(err: unknown): void {
    const error = err instanceof ApiError ? err : new ApiError('server', (err as Error)?.message || String(err))
    const aiId = this.chatChoice().provider
    const provider = this.labelFor(aiId)
    const onGlasses = this.glassesLabel(aiId)
    switch (error.kind) {
      case 'cancelled':
        return this.goHome(tg('g.cancelled'))
      case 'session':
        // Signed out elsewhere: onSessionEnded has already said so and tidied up.
        return this.goHome()
      case 'unclear':
        return this.goHome(tg('g.didntCatch'))
      case 'setup': {
        if (this.hasAccess()) {
          this.phone.addNote(t('err.key', { provider }), 'error')
          return this.showError(tg('g.status.key'), tg('g.err.key', { provider: onGlasses }), tg('g.checkKey'))
        }
        return this.showSetup({ phoneReason: t('err.needsKey'), provider: aiId })
      }
      case 'voice': {
        const name = shortName(provider)
        this.phone.addNote(t('err.voice', { name }), 'error')
        return this.showError(tg('g.status.noVoice'), tg('g.cantUnderstand', { name: forGlasses(shortName(onGlasses)) }), tg('g.addVoiceKey'))
      }
      case 'model':
        this.phone.addNote(t('err.model', { provider }), 'error')
        return this.showError(tg('g.status.model'), tg('g.err.model', { provider: onGlasses }), tg('g.pickModel'))
      case 'quota':
        this.phone.addNote(t('err.quota', { provider }), 'error')
        return this.showError(tg('g.status.noQuota'), tg('g.err.quota', { provider: onGlasses }), tg('g.tryLater'))
      case 'offline': {
        // A server of their own that EDITH's server couldn't reach: the address is what to check.
        if (error.serverKind === 'network' && this.keys[aiId]?.base) {
          this.phone.addNote(t('err.ownServer'), 'error')
          return this.showError(tg('g.status.offline'), tg('g.err.ownServer'), tg('g.checkAddress'))
        }
        if (error.serverKind === 'overloaded') {
          this.phone.addNote(t('err.busy', { provider }), 'error')
          return this.showError(tg('g.status.offline'), tg('g.err.busy', { provider: onGlasses }), tg('g.checkConnection'))
        }
        if (error.serverKind === 'timeout') {
          this.phone.addNote(t('err.timeout'), 'error')
          return this.showError(tg('g.status.offline'), tg('g.err.timeout'), tg('g.tapRetry'))
        }
        this.phone.addNote(t('err.offline'), 'error')
        return this.showError(tg('g.status.offline'), tg('g.err.offline'), tg('g.checkConnection'))
      }
      default: {
        if (error.serverKind === 'refused') {
          this.phone.addNote(t('err.refused', { provider }), 'error')
          return this.showError(tg('g.status.error'), tg('g.err.refused', { provider: onGlasses }), tg('g.tapRetry'))
        }
        if (error.serverKind === 'blocked') {
          const why = error.ban.why
          this.phone.addNote(why ? t('err.bannedWhy', { rule: why }) : t('err.blocked'), 'error')
          return this.showError(tg('g.status.blocked'), tg('g.err.blocked'), '')
        }
        // Anything else: the general message, with the server's own (English) detail for reference.
        this.phone.addNote(`${t('err.server')} (${error.message})`, 'error')
        return this.showError(tg('g.status.error'), tg('g.err.server'), tg('g.tapRetry'))
      }
    }
  }

  // ── Screens ─────────────────────────────────────────────────────────────

  /** Idle when EDITH has an AI, otherwise the setup screen. `note` is glasses text. */
  /** EDITH 3: something on the wearer's PC (a command, a file outside the workspace) waiting for their tap. */
  private askApproval(confirm: { what: string; token: string }, reply: string): void {
    this.approval = { what: confirm.what, token: confirm.token }
    this.phone.addNote(t('note.approveOnGlasses', { what: confirm.what }))
    this.setMode('idle')
    this.statusKind = 'online'
    const body = `${forGlasses(reply)}

▶ ${forGlasses(confirm.what)}

${tg('g.approveHint')}`
    this.hud.set({ status: `◆ ${tg('g.status.approve')}`, body: clip(body, 1990) })
  }

  /** The wearer tapped to approve: the PC does the job, and what came of it is shown. */
  private async approve(): Promise<void> {
    const pending = this.approval
    this.approval = null
    if (!pending) return
    this.setMode('thinking')
    this.hud.set({ status: `◆ ${tg('g.status.pc')}`, body: `▶ ${forGlasses(pending.what)}` })
    try {
      const done = await this.api.confirm(pending.token)
      if (done.agentJob) this.waitForAgent(done.agentJob)
      // The agent wants another step approved: ask again.
      if (done.confirm) return this.askApproval(done.confirm, done.said || '')
      const line = done.ok ? `✓ ${done.said || pending.what}` : `✗ ${done.error || pending.what}`
      this.last = { you: '', reply: forGlasses(line) }
      this.phone.addNote(line)
      this.goIdle()
    } catch (err) {
      this.fail(err)
    }
  }

  private goHome(note?: string): void {
    if (this.hasAccess()) this.goIdle(note)
    else this.showSetup({ glassesNote: note })
  }

  /** The controls on the home screen, or, when the chosen AI can't hear, what to do about it. */
  private hint(): string {
    if (!this.canHear()) return tg('g.hintNoVoice', { name: forGlasses(shortName(this.glassesLabel(this.chatChoice().provider))) })
    return tg('g.hint')
  }

  private goIdle(note?: string): void {
    // Subtitles keep the screen until they are put down.
    if (this.room) return this.renderRoom()
    if (!this.signIn) this.phone.showSetup(false)
    this.setMode('idle')
    let body: string
    if (note) body = `${note}\n\n${this.hint()}`
    else if (this.last) body = this.last.you ? `» ${clip(this.last.you, 90)}\n\n${this.last.reply}` : this.last.reply
    else body = this.greeting()

    const overflows = estimateLines(body, BODY_CHARS_PER_LINE) > BODY_LINES
    this.statusKind = overflows ? 'more' : 'online'
    this.hud.set({ status: this.statusLine(), body: clip(body, 1990) })
  }

  /** An error screen: status word, what happened, and what to do (all glasses text). */
  private showError(status: string, headline: string, hint: string): void {
    this.setMode('error')
    this.hud.set({ status: `■ ${status}`, body: hint ? `${headline}\n\n${hint}` : headline })
  }

  private greeting(): string {
    const hour = new Date().getHours()
    const key: GlassesKey = hour >= 5 && hour < 12 ? 'g.morning' : hour >= 12 && hour < 18 ? 'g.afternoon' : 'g.evening'
    const name = this.firstName ? `${tg('g.nameSep')}${this.firstName}` : ''
    return `${tg(key, { name })}\n${tg('g.allOnline')}\n\n${this.hint()}`
  }

  /** The idle or setup status with the glasses battery, e.g. "● ONLINE  ■■■□ 76%". */
  private statusLine(): string {
    const base =
      this.statusKind === 'setup'
        ? `■ ${tg('g.status.setup')}`
        : this.statusKind === 'more'
          ? `▼ ${tg('g.status.more')}`
          : this.agentMode
            ? `◆ ${tg('g.status.agent')}`
            : `● ${tg('g.status.online')}`
    const { level, charging } = this.battery
    if (typeof level !== 'number' || !Number.isFinite(level)) return base
    const pct = Math.max(0, Math.min(100, Math.round(level)))
    const cells = Math.round(pct / 25)
    return `${base}  ${'■'.repeat(cells)}${'□'.repeat(4 - cells)} ${charging ? '+' : ''}${pct}%`
  }

  private setMode(mode: Mode): void {
    this.mode = mode
    this.phone.setState(mode)
  }

  private startTicker(tick: () => void, everyMs: number): void {
    this.stopTicker()
    this.ticker = window.setInterval(tick, everyMs)
  }

  private stopTicker(): void {
    window.clearInterval(this.ticker)
    this.ticker = undefined
  }

  /** The clock in the title, updated on each minute boundary: one write a minute. */
  private startClock(): void {
    const tick = () => {
      this.clock = forGlasses(new Date().toLocaleTimeString(glassesLocale(), { hour: 'numeric', minute: '2-digit' }))
      this.hud.set({ title: `◆ E.D.I.T.H${this.clock ? `  ${this.clock}` : ''}` })
    }
    tick()
    const untilNextMinute = 60_000 - (Date.now() % 60_000) + 100
    this.clockTimers.push(window.setTimeout(() => {
      tick()
      this.clockTimers.push(window.setInterval(tick, 60_000))
    }, untilNextMinute))
  }

  private async watchBattery(): Promise<void> {
    this.unsubscribers.push(this.bridge.onDeviceStatusChanged((status) => this.onDeviceStatus(status)))
    try {
      const info = await withTimeout(this.bridge.getDeviceInfo(), 2000)
      if (info?.status) this.onDeviceStatus(info.status)
    } catch {
      // No battery on screen is fine; the simulator has none.
    }
  }

  private onDeviceStatus(status: DeviceStatus): void {
    if (typeof status.batteryLevel !== 'number') return
    const next = { level: status.batteryLevel, charging: Boolean(status.isCharging) }
    if (next.level === this.battery.level && next.charging === this.battery.charging) return
    this.battery = next
    if ((this.mode === 'idle' && !this.room) || this.mode === 'setup') this.hud.set({ status: this.statusLine() })
  }

  // ── Saved chats ────────────────────────────────────────────────────────

  /**
   * The chat list, and the chat to be in: the one from before if it's recent, otherwise a
   * new one (the earlier ones stay in Chats). Never blocks talking.
   */
  private async loadChats(): Promise<void> {
    const epoch = this.chatEpoch
    let list: ChatSummary[]
    try {
      list = await this.api.chats()
    } catch (err) {
      if (!(err instanceof ApiError && err.kind === 'session')) this.phone.addNote(t('note.serverNotAnswering'), 'error')
      return
    }
    this.chats = list
    this.renderChats()
    // Talking, or opening a chat, while the list loaded: stay in that chat.
    if (epoch !== this.chatEpoch) return
    const current = list.find((c) => c.id === this.chatId)
    if (current && Date.now() - current.updated < CONTINUE_CHAT_MS) await this.openChat(current.id, { quiet: true })
    else this.startChat({ quiet: true })
  }

  /** Opens a saved chat: its messages on the phone, and what EDITH remembers of it. */
  private async openChat(id: string, { quiet = false } = {}): Promise<void> {
    if (this.mode === 'thinking' || this.mode === 'listening') return
    const epoch = ++this.chatEpoch
    let chat: Awaited<ReturnType<EdithApi['openChat']>>
    try {
      chat = await this.api.openChat(id)
    } catch {
      if (!quiet) this.phone.addNote(t('note.chatFailed'), 'error')
      return
    }
    if (epoch !== this.chatEpoch) return
    if (!chat) {
      // Deleted on another phone.
      this.chats = this.chats.filter((c) => c.id !== id)
      if (!quiet) this.phone.addNote(t('note.chatFailed'), 'error')
      return this.startChat({ quiet: true })
    }
    this.phone.closeChats()
    this.chatId = chat.id
    void this.storageSet(STORAGE.chatId, chat.id)
    this.history = chat.messages.slice(-CHAT_TURNS).map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] }))
    this.answersInChat = chat.messages.filter((m) => m.role !== 'user').length
    this.phone.clearLog()
    for (const m of chat.messages.slice(-CHAT_SHOWN)) {
      if (m.role === 'user') this.phone.addYou(m.content)
      else this.phone.addEdith(m.content)
    }
    this.renderChats()
    const lastAnswer = [...chat.messages].reverse().find((m) => m.role !== 'user')
    const lastQuestion = [...chat.messages].reverse().find((m) => m.role === 'user')
    this.lastAsked = lastQuestion?.content ?? ''
    if (quiet) return
    this.last = lastAnswer ? { you: forGlasses(lastQuestion?.content ?? ''), reply: forGlasses(lastAnswer.content) || '...' } : null
    this.phone.addNote(t('note.chatOpened', { title: chat.title || t('chats.untitled') }))
    if (this.mode === 'idle' || this.mode === 'error') this.goIdle()
  }

  /** A new, empty chat. The one before stays in Chats. */
  private startChat({ quiet = false } = {}): void {
    if (this.mode === 'thinking' && !quiet) return
    this.chatEpoch++
    // An empty chat that was never saved is simply reused.
    const unsaved = this.chatId && this.answersInChat === 0 && !this.chats.some((c) => c.id === this.chatId)
    if (!unsaved) this.chatId = newChatId()
    void this.storageSet(STORAGE.chatId, this.chatId)
    this.history = []
    this.last = null
    this.lastAsked = ''
    this.answersInChat = 0
    this.phone.closeChats()
    this.phone.clearLog()
    this.renderChats()
    if (quiet) return
    this.phone.addNote(t('note.newChat'))
    if (this.mode === 'idle' || this.mode === 'error') this.goIdle(tg('g.newChat'))
  }

  private async deleteChat(id: string): Promise<void> {
    if (!id || (this.mode === 'thinking' && id === this.chatId)) return
    try {
      await this.api.deleteChat(id)
    } catch {
      this.phone.addNote(t('note.chatDeleteFailed'), 'error')
      return
    }
    this.chats = this.chats.filter((c) => c.id !== id)
    this.chatsFound = this.chatsFound.filter((c) => c.id !== id)
    if (id === this.chatId) {
      this.chatId = ''
      this.startChat({ quiet: true })
      if (this.mode === 'idle' || this.mode === 'error') this.goIdle(tg('g.newChat'))
    }
    this.renderChats()
    this.phone.addNote(t('note.chatDeleted'))
  }

  /** A question and answer went into the current chat: the list shows it first. */
  private answered(said: string, { chatId, specialist }: AnswerOptions): void {
    const now = Date.now()
    const entry = this.chats.find((c) => c.id === chatId)
    const updated: ChatSummary = entry
      ? { ...entry, specialist, updated: now, count: entry.count + 2 }
      : { id: chatId, title: clip(said.replace(/\s+/g, ' ').trim(), 48), specialist, updated: now, count: 2 }
    this.chats = [updated, ...this.chats.filter((c) => c.id !== chatId)]
    this.renderChats()
    if (chatId !== this.chatId) return
    this.answersInChat++
    // The server names a chat after its first answer, and again after its sixth.
    if (this.answersInChat === 1 || this.answersInChat === 6) {
      window.clearTimeout(this.chatsTimer)
      this.chatsTimer = window.setTimeout(() => void this.refreshChats(), TITLE_REFRESH_MS)
    }
  }

  private async refreshChats(): Promise<void> {
    try {
      this.chats = await this.api.chats()
    } catch {
      return
    }
    this.renderChats()
    if (this.chatsQuery) this.searchChats(this.chatsQuery)
  }

  /** Searches chat titles and what was said, shortly after the typing stops. */
  private searchChats(query: string): void {
    window.clearTimeout(this.searchTimer)
    this.chatsQuery = query.trim()
    if (!this.chatsQuery) {
      this.chatsFound = []
      return this.renderChats()
    }
    const asked = this.chatsQuery
    this.searchTimer = window.setTimeout(async () => {
      let found: ChatSummary[]
      try {
        found = await this.api.chats(asked)
      } catch {
        return
      }
      if (this.chatsQuery !== asked) return
      this.chatsFound = found
      this.renderChats()
    }, SEARCH_DELAY_MS)
  }

  private renderChats(): void {
    const current = this.chats.find((c) => c.id === this.chatId)
    this.phone.renderChats({
      current: this.chatId,
      title: current?.title || t('chats.untitled'),
      chats: this.chatsQuery ? this.chatsFound : this.chats,
      searching: Boolean(this.chatsQuery),
    })
  }

  private async forgetEverything(): Promise<void> {
    if (this.mode === 'thinking') return
    try {
      await this.api.forget()
    } catch {
      this.phone.addNote(t('note.forgetFailed'), 'error')
      return
    }
    this.chats = []
    this.chatsFound = []
    this.chatId = ''
    this.startChat({ quiet: true })
    this.phone.addNote(t('note.forgotten'))
    if (this.mode === 'idle') this.goIdle()
  }

  // ── Account: signing in, and the settings and keys that follow it ──────

  /** Whether this server offers accounts, then catches this phone and the account up with each other. */
  private async loadAccount(): Promise<void> {
    try {
      this.accountsOn = await this.api.accountsEnabled()
    } catch {
      this.accountsOn = false
    }
    // A phone that's signed in can always see its account, to sign out.
    this.phone.setAccountsAvailable(this.accountsOn || Boolean(this.session))
    this.renderSettings()
    if (this.session) await this.syncAccount()
  }

  /** The newer copy wins: the account's settings come to this phone, or this phone's go to the account. */
  private async syncAccount(): Promise<void> {
    if (!this.session) return
    let remote: Awaited<ReturnType<EdithApi['account']>>
    try {
      remote = await this.api.account()
    } catch {
      return // signed out elsewhere (already handled), or offline: try again next time
    }
    this.account = remote.account
    await this.storageSet(STORAGE.account, JSON.stringify(remote.account))
    if (remote.profile && remote.updatedAt > this.profileUpdatedAt) await this.applyProfile(remote.profile, remote.updatedAt)
    else if (!remote.profile || this.profileUpdatedAt > remote.updatedAt) await this.uploadProfile()
    this.renderSettings()
  }

  /** What follows the account. */
  private profile(): SyncedProfile {
    return {
      keys: this.keys,
      active: this.active,
      voice: this.voicePref,
      language: getLanguage(),
      ...this.prefs,
    }
  }

  /** Uses settings from the account. With merge, keys already on this phone are kept too (the account's win). */
  private async applyProfile(profile: SyncedProfile, updatedAt: number, { merge = false } = {}): Promise<void> {
    const dimmed = this.prefs.discreet
    this.keys = merge ? { ...this.keys, ...profile.keys } : { ...profile.keys }
    this.modelCache.clear()
    this.active = profile.active && this.keys[profile.active] ? profile.active : this.keys[this.active] ? this.active : ''
    this.voicePref = profile.voice || 'auto'
    // Profiles saved by EDITH 1.4 have no preferences: this phone's stay.
    if (profile.style !== undefined) this.prefs = cleanPrefs(profile)
    this.profileUpdatedAt = updatedAt
    await Promise.all([
      this.saveAccess({ sync: false }),
      this.storageSet(STORAGE.profileUpdatedAt, String(updatedAt)),
      this.storageSet(STORAGE.prefs, JSON.stringify(this.prefs)),
    ])
    if (isLang(profile.language) && profile.language !== getLanguage()) {
      setLanguage(profile.language)
      await this.storageSet(STORAGE.language, profile.language)
      this.phone.applyLanguage()
      this.hud.setMenu(this.menuItems())
    }
    if (dimmed !== this.prefs.discreet) {
      this.hud.setMenu(this.menuItems())
      void this.hud.setDim(this.prefs.discreet)
    }
    this.renderSettings()
    void this.refreshCalendar()
    // Keys from the account may be all this phone needed: then setup is done.
    if (this.hasAccess()) this.phone.showSetup(false)
    if (this.mode === 'setup' || this.mode === 'idle' || this.mode === 'error') this.goHome()
  }

  /** Something that follows the account changed on this phone: save it there shortly. */
  private profileChanged(): void {
    if (!this.session) return
    this.profileUpdatedAt = Date.now()
    void this.storageSet(STORAGE.profileUpdatedAt, String(this.profileUpdatedAt))
    window.clearTimeout(this.profileTimer)
    this.profileTimer = window.setTimeout(() => void this.uploadProfile(), PROFILE_SAVE_DELAY_MS)
  }

  private async uploadProfile(): Promise<void> {
    if (!this.session) return
    try {
      const result = await this.api.saveProfile(this.profile(), this.profileUpdatedAt || Date.now())
      // Another phone changed the account since: take its settings.
      if (!result.ok && result.profile) await this.applyProfile(result.profile, result.updatedAt)
    } catch (err) {
      console.warn('[edith] saving settings to the account failed', err)
    }
  }

  private async startSignIn(): Promise<void> {
    if (this.signIn || this.session) return
    this.phone.showSetup(false)
    this.phone.showSignIn('starting', 'account')
    let link: SignInLink
    try {
      link = await this.api.startSignIn()
    } catch {
      this.phone.showSignIn(null)
      this.phone.addNote(t('account.failed'), 'error')
      if (!this.hasAccess() && this.mode === 'setup') this.showSetup()
      return
    }
    const pending = { kind: 'account' as const, link, timer: 0, expires: Date.now() + link.expiresIn * 1000, polling: false }
    pending.timer = window.setInterval(() => void this.pollSignIn(pending), SIGN_IN_POLL_MS)
    this.signIn = pending
    this.phone.showSignIn({ url: link.url, code: link.code }, 'account')
  }

  /** Connect OpenRouter: the person approves EDITH on OpenRouter in their browser, and the key arrives by itself. */
  private async startConnect(): Promise<void> {
    if (this.signIn) return
    this.phone.showSetup(false)
    this.phone.showSignIn('starting', 'openrouter')
    let link: ConnectLink
    try {
      link = await this.api.startConnect()
    } catch {
      this.phone.showSignIn(null)
      this.phone.addNote(t('connect.failed'), 'error')
      if (!this.hasAccess() && this.mode === 'setup') this.showSetup()
      return
    }
    const pending = { kind: 'openrouter' as const, link, timer: 0, expires: Date.now() + link.expiresIn * 1000, polling: false }
    pending.timer = window.setInterval(() => void this.pollSignIn(pending), SIGN_IN_POLL_MS)
    this.signIn = pending
    this.phone.showSignIn({ url: link.url, code: '' }, 'openrouter')
  }

  private async pollSignIn(pending: NonNullable<Edith['signIn']>): Promise<void> {
    if (this.signIn !== pending || pending.polling) return
    const expired = t(pending.kind === 'account' ? 'account.expired' : 'connect.expired')
    if (Date.now() > pending.expires) return this.endSignIn(expired)
    pending.polling = true
    let result: SignInPoll | ConnectPoll
    try {
      result = pending.kind === 'account' ? await this.api.pollSignIn(pending.link) : await this.api.pollConnect(pending.link)
    } catch {
      return // a network blip: ask again on the next tick
    } finally {
      pending.polling = false
    }
    if (this.signIn !== pending || result.status === 'pending') return
    if (result.status === 'approved') {
      this.endSignIn('', { restore: false })
      return this.signedIn(result.session, result.account)
    }
    if (result.status === 'connected') {
      this.endSignIn('', { restore: false })
      return this.connectedOpenRouter(result.key)
    }
    this.endSignIn(result.status === 'failed' ? t('connect.failed') : expired)
  }

  /** OpenRouter approved EDITH: its key joins this phone's AIs (and the account's, when signed in). */
  private async connectedOpenRouter(key: string): Promise<void> {
    let check: KeyCheck
    try {
      check = await this.checkKey('openrouter', key)
    } catch {
      check = { ok: false, error: t('connect.failed'), models: [], defaultModel: '' }
    }
    if (!check.ok) {
      this.phone.addNote(check.error || t('connect.failed'), 'error')
      if (!this.hasAccess() && this.mode === 'setup') this.showSetup()
      return
    }
    const info = this.providers.find((p) => p.id === 'openrouter')
    this.keys.openrouter = { key, model: check.defaultModel, label: info?.label ?? 'OpenRouter', voice: info?.voice ?? true }
    this.modelCache.set('openrouter', check.models)
    this.active = 'openrouter'
    await this.saveAccess()
    this.phone.showSetup(false)
    this.phone.addNote(t('note.connected', { model: check.defaultModel || t('note.fastestModel') }))
    if (check.freeTier) this.phone.addNote(t('note.openrouterFree'), 'error')
    this.renderSettings()
    if (this.mode === 'setup' || this.mode === 'idle' || this.mode === 'error') this.goIdle()
  }

  /** Closes the link panel (with a problem to mention, if any) and, without an AI yet, goes back to setup. */
  private endSignIn(problem = '', { restore = true } = {}): void {
    if (this.signIn) window.clearInterval(this.signIn.timer)
    this.signIn = null
    this.phone.showSignIn(null)
    if (problem) this.phone.addNote(problem, 'error')
    if (restore && !this.hasAccess() && this.mode === 'setup') this.showSetup()
  }

  private async signedIn(session: string, account: AccountInfo): Promise<void> {
    this.session = session
    this.account = account
    await Promise.all([this.storageSet(STORAGE.session, session), this.storageSet(STORAGE.account, JSON.stringify(account))])
    this.phone.setAccountsAvailable(true)
    // The account's keys and settings join this phone's; then the combination is saved to the account.
    try {
      const remote = await this.api.account()
      if (remote.profile) await this.applyProfile(remote.profile, Date.now(), { merge: true })
      this.profileUpdatedAt = Date.now()
      await this.uploadProfile()
    } catch {
      this.profileChanged()
    }
    // Chats now come from the account, which also has this phone's from before.
    this.history = []
    this.last = null
    this.phone.clearLog()
    await this.loadChats()
    this.phone.addNote(t('note.signedIn', { who: account.email || account.name }))
    this.renderSettings()
    if (this.hasAccess()) this.phone.showSetup(false)
    if (this.mode !== 'listening' && this.mode !== 'thinking') this.goHome()
  }

  private async signOut(): Promise<void> {
    if (!this.session) return
    await this.api.signOut().catch(() => {})
    await this.leaveAccount(t('note.signedOut'))
  }

  private async deleteAccount(): Promise<void> {
    if (!this.session) return
    try {
      await this.api.deleteAccount()
    } catch {
      this.phone.addNote(t('note.accountFailed'), 'error')
      return
    }
    await this.leaveAccount(t('note.accountDeleted'))
  }

  /** The server says this phone's session ended: signed out or deleted from another phone. */
  private async onSessionEnded(): Promise<void> {
    if (!this.session || this.sessionEnding) return
    this.sessionEnding = true
    try {
      await this.leaveAccount(t('note.sessionEnded'))
    } finally {
      this.sessionEnding = false
    }
  }

  /** The account's keys, settings and chats leave this phone. The language stays. */
  private async leaveAccount(note: string): Promise<void> {
    window.clearTimeout(this.profileTimer)
    this.session = ''
    this.account = null
    this.profileUpdatedAt = 0
    this.keys = {}
    this.modelCache.clear()
    this.active = ''
    this.voicePref = 'auto'
    const dimmed = this.prefs.discreet
    this.prefs = { ...DEFAULT_PREFS }
    this.calendar = []
    if (dimmed) {
      this.hud.setMenu(this.menuItems())
      void this.hud.setDim(false)
    }
    this.chats = []
    this.chatsFound = []
    this.chatId = ''
    this.startChat({ quiet: true })
    await Promise.all([
      this.storageSet(STORAGE.session, ''),
      this.storageSet(STORAGE.account, ''),
      this.storageSet(STORAGE.profileUpdatedAt, '0'),
      this.storageSet(STORAGE.prefs, JSON.stringify(this.prefs)),
      this.saveAccess({ sync: false }),
    ])
    this.phone.addNote(note)
    this.phone.setAccountsAvailable(this.accountsOn)
    this.renderSettings()
    if (this.mode !== 'listening' && this.mode !== 'thinking') this.goHome()
    void this.refreshChats()
  }

  // ── Storage and identity ───────────────────────────────────────────────

  private async loadAccess(): Promise<void> {
    const [language, keys, active, voice, providers, legacyGemini, session, account, profileUpdatedAt, prefs, chatId] =
      await Promise.all([
        this.storageGet(STORAGE.language),
        this.storageGet(STORAGE.keys),
        this.storageGet(STORAGE.active),
        this.storageGet(STORAGE.voice),
        this.storageGet(STORAGE.providers),
        this.storageGet(STORAGE.legacyGeminiKey),
        this.storageGet(STORAGE.session),
        this.storageGet(STORAGE.account),
        this.storageGet(STORAGE.profileUpdatedAt),
        this.storageGet(STORAGE.prefs),
        this.storageGet(STORAGE.chatId),
      ])
    setLanguage(isLang(language) ? language : guessLanguage())
    this.session = session
    this.account = session ? parseJson<AccountInfo | null>(account, null) : null
    this.profileUpdatedAt = Number(profileUpdatedAt) || 0
    this.keys = parseJson<Record<string, SavedKey>>(keys, {})
    this.active = active
    this.voicePref = voice || 'auto'
    this.prefs = cleanPrefs(parseJson<Partial<Prefs> | null>(prefs, null))
    this.chatId = cleanChatId(chatId) || newChatId()
    this.providers = parseJson<ProviderInfo[]>(providers, [])
    if (this.providers.length) this.phone.setProviders(this.providers)

    // EDITH 1.0.x kept a single Gemini key.
    if (legacyGemini && !this.keys.gemini) {
      this.keys.gemini = { key: legacyGemini, model: 'auto', label: 'Google Gemini', voice: true }
      if (!this.active) this.active = 'gemini'
      await this.saveAccess()
      await this.storageSet(STORAGE.legacyGeminiKey, '')
    }
  }

  /** Saves keys and AI choices on this phone and, when signed in, to the account (unless they just came from it). */
  private async saveAccess({ sync = true }: { sync?: boolean } = {}): Promise<void> {
    await Promise.all([
      this.storageSet(STORAGE.keys, JSON.stringify(this.keys)),
      this.storageSet(STORAGE.active, this.active),
      this.storageSet(STORAGE.voice, this.voicePref),
    ])
    if (sync) this.profileChanged()
  }

  private async loadIdentity(): Promise<void> {
    const stored = cleanKey(await this.storageGet(STORAGE.deviceId))
    this.deviceId = stored || newDeviceId()
    if (!stored) await this.storageSet(STORAGE.deviceId, this.deviceId)
    try {
      const user = await withTimeout(this.bridge.getUserInfo(), 2000)
      this.firstName = forGlasses(user?.name ?? '').split(/\s+/)[0] ?? ''
    } catch {
      this.firstName = ''
    }
  }

  // SDK storage survives app restarts inside the Even app, unlike browser
  // localStorage. Guarded with timeouts so a slow host never blocks startup.
  private async storageGet(key: string): Promise<string> {
    try {
      return (await withTimeout(this.bridge.getLocalStorage(key), 2000)) ?? ''
    } catch {
      return ''
    }
  }

  private async storageSet(key: string, value: string): Promise<void> {
    try {
      await withTimeout(this.bridge.setLocalStorage(key, value), 2000)
    } catch (err) {
      console.warn('[edith] setLocalStorage failed', err)
    }
  }

  private shutdown(): void {
    this.recorder?.stop()
    this.recorder = null
    this.request?.controller.abort()
    this.request = null
    this.room?.controller?.abort()
    this.room = null
    this.stopTicker()
    window.clearTimeout(this.followUpTimer)
    window.clearTimeout(this.followUpStopTimer)
    window.clearTimeout(this.chatsTimer)
    window.clearTimeout(this.searchTimer)
    window.clearTimeout(this.profileTimer)
    window.clearInterval(this.roomTicker)
    window.clearInterval(this.calendarTimer)
    if (this.signIn) window.clearInterval(this.signIn.timer)
    this.closeMic()
    for (const timer of this.clockTimers) {
      window.clearTimeout(timer)
      window.clearInterval(timer)
    }
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
  }
}

/**
 * The gesture or lifecycle type in an event, whichever envelope carries it.
 * CLICK_EVENT is 0, which protobuf leaves off the wire, so an envelope with
 * no eventType is a click - but only when that envelope is present at all.
 */
function eventTypeOf(event: EvenHubEvent): OsEventTypeList | null {
  const envelope = event.sysEvent ?? event.textEvent ?? event.listEvent
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

function parseJson<T>(raw: string, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function cleanKey(raw: string): string {
  return String(raw || '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 64)
}

/** Just the host of "your own server", to show in Settings: https://ai.me/v1 -> ai.me */
function hostOf(base: string): string {
  try {
    return new URL(base).host
  } catch {
    return String(base || '').replace(/^https?:\/\//i, '').split('/')[0]
  }
}

/** A saved chat's id as the server accepts it, or "". */
function cleanChatId(raw: string): string {
  return /^[A-Za-z0-9_-]{6,40}$/.test(raw) ? raw : ''
}

function newChatId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  return 'c' + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

function newDeviceId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return 'edith_' + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/** EDITH 3: whether agent mode was left on. */
function readAgentMode(): boolean {
  try {
    return localStorage.getItem(AGENT_MODE_KEY) === '1'
  } catch {
    return false
  }
}
