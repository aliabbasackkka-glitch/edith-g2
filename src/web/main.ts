// EDITH's website: JARVIS's web UI (jarvis-cloudflare/public/index.html) re-skinned in EDITH's
// gold, talking to EDITH's server with the visitor's own AI key. Keys and settings live only in
// this browser (store.ts) and travel only in the X-AI-* / X-Voice-* headers of EDITH's requests.
// Everything the AI or the visitor wrote is shown as text, never as HTML.

import './web.css'
import { ApiError, EdithApi, type Access, type AskPayload, type ChatSummary, type ChatTurn, type ProviderInfo, type SavedChat } from '../api'
import { guessLanguage, getLanguage, setLanguage } from '../i18n'
import { $, typingIn } from './dom'
import { Hud, type HudState } from './hud'
import { ActivityLog, type LogLine } from './log'
import { MAX_RECORDING_MS, Mic, MicError, type MicProblem } from './mic'
import { PhotoError, shrinkPhoto } from './photo'
import { Setup, modelShort, shortName, type SavedSetup } from './setup'
import { Speaker } from './speech'
import {
  DEFAULT_SETTINGS,
  cleanChatId,
  deviceId,
  forgetBrowser,
  loadChatId,
  loadSettings,
  newChatId,
  saveChatId,
  saveSettings,
  storageWorks,
  type WebSettings,
} from './store'

// Questions and answers sent along as context, and messages shown when a chat opens.
const CHAT_TURNS = 20
const CHAT_SHOWN = 60
// A chat from less than this long ago carries on when the page opens again.
const CONTINUE_CHAT_MS = 12 * 60 * 60 * 1000
// A new chat's title arrives a few seconds after its first answer, and again after its sixth.
const TITLE_REFRESH_MS = 6000
const SEARCH_DELAY_MS = 350
const RECENT_SHOWN = 6
// A press shorter than this on a touch screen starts a recording that a second tap sends.
const TAP_MS = 350
const MIN_RECORDING_MS = 400
// Below this loudness nothing was said (or the microphone is muted).
const SILENCE = 0.004

/** What the server is doing for each tool, as a SYS line in the log. */
const TOOL_LINES: Record<string, string> = {
  web_search: 'Searching the web...',
  weather_report: 'Checking the weather...',
  wikipedia: 'Looking it up...',
  news_headlines: 'Getting the news...',
  daily_briefing: 'Preparing your briefing...',
  recall_conversations: 'Remembering earlier chats...',
  read_link: 'Reading the page...',
  nearby_places: 'Looking nearby...',
}

type Mode = 'idle' | 'listening' | 'thinking' | 'answering' | 'speaking'

// ── State ─────────────────────────────────────────────────────────────

let settings: WebSettings = loadSettings()
setLanguage(settings.language || guessLanguage())
let device = deviceId()
let providers: ProviderInfo[] = []
let online: boolean | null = null
let chatId = ''
let history: ChatTurn[] = []
let chats: ChatSummary[] = []
let answersInChat = 0
let mode: Mode = 'idle'
let flash: { state: HudState; label: string; until: number } | null = null
let request: { controller: AbortController } | null = null
let micProblem: MicProblem | '' = ''
let noMicDevice = false
let questions = 0
let speechFailed = false
const bootTime = Date.now()

const access = (): Access => ({
  provider: settings.provider,
  key: settings.key,
  model: settings.model,
  base: settings.base,
  voiceProvider: settings.voiceProvider,
  voiceKey: settings.voiceKey,
})

const api = new EdithApi(__API_BASE__, () => device, access, () => '', () => {})
const log = new ActivityLog($('#log'))
const hud = new Hud($<HTMLCanvasElement>('#radar'), $<HTMLCanvasElement>('#wave'))
const speaker = new Speaker()
const mic = new Mic(
  (level) => onMicLevel(level),
  () => {
    log.add(`[SYS] ${MAX_RECORDING_MS / 1000} second limit reached - sending.`, 'sys')
    void finishRecording()
  },
)

const providerInfo = (id = settings.provider): ProviderInfo | undefined => providers.find((p) => p.id === id)

function hasAccess(): boolean {
  if (!settings.provider) return false
  const info = providerInfo()
  if (info?.needsBase || settings.provider === 'custom') return Boolean(settings.base)
  return Boolean(settings.key)
}

/** Whether EDITH can hear with this setup: the AI can, or there is a key for voice. */
function canHear(): boolean {
  const info = providerInfo()
  if (info) return info.voice || Boolean(settings.voiceProvider && settings.voiceKey)
  return Boolean(settings.provider) // providers not loaded yet: let the server say
}

const providerLabel = (): string => providerInfo()?.label ?? (settings.provider || 'The AI')

// ── State line and HUD ─────────────────────────────────────────────────

const stateLbl = $('#stateLbl')
let blink = true

function setMode(next: Mode): void {
  mode = next
  paintState()
}

/** A state shown for a moment (muted, offline), then back to what EDITH is doing. */
function flashState(state: HudState, label: string, ms = 2600): void {
  flash = { state, label, until: Date.now() + ms }
  paintState()
  window.setTimeout(paintState, ms + 20)
}

function paintState(): void {
  let state: HudState
  let label: string
  if (flash && flash.until > Date.now() && mode === 'idle') {
    state = flash.state
    label = flash.label
  } else {
    flash = null
    if (mode !== 'idle') state = mode
    else if (online === null) state = 'initialising'
    else if (online === false) state = 'offline'
    else if (!hasAccess()) state = 'setup'
    else state = 'online'
    label = {
      initialising: '● INITIALISING',
      online: '● ONLINE',
      setup: '● SETUP REQUIRED',
      listening: `${blink ? '●' : '○'} LISTENING`,
      thinking: `${blink ? '◈' : '◇'} THINKING`,
      answering: '● ANSWERING',
      speaking: '● SPEAKING',
      muted: '⊘ MUTED',
      offline: '● OFFLINE',
    }[state]
  }
  if (stateLbl.textContent !== label) stateLbl.textContent = label
  stateLbl.className = `state ${state}`
  hud.setState(state)
  $('#hudCenter').classList.toggle('muted', state === 'muted' || state === 'offline')
}

window.setInterval(() => {
  blink = !blink
  if (mode === 'listening' || mode === 'thinking') paintState()
}, 600)

// ── Caption under the HUD ──────────────────────────────────────────────

const caption = $('#caption')
const captionText = $('#captionText')
let captionTimer = 0

function showCaption(text: string, { final = false } = {}): void {
  window.clearTimeout(captionTimer)
  const tail = text.length > 420 ? `…${text.slice(-420).replace(/^\S*\s/, '')}` : text
  captionText.textContent = tail.trim()
  caption.classList.toggle('empty', !tail.trim())
  caption.classList.remove('fade')
  if (final) captionTimer = window.setTimeout(() => caption.classList.add('fade'), 12_000)
}

// ── Left panel: session monitor ────────────────────────────────────────

function setBar(id: string, value: number, max: number, label?: string, live = false): void {
  const el = document.getElementById(id)
  if (!el) return
  const pct = Math.min(100, Math.round((100 * value) / (max || 1)))
  el.querySelector('.val')!.textContent = label ?? String(value)
  ;(el.querySelector('.bar-fill') as HTMLElement).style.width = `${pct}%`
  el.className = `sys-bar${live ? ' live' : pct > 85 ? ' crit' : pct > 60 ? ' warn' : ''}`
}

function onMicLevel(level: number): void {
  if (!mic.recording) {
    setBar('mMic', 0, 1, '--')
    hud.setLevel(0)
    return
  }
  hud.setLevel(level)
  setBar('mMic', level, 1, `${Math.round(level * 100)}%`, true)
}

function tickUp(): void {
  const s = Math.floor((Date.now() - bootTime) / 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  $('#iUp').textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
}

function tickClock(): void {
  const d = new Date()
  $('#clockTime').textContent = d.toTimeString().slice(0, 8)
  const parts = d.toDateString().split(' ')
  $('#clockDate').textContent = `${parts[0]} ${parts[2]} ${parts[1]} ${parts[3]}`.toUpperCase()
}

// ── AI link, status strip, footer ──────────────────────────────────────

function paintAccess(): void {
  const info = providerInfo()
  const linked = hasAccess()
  const name = info ? shortName(info.label).toUpperCase() : settings.provider.toUpperCase()
  const link = $('#aiLink')
  link.textContent = linked ? `${name} · ${modelShort(settings.model || info?.defaultModel || 'auto')}` : 'NO AI LINKED'
  link.classList.toggle('none', !linked)
  const hint = $('#aiLinkState')
  if (!linked) {
    hint.textContent = "No AI linked - E.D.I.T.H can't answer until you add one."
    hint.className = 'hint warn'
  } else {
    const kept = settings.key ? `● Key saved on this device (…${settings.key.slice(-4)})` : '● Your own server'
    hint.textContent = canHear() ? kept : `${kept}. ${shortName(providerLabel())} can't hear: type, or add a voice key in SETUP.`
    hint.className = canHear() ? 'hint ok' : 'hint warn'
  }
  $('#iModel').textContent = linked ? modelShort(settings.model || info?.defaultModel || 'auto') : '--'
  $('#iAi').textContent = linked ? name : '--'
  $('#pAi').textContent = online === false ? 'OFFLINE' : linked ? name : 'NOT SET'
  paintVoice()
  paintState()
}

function paintVoice(): void {
  const noMic = micProblem === 'denied' || micProblem === 'none' || micProblem === 'insecure' || micProblem === 'unsupported' || noMicDevice
  $('#pVoice').textContent = !hasAccess() || !canHear() ? 'OFF' : noMic ? 'NO MIC' : 'READY'
}

function setOnline(next: boolean): void {
  online = next
  const footer = $('#footer')
  footer.classList.remove('wait')
  footer.classList.toggle('dc', !next)
  $('#status').textContent = next ? '● ONLINE' : '● OFFLINE'
  paintAccess()
}

/** Whether this browser has a microphone at all (without asking for it). */
async function checkMicDevice(): Promise<void> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    noMicDevice = !window.isSecureContext
    return paintVoice()
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    noMicDevice = !devices.some((d) => d.kind === 'audioinput')
  } catch {
    noMicDevice = false
  }
  paintVoice()
}

async function loadProviders(): Promise<ProviderInfo[]> {
  providers = await api.providers()
  setOnline(true)
  return providers
}

// ── Asking ─────────────────────────────────────────────────────────────

function needsSetup(): boolean {
  if (hasAccess()) return false
  log.add('[SYS] Choose an AI and paste its key first.', 'sys')
  void setup.open({ reason: 'E.D.I.T.H needs an AI to answer. Pick one and paste its key.' })
  return true
}

/** Sends a question and streams the answer into the log. Resolves true when it was answered. */
async function ask(payload: AskPayload, shown: string): Promise<boolean> {
  if (needsSetup()) return false
  if (request) {
    log.add('[SYS] Still answering - one moment.', 'sys')
    return false
  }
  speaker.stop()
  if (!chatId) {
    chatId = newChatId()
    saveChatId(chatId)
  }
  const voice = 'audio' in payload
  const you = log.add(`[YOU] ${shown}`, 'you')
  const current = { controller: new AbortController() }
  request = current
  questions++
  setBar('mMsg', questions, Math.max(50, questions))
  setMode('thinking')
  showCaption('')
  const started = performance.now()
  let edith: LogLine | null = null
  let answer = ''
  let firstWord = 0
  const shownTools = new Set<string>()
  const options = {
    chatId,
    style: settings.style,
    instructions: '',
    specialist: 'general',
    translateTo: '',
    can: [] as string[],
    surface: 'web' as const,
  }
  try {
    const reply = await api.chat(
      payload,
      history,
      options,
      {
        onTranscript: (text) => {
          if (text) you.set(`[YOU] ${text}`)
        },
        onStatus: () => {
          if (!answer && mode !== 'thinking') setMode('thinking')
        },
        onTool: (names) => {
          for (const name of names) {
            const line = TOOL_LINES[name]
            if (line && !shownTools.has(name)) {
              shownTools.add(name)
              log.add(`[SYS] ${line}`, 'sys')
            }
          }
          if (!answer) setMode('thinking')
        },
        onDelta: (delta) => {
          if (!delta) return
          if (!edith) {
            edith = log.add('[EDITH] ', 'edith', { open: true })
            setMode('answering')
          }
          if (!firstWord) firstWord = performance.now()
          answer += delta
          edith.append(delta)
          showCaption(answer)
        },
        onReset: () => {
          // The model's words so far were thrown away (it went to use a tool, or another AI took over).
          edith?.remove()
          edith = null
          answer = ''
          showCaption('')
        },
      },
      current.controller.signal,
    )
    if (request !== current) return false
    // LAT: how long until the first words arrived (the whole answer when it came in one piece).
    const ms = (firstWord || performance.now()) - started
    setBar('mLat', Math.min(ms, 10_000), 10_000, ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`)

    history = reply.history.slice(-CHAT_TURNS)
    if (reply.chatId && cleanChatId(reply.chatId) && reply.chatId !== chatId) {
      chatId = reply.chatId
      saveChatId(chatId)
    }
    const said = reply.userText || ('text' in payload ? payload.text : '')
    if (voice) you.set(`[YOU] ${said || '(voice message)'}`)
    const text = reply.reply || '...'
    const line = edith as LogLine | null
    if (!line) log.add(`[EDITH] ${text}`, 'edith')
    else {
      if (answer !== text) line.set(`[EDITH] ${text}`)
      line.close()
    }
    showCaption(text, { final: true })
    setBar('mChars', text.length, 1500)
    answered(said || shown)
    if (reply.warning) showWarning(reply.warning)
    setOnline(true)
    if (settings.speak && reply.reply && !reply.warning?.blocked) speakAnswer(reply.reply)
    else setMode('idle')
    return true
  } catch (err) {
    if (request !== current) return false
    ;(edith as LogLine | null)?.remove()
    if (voice) you.set('[YOU] (voice message)')
    showCaption('')
    setMode('idle')
    fail(err)
    return false
  } finally {
    if (request === current) request = null
  }
}

function speakAnswer(text: string): void {
  if (!speaker.supported) return setMode('idle')
  setMode('idle')
  speaker.speak(
    text,
    getLanguage(),
    () => setMode('speaking'),
    (result) => {
      if (mode === 'speaking') setMode('idle')
      if (result === 'blocked') showAudioBanner(true)
      if (result === 'failed' && !speechFailed) {
        speechFailed = true
        log.add("[SYS] This browser couldn't read the answer aloud. Check its sound output.", 'sys')
      }
    },
  )
}

function showWarning(warning: { label: string; blocked: boolean; left: number }): void {
  if (warning.blocked) {
    log.add(`[ERR] This browser is now banned from E.D.I.T.H: ${warning.label}.`, 'err')
    return
  }
  log.add(
    `[ERR] E.D.I.T.H won't help with that: ${warning.label}. This is on record. ` +
      `${warning.left} more and this browser is banned.`,
    'err',
  )
}

/** Says what went wrong, in plain words, and opens setup when that is where it's fixed. */
function fail(err: unknown): void {
  const error = err instanceof ApiError ? err : new ApiError('server', (err as Error)?.message || String(err))
  const provider = providerLabel()
  const short = shortName(provider)
  switch (error.kind) {
    case 'cancelled':
      return
    case 'session':
    case 'unclear':
      log.add("[SYS] Didn't catch that. Try again.", 'sys')
      return
    case 'setup':
      if (hasAccess()) {
        log.add(`[ERR] ${provider} rejected the API key. Check it in AI LINK > SETUP.`, 'err')
        void setup.open({ reason: `${provider} rejected the saved key. Paste it again, or pick another AI.` })
      } else {
        void setup.open({ reason: 'E.D.I.T.H needs an AI key. Add one to start.' })
      }
      return
    case 'voice':
      log.add(`[ERR] E.D.I.T.H can't understand speech with ${short}. Add a Groq, Gemini or OpenAI key for voice in SETUP, or type.`, 'err')
      void setup.open({ voice: true, reason: `${short} can't understand speech. Add a key for voice below, or type instead.` })
      return
    case 'model':
      log.add(`[ERR] ${provider} can't use that model with this key. Pick another model in SETUP.`, 'err')
      return
    case 'quota':
      log.add(`[ERR] ${provider} is out of quota or credits for now. Try again later, or switch AI in SETUP.`, 'err')
      return
    case 'offline':
      if (error.serverKind === 'network' && settings.base) {
        log.add("[ERR] E.D.I.T.H couldn't reach your server. Check the address in SETUP, and that it is running.", 'err')
      } else if (error.serverKind === 'overloaded') {
        log.add(`[ERR] ${provider} is busy right now. Try again in a moment.`, 'err')
      } else if (error.serverKind === 'timeout') {
        log.add('[ERR] That took too long. Try again.', 'err')
      } else {
        log.add("[ERR] Can't reach EDITH's server. Check your connection and try again.", 'err')
        setOnline(false)
        flashState('offline', '● OFFLINE')
      }
      return
    default: {
      if (error.serverKind === 'refused') {
        log.add(`[ERR] ${provider} declined to answer that.`, 'err')
        return
      }
      if (error.serverKind === 'blocked') {
        const why = error.ban.why ? `: ${error.ban.why}` : ''
        const when = error.ban.until
          ? ` It lifts on ${new Date(error.ban.until).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}.`
          : ''
        log.add(`[ERR] This browser is banned from E.D.I.T.H${why}.${when}`, 'err')
        return
      }
      const message = error.message && !/^Server error \d+$/.test(error.message) ? error.message : "Something went wrong on EDITH's server. Try again."
      log.add(`[ERR] ${message.slice(0, 300)}`, 'err')
    }
  }
}

// ── Saved chats ────────────────────────────────────────────────────────

function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 2592000) return `${Math.floor(s / 86400)}d`
  return new Date(ms).toISOString().slice(0, 10)
}

const chatTitle = (c: { title: string }) => c.title?.trim() || 'Untitled chat'

function renderRecent(state: 'ok' | 'loading' | 'offline' = 'ok'): void {
  const list = $('#memList')
  if (state !== 'ok' && !chats.length) {
    const row = document.createElement('div')
    row.className = 'mem-item'
    row.textContent = state === 'loading' ? 'loading...' : 'offline'
    return list.replaceChildren(row)
  }
  if (!chats.length) {
    const row = document.createElement('div')
    row.className = 'mem-item'
    row.textContent = 'no saved chats yet'
    return list.replaceChildren(row)
  }
  list.replaceChildren(
    ...chats.slice(0, RECENT_SHOWN).map((c) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `mem-chat${c.id === chatId ? ' cur' : ''}`
      const title = document.createElement('b')
      title.textContent = chatTitle(c)
      button.append(title, document.createTextNode(` · ${ago(c.updated)}`))
      button.title = `Open "${chatTitle(c)}"`
      button.addEventListener('click', () => void openChat(c.id))
      return button
    }),
  )
}

async function refreshChats(): Promise<void> {
  if (!chats.length) renderRecent('loading')
  try {
    chats = await api.chats()
    renderRecent()
    if (!drawer.hidden && !search.value.trim()) renderDrawer(chats)
  } catch {
    renderRecent('offline')
  }
}

/** A question and answer went into the current chat: the list shows it first. */
function answered(said: string): void {
  const now = Date.now()
  const entry = chats.find((c) => c.id === chatId)
  const updated: ChatSummary = entry
    ? { ...entry, updated: now, count: entry.count + 2 }
    : { id: chatId, title: said.replace(/\s+/g, ' ').trim().slice(0, 48), specialist: 'general', updated: now, count: 2 }
  chats = [updated, ...chats.filter((c) => c.id !== chatId)]
  renderRecent()
  answersInChat++
  // The server names a chat after its first answer, and again after its sixth.
  if (answersInChat === 1 || answersInChat === 6) window.setTimeout(() => void refreshChats(), TITLE_REFRESH_MS)
}

function showChat(chat: SavedChat, { clear = true } = {}): void {
  chatId = chat.id
  saveChatId(chat.id)
  history = chat.messages
    .slice(-CHAT_TURNS)
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] }) as ChatTurn)
  answersInChat = chat.messages.filter((m) => m.role !== 'user').length
  if (clear) log.clear()
  for (const m of chat.messages.slice(-CHAT_SHOWN)) {
    log.add(m.role === 'user' ? `[YOU] ${m.content}` : `[EDITH] ${m.content}`, m.role === 'user' ? 'you' : 'edith', { instant: true })
  }
  const last = [...chat.messages].reverse().find((m) => m.role !== 'user')
  showCaption(last?.content ?? '', { final: true })
  renderRecent()
}

async function openChat(id: string): Promise<void> {
  if (request || mic.recording) return void log.add('[SYS] Finish this question first.', 'sys')
  let chat: SavedChat | null
  try {
    chat = await api.openChat(id)
  } catch {
    log.add("[ERR] Couldn't open that chat. Check your connection and try again.", 'err')
    return
  }
  if (!chat) {
    chats = chats.filter((c) => c.id !== id)
    renderRecent()
    if (!drawer.hidden) renderDrawer(chats)
    log.add('[ERR] That chat no longer exists.', 'err')
    return
  }
  closeDrawer()
  speaker.stop()
  showChat(chat)
  log.add(`[SYS] Opened "${chatTitle(chat)}".`, 'sys')
}

function newChat({ quiet = false } = {}): void {
  if (request) return void log.add('[SYS] Finish this question first.', 'sys')
  speaker.stop()
  // An empty chat that was never saved is simply reused.
  const unsaved = chatId && answersInChat === 0 && !chats.some((c) => c.id === chatId)
  if (!unsaved) chatId = newChatId()
  saveChatId(chatId)
  history = []
  answersInChat = 0
  log.clear()
  showCaption('')
  renderRecent()
  if (!quiet) log.add('[SYS] New chat started. Saved chats are kept.', 'sys')
  if (mode === 'speaking') setMode('idle')
}

async function deleteChat(id: string, title: string): Promise<void> {
  if (request && id === chatId) return void log.add('[SYS] Finish this question first.', 'sys')
  if (!window.confirm(`Delete "${title}"?\n\nThis cannot be undone.`)) return
  try {
    await api.deleteChat(id)
  } catch {
    log.add("[ERR] Couldn't delete that chat. Try again.", 'err')
    return
  }
  chats = chats.filter((c) => c.id !== id)
  found = found?.filter((c) => c.id !== id) ?? null
  if (id === chatId) {
    chatId = ''
    newChat({ quiet: true })
  }
  renderRecent()
  renderDrawer(found ?? chats)
  log.add('[SYS] Chat deleted.', 'sys')
}

// The drawer: a JARVIS-style modal, listing every saved chat.
const drawer = $('#chats')
const search = $<HTMLInputElement>('#chSearch')
let found: ChatSummary[] | null = null
let searchTimer = 0
let searchTicket = 0
let drawerReturn: HTMLElement | null = null

function renderDrawer(list: ChatSummary[], empty = ''): void {
  const box = $('#chList')
  const q = search.value.trim()
  $('#chCount').textContent = q ? `${list.length} FOUND` : `${list.length} SAVED CHAT${list.length === 1 ? '' : 'S'}`
  if (!list.length) {
    const row = document.createElement('div')
    row.className = 'am-empty'
    row.textContent = empty || (q ? `no chat matches "${q}"` : 'no saved chats yet - ask E.D.I.T.H something')
    return box.replaceChildren(row)
  }
  box.replaceChildren(
    ...list.map((c) => {
      const item = document.createElement('div')
      item.className = `am-item${c.id === chatId ? ' cur' : ''}`
      const text = document.createElement('div')
      text.style.flex = '1'
      text.style.minWidth = '0'
      const k = document.createElement('div')
      k.className = 'k'
      k.textContent = chatTitle(c)
      const v = document.createElement('div')
      v.className = 'v'
      v.textContent = `${c.count} msg${c.count === 1 ? '' : 's'} · ${ago(c.updated)}${c.updated && ago(c.updated) !== 'now' && !/\d{4}/.test(ago(c.updated)) ? ' ago' : ''}${c.id === chatId ? ' · OPEN NOW' : ''}`
      text.append(k, v)
      const buttons = document.createElement('div')
      buttons.className = 'am-btns'
      const open = document.createElement('button')
      open.type = 'button'
      open.className = 'am-mini'
      open.textContent = 'OPEN'
      open.setAttribute('aria-label', `Open ${chatTitle(c)}`)
      open.addEventListener('click', () => void openChat(c.id))
      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'am-mini bad'
      del.textContent = 'DELETE'
      del.setAttribute('aria-label', `Delete ${chatTitle(c)}`)
      del.addEventListener('click', () => void deleteChat(c.id, chatTitle(c)))
      buttons.append(open, del)
      item.append(text, buttons)
      return item
    }),
  )
}

function openDrawer(): void {
  drawerReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null
  drawer.hidden = false
  search.value = ''
  found = null
  renderDrawer(chats, chats.length ? '' : 'loading...')
  search.focus()
  void refreshChats().then(() => {
    if (!drawer.hidden && !search.value.trim()) renderDrawer(chats)
  })
}

function closeDrawer(): void {
  if (drawer.hidden) return
  drawer.hidden = true
  window.clearTimeout(searchTimer)
  drawerReturn?.focus?.()
}

function searchChats(): void {
  window.clearTimeout(searchTimer)
  const q = search.value.trim()
  if (!q) {
    found = null
    return renderDrawer(chats)
  }
  searchTimer = window.setTimeout(async () => {
    const ticket = ++searchTicket
    try {
      const result = await api.chats(q)
      if (ticket !== searchTicket || search.value.trim() !== q) return
      found = result
      renderDrawer(result)
    } catch {
      if (ticket === searchTicket) renderDrawer([], "can't search right now - check your connection")
    }
  }, SEARCH_DELAY_MS)
}

// ── Voice in: hold to talk ─────────────────────────────────────────────

const talkBtn = $<HTMLButtonElement>('#talkBtn')
let starting = false
let stopWhenReady = false
let tapMode = false
let pressAt = 0
let pressKind = ''

function paintTalk(): void {
  const active = mic.recording || starting
  talkBtn.classList.toggle('active', active)
  talkBtn.textContent = !active ? '⏺  HOLD TO TALK' : tapMode ? '⏹  TAP TO SEND' : '⏹  RELEASE TO SEND'
}

async function startRecording(): Promise<void> {
  if (starting || mic.recording) return
  if (needsSetup()) return
  if (request) return void log.add('[SYS] Still answering - one moment.', 'sys')
  if (!canHear()) {
    log.add(`[SYS] ${shortName(providerLabel())} can't understand speech. Type, or add a voice key in SETUP (Groq and Gemini keys are free).`, 'sys')
    return
  }
  speaker.stop()
  if (mode === 'speaking') setMode('idle')
  starting = true
  stopWhenReady = false
  paintTalk()
  try {
    await mic.start()
  } catch (err) {
    starting = false
    tapMode = false
    paintTalk()
    micFailed(err)
    return
  }
  starting = false
  micProblem = ''
  noMicDevice = false
  paintVoice()
  setMode('listening')
  paintTalk()
  if (stopWhenReady) void finishRecording()
}

async function finishRecording(): Promise<void> {
  if (starting) {
    stopWhenReady = true
    return
  }
  if (!mic.recording) return
  tapMode = false
  const recording = await mic.stop()
  paintTalk()
  setBar('mMic', 0, 1, '--')
  setMode('idle')
  if (recording.ms < MIN_RECORDING_MS) return void log.add('[SYS] Too short. Hold the button while you speak.', 'sys')
  if (recording.peak < SILENCE) return void log.add("[SYS] I didn't hear anything. Check your microphone.", 'sys')
  await ask({ audio: { mime: 'audio/wav', data: recording.data } }, '🎙 transcribing…')
}

function micFailed(err: unknown): void {
  const problem: MicProblem = err instanceof MicError ? err.problem : 'failed'
  const lines: Record<MicProblem, string> = {
    insecure: 'Voice needs a secure (https) page. Type instead.',
    unsupported: "This browser can't record audio. Type instead.",
    denied: 'Microphone access is blocked. Allow it in the browser’s site settings, or type instead.',
    none: 'No microphone found. Plug one in, or type instead.',
    busy: 'The microphone is busy in another app. Close it and try again.',
    failed: "Couldn't start the microphone. Try again, or type instead.",
  }
  log.add(`[SYS] ${lines[problem]}`, 'sys')
  if (problem !== 'busy' && problem !== 'failed') micProblem = problem
  paintVoice()
  flashState('muted', '⊘ MUTED')
}

talkBtn.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  event.preventDefault()
  if (tapMode && (mic.recording || starting)) {
    void finishRecording()
    return
  }
  try {
    talkBtn.setPointerCapture(event.pointerId)
  } catch {
    // capture is a nicety
  }
  pressAt = performance.now()
  pressKind = event.pointerType
  tapMode = false
  void startRecording()
})

const release = (event: PointerEvent) => {
  if (!pressKind || event.pointerType !== pressKind) return
  pressKind = ''
  const quick = performance.now() - pressAt < TAP_MS
  if (quick && event.pointerType === 'touch' && event.type === 'pointerup' && (mic.recording || starting)) {
    // A tap on a phone: keep listening until the next tap.
    tapMode = true
    paintTalk()
    return
  }
  void finishRecording()
}
talkBtn.addEventListener('pointerup', release)
talkBtn.addEventListener('pointercancel', release)
talkBtn.addEventListener('contextmenu', (event) => event.preventDefault())
// Keyboard users: Enter on the focused button starts, and again sends.
talkBtn.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.repeat) return
  event.preventDefault()
  if (mic.recording || starting) void finishRecording()
  else {
    tapMode = true
    void startRecording()
  }
})

// Hold Space anywhere outside a text field.
let spaceHeld = false
document.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return
  if (typingIn(event.target) || !drawer.hidden || setup.isOpen) return
  // Space still presses whichever other button or link has the focus.
  const target = event.target as HTMLElement | null
  if (target && target !== talkBtn && target.closest?.('button, a[href], select, label, [role="button"]')) return
  event.preventDefault()
  spaceHeld = true
  tapMode = false
  void startRecording()
})
document.addEventListener('keyup', (event) => {
  if (event.code !== 'Space' || !spaceHeld) return
  event.preventDefault()
  spaceHeld = false
  void finishRecording()
})
window.addEventListener('blur', () => {
  if (spaceHeld) {
    spaceHeld = false
    void finishRecording()
  }
})

// ── Voice out: the speaker button and the audio banner ─────────────────

const muteBtn = $<HTMLButtonElement>('#muteBtn')
const audioInd = $('#audioInd')

function paintMute(): void {
  const on = settings.speak
  muteBtn.textContent = on ? '🔊' : '🔇'
  muteBtn.classList.toggle('on', on)
  muteBtn.classList.toggle('off', !on)
  muteBtn.setAttribute('aria-pressed', String(on))
  muteBtn.title = on ? 'Read answers aloud: on' : 'Read answers aloud: off'
}

function showAudioBanner(show: boolean): void {
  audioInd.hidden = !show
}

function enableAudio(): void {
  if (audioInd.hidden) return
  speaker.unlock()
  showAudioBanner(false)
}

muteBtn.addEventListener('click', () => {
  if (!settings.speak && !speaker.supported) {
    log.add("[SYS] This browser can't read answers aloud.", 'sys')
    return
  }
  settings = { ...settings, speak: !settings.speak }
  saveSettings(settings)
  paintMute()
  if (settings.speak) {
    speaker.unlock()
    log.add('[SYS] Answers will be read aloud.', 'sys')
  } else {
    speaker.stop()
    showAudioBanner(false)
    if (mode === 'speaking') setMode('idle')
    log.add('[SYS] Voice output off.', 'sys')
  }
})
document.addEventListener('pointerdown', enableAudio, true)
document.addEventListener('keydown', enableAudio, true)
audioInd.addEventListener('click', enableAudio)

// ── Typing, photos, buttons ────────────────────────────────────────────

const cmd = $<HTMLInputElement>('#cmd')
$('#cmdForm').addEventListener('submit', (event) => {
  event.preventDefault()
  const text = cmd.value.trim()
  if (!text) return
  if (!hasAccess()) return void needsSetup()
  if (request) return void log.add('[SYS] Still answering - one moment.', 'sys')
  cmd.value = ''
  void ask({ text }, text)
})

const imgFile = $<HTMLInputElement>('#imgFile')
const imgArea = $('#imgArea')
const imgTxt = $('#imgTxt')
const imgQ = $<HTMLInputElement>('#imgQ')
const PHOTO_PROMPT = '📷  Tap to choose or take a photo'
let photoTimer = 0

function photoState(text: string, cls: '' | 'uploading' | 'done' = '', resetAfter = 0): void {
  window.clearTimeout(photoTimer)
  imgTxt.textContent = text
  imgArea.classList.toggle('uploading', cls === 'uploading')
  imgArea.classList.toggle('done', cls === 'done')
  if (resetAfter) photoTimer = window.setTimeout(() => photoState(PHOTO_PROMPT), resetAfter)
}

async function askAboutPhoto(file: File): Promise<void> {
  if (needsSetup()) return
  if (request) return void log.add('[SYS] Still answering - one moment.', 'sys')
  photoState('📤 Reading photo...', 'uploading')
  let image
  try {
    image = await shrinkPhoto(file)
  } catch (err) {
    const message = err instanceof PhotoError ? err.message : "That photo couldn't be read."
    photoState(`✗ ${message}`, '', 6000)
    log.add(`[ERR] ${message}`, 'err')
    return
  }
  photoState('🧠 Analysing...', 'uploading')
  const question = imgQ.value.trim() || 'What is in this photo?'
  const ok = await ask({ text: question, image }, `📷 ${question}`)
  if (ok) {
    imgQ.value = ''
    photoState('✓ Analysed', 'done', 6000)
  } else photoState(PHOTO_PROMPT)
}

imgFile.addEventListener('change', () => {
  const file = imgFile.files?.[0]
  imgFile.value = '' // the same photo can be picked again
  if (file) void askAboutPhoto(file)
})
imgArea.addEventListener('dragover', (event) => {
  event.preventDefault()
  imgArea.classList.add('drag')
})
imgArea.addEventListener('dragleave', () => imgArea.classList.remove('drag'))
imgArea.addEventListener('drop', (event) => {
  event.preventDefault()
  imgArea.classList.remove('drag')
  const file = event.dataTransfer?.files?.[0]
  if (file) void askAboutPhoto(file)
})

$('#fsBtn').addEventListener('click', () => {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
  else void document.documentElement.requestFullscreen?.().catch(() => {})
})
$('#btnSetup').addEventListener('click', () => void setup.open())
$('#chatsBtn').addEventListener('click', openDrawer)
$('#clearBtn').addEventListener('click', () => newChat())
$('#chClose').addEventListener('click', closeDrawer)
$('#chNew').addEventListener('click', () => {
  closeDrawer()
  newChat()
})
search.addEventListener('input', searchChats)
drawer.addEventListener('click', (event) => {
  if (event.target === drawer) closeDrawer()
})
drawer.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDrawer()
})

// ── Setup ──────────────────────────────────────────────────────────────

const setup = new Setup({
  api,
  providers: () => providers,
  loadProviders,
  settings: () => settings,
  hasAccess,
  saved: (result: SavedSetup) => {
    const before = settings
    settings = result.settings
    saveSettings(settings)
    setLanguage(settings.language || guessLanguage())
    paintAccess()
    if (result.prefsOnly) {
      log.add('[SYS] Settings saved.', 'sys')
    } else {
      log.add(`[SYS] AI link established: ${result.label} · ${result.modelName}.`, 'sys')
      if (result.voiceLabel) log.add(`[SYS] Voice runs on ${result.voiceLabel}.`, 'sys')
      if (result.freeTier) log.add('[SYS] Your OpenRouter account has no credits yet, so E.D.I.T.H starts on a free model.', 'sys')
      if (!storageWorks) log.add("[SYS] This browser won't keep your key after you close it (private window?).", 'sys')
      if (!before.provider) log.add('[SYS] Ready. Type a command, or hold the talk button (or Space) and speak.', 'sys')
    }
  },
  forget: async () => {
    try {
      await api.forget()
    } catch {
      return false
    }
    speaker.stop()
    forgetBrowser()
    settings = { ...DEFAULT_SETTINGS }
    setLanguage(guessLanguage())
    device = deviceId()
    chats = []
    chatId = newChatId()
    saveChatId(chatId)
    history = []
    answersInChat = 0
    log.clear()
    showCaption('')
    paintMute()
    paintAccess()
    renderRecent()
    log.add('[SYS] This browser has been forgotten: memories, saved chats and keys are deleted.', 'sys')
    void setup.open()
    return true
  },
  closed: () => paintState(),
})

// ── Boot ───────────────────────────────────────────────────────────────

async function restoreChat(): Promise<void> {
  const stored = loadChatId()
  if (!stored) {
    chatId = newChatId()
    saveChatId(chatId)
    return
  }
  chatId = stored
  try {
    const chat = await api.openChat(stored)
    if (!chat || !chat.messages.length) return
    if (Date.now() - (chat.updated || 0) > CONTINUE_CHAT_MS) {
      chatId = newChatId()
      saveChatId(chatId)
      return
    }
    log.add('[SYS] Previous conversation restored.', 'sys')
    showChat(chat, { clear: false })
  } catch {
    // Offline or not saved yet: carry on with this chat id.
  }
}

async function boot(): Promise<void> {
  tickClock()
  tickUp()
  window.setInterval(tickClock, 1000)
  window.setInterval(tickUp, 1000)
  paintMute()
  paintAccess()
  setBar('mMic', 0, 1, '--')
  setBar('mLat', 0, 10_000, '--')
  void checkMicDevice()
  navigator.mediaDevices?.addEventListener?.('devicechange', () => void checkMicDevice())

  // Like JARVIS: when answers are read aloud, the browser has to be tapped once first.
  const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation
  if (settings.speak && speaker.supported && activation && !activation.hasBeenActive) showAudioBanner(true)

  log.add('[SYS] E.D.I.T.H web core online.', 'sys')
  if (!storageWorks) log.add("[SYS] This browser won't keep settings (private window?). Keys last until the tab closes.", 'sys')
  try {
    await loadProviders()
  } catch {
    setOnline(false)
    log.add("[ERR] Can't reach EDITH's server. Check your connection, then reload.", 'err')
  }
  if (!hasAccess()) {
    log.add('[SYS] Choose an AI and paste its key in the setup window to begin.', 'sys')
    void setup.open()
    renderRecent()
    void refreshChats()
    return
  }
  log.add(`[SYS] AI link: ${providerLabel()} · ${modelShort(settings.model || providerInfo()?.defaultModel || 'auto')}.`, 'sys')
  await restoreChat()
  void refreshChats()
}

void boot()
