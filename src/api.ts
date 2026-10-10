// Client for EDITH's backend (server/app.mjs).

import { getLanguage } from './i18n'
import type { ActionLink, AnswerStyle, CustomSpecialist, HomeSettings, Prefs } from './prefs'
//
// Every call carries an X-Device-Id, which scopes memory and chat history on the
// server, plus whichever credentials this phone has: a key for the chosen AI
// provider (X-AI-Provider / X-AI-Key / X-AI-Model), an optional separate key for
// voice (X-Voice-Provider / X-Voice-Key), the account session when signed in
// (X-Edith-Session, which scopes memory and history to the account instead), and
// the language picked at setup (X-Edith-Language).

export interface ChatTurn {
  role: 'user' | 'model'
  parts: Array<{ text: string }>
}

export interface ChatReply {
  reply: string
  userText: string
  history: ChatTurn[]
  toolsUsed: string[]
  model?: string
  /** The saved chat the question and answer went into. */
  chatId?: string
  /** Countdowns and alarms to run on the glasses, and whether to stop the ones running. */
  timers?: Array<{ ms: number; label: string; at?: string }>
  cancelTimers?: boolean
  /** Something that unlocks or opens a way into the home, waiting for a tap on the glasses. */
  /** Something waiting for a tap on the glasses: a door to unlock, or a job on the wearer's PC (EDITH 3). */
  confirm?: { what: string; token: string; kind?: string }
  /** A list to show on the glasses and tick off (1.7.0). */
  list?: SavedList
  /** Things to choose between on the glasses, e.g. which café to walk to (1.7.0). */
  pick?: { question: string; options: string[] }
  /** A rule this phone broke since it last asked something, and what happens next (1.8.0). */
  warning?: { code: string; label: string; blocked: boolean; left: number }
}

/** One of the wearer's lists: shopping, packing, jobs to do. */
export interface SavedList {
  name: string
  items: string[]
  /** The items already ticked off, by their position in `items`. */
  done: number[]
  updated?: number
}

/** Which saved chat a question belongs to, and how to answer it. */
export interface AnswerOptions {
  chatId: string
  style: AnswerStyle
  instructions: string
  specialist: string
  translateTo: string
  /** Set when the specialist is one the wearer wrote. */
  custom?: CustomSpecialist | null
  /** What the phone read from the wearer's calendar (1.6.0); the server keeps none of it. */
  calendar?: CalendarSend[]
  home?: HomeSettings
  actions?: ActionLink[]
  /** What this phone can do with an answer, e.g. run a countdown. */
  can?: string[]
  /** What EDITH heard in the room just now, for notes and "what did they just say?" (1.8.0). */
  heard?: string
  /** Where the answer is read: EDITH's website or the PC app. The glasses app sends none. */
  surface?: 'web' | 'desktop'
}

/** One calendar event as the phone sends it: already worded in the phone's language. */
export interface CalendarSend {
  when: string
  title: string
  where: string
  /** 0 for today, 1 for tomorrow, and so on. */
  day: number
}

/** The weather where the wearer is, for the glasses dashboard. */
export interface Glance {
  city: string
  temp_c?: number
  conditions?: string
  high_c?: number
  low_c?: number
}

/** A saved chat in the list, newest first. */
export interface ChatSummary {
  id: string
  title: string
  specialist: string
  updated: number
  /** Messages in the chat: questions and answers. */
  count: number
}

export interface SavedChat {
  id: string
  title: string
  specialist: string
  updated: number
  messages: Array<{ role: 'user' | 'model'; content: string; at?: string }>
}

export interface ProviderInfo {
  id: string
  label: string
  note: string
  keyUrl: string
  /** Whether this provider can turn speech into text. */
  voice: boolean
  /** Popular models, best first, to pick from before a key is checked. */
  models?: ModelInfo[]
  defaultModel?: string
  /** "Your own server": the wearer gives the address, and the key is optional (1.7.4). */
  needsBase?: boolean
  keyOptional?: boolean
  /** The company's own voices for reading answers aloud, none for most (2.1). */
  voices?: VoiceInfo[]
  defaultVoice?: string
}

/** One of an AI company's voices: its id, name, and how the company describes it. */
export interface VoiceInfo {
  id: string
  name: string
  note: string
}

export interface ModelInfo {
  id: string
  name: string
  /** Catalog models only: the plain name and hint codes, for wording in the phone's language. */
  label?: string
  hints?: string[]
}

export interface ModelList {
  models: ModelInfo[]
  defaultModel: string
}

/** A photo taken or picked on the phone, already made small, to ask about (1.7.0). */
export interface AskImage {
  mime: string
  data: string
}

export type AskPayload = ({ text: string } | { audio: { mime: 'audio/wav'; data: string } }) & { image?: AskImage }

export type FailureKind = 'offline' | 'quota' | 'server' | 'cancelled' | 'setup' | 'voice' | 'unclear' | 'model' | 'session'

/** How a customer signed in to their account. */
export type SignInMethod = 'google' | 'microsoft' | 'email'

export interface AccountInfo {
  email: string
  name: string
  method: SignInMethod
}

/** What follows an account between phones. Profiles saved by EDITH 1.4 have no preferences. */
export interface SyncedProfile extends Partial<Prefs> {
  keys: Record<string, { key: string; model: string; label: string; voice: boolean; base?: string }>
  active: string
  voice: string
  language: string
}

export interface SignInLink {
  code: string
  pollToken: string
  url: string
  expiresIn: number
}

export type SignInPoll =
  | { status: 'pending' | 'expired' | 'unknown' }
  | { status: 'approved'; session: string; account: AccountInfo }

/** Connecting OpenRouter in the browser: the link, and what the phone polls with. */
export interface ConnectLink {
  id: string
  pollToken: string
  url: string
  expiresIn: number
}

export type ConnectPoll =
  | { status: 'pending' | 'expired' | 'unknown' | 'failed' }
  | { status: 'connected'; provider: string; key: string }

export interface Access {
  /** A provider id, or "" for none. */
  provider: string
  key: string
  model: string
  /** For a server of their own: its https address. */
  base?: string
  voiceProvider: string
  voiceKey: string
}

export interface StreamHandlers {
  /** What the server is doing: "transcribing", then "thinking" before each model turn. */
  onStatus?(stage: string): void
  onTranscript?(text: string): void
  onDelta?(text: string): void
  onReset?(): void
  onTool?(names: string[]): void
}

export class ApiError extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
    /** The server's own kind ("refused", "overloaded", "blocked"...), for wording the problem. */
    readonly serverKind = '',
    /** A ban: why it was given, and when it lifts (1.8.0). */
    readonly ban: { why?: string; until?: number } = {},
  ) {
    super(message)
  }
}

const REQUEST_TIMEOUT_MS = 60_000
const RETRY_WAITS_MS = [1_200, 2_600]

export class EdithApi {
  constructor(
    private readonly base: string,
    private readonly deviceId: () => string,
    private readonly access: () => Access,
    private readonly session: () => string,
    /** Called when the server says this phone's account session has ended. */
    private readonly onSessionEnded: () => void,
    /** Where the phone is as "lat,lon", or "" when location is off (1.6.0). */
    private readonly location: () => string = () => '',
  ) {}

  /** Whether this server offers accounts. */
  async accountsEnabled(): Promise<boolean> {
    const res = await this.request('/account/config', { headers: { 'X-Edith-Language': getLanguage() } })
    const data = await res.json().catch(() => ({}))
    return Boolean(res.ok && data.enabled)
  }

  /** Starts signing this phone in: a link to open in a browser, and what to poll with. */
  async startSignIn(): Promise<SignInLink> {
    const res = await this.request('/account/link/start', { method: 'POST', headers: this.headers() })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.code) throw new ApiError('server', String(data.error || `Server error ${res.status}`), String(data.kind || ''))
    return data as SignInLink
  }

  async pollSignIn(link: SignInLink): Promise<SignInPoll> {
    const res = await this.request('/account/link/poll', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ code: link.code, pollToken: link.pollToken }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new ApiError('server', String(data.error || `Server error ${res.status}`))
    return data as SignInPoll
  }

  /** The signed-in account, with its synced settings and keys (null profile when nothing is synced yet). */
  async account(): Promise<{ account: AccountInfo; profile: SyncedProfile | null; updatedAt: number }> {
    const res = await this.request('/account', { headers: this.headers() })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new ApiError(res.status === 401 ? 'session' : 'server', String(data.error || `Server error ${res.status}`))
    return data
  }

  /** Saves settings and keys to the account. If the account has a newer copy, that comes back instead. */
  async saveProfile(profile: SyncedProfile, updatedAt: number): Promise<{ ok: boolean; profile?: SyncedProfile; updatedAt: number }> {
    const res = await this.request('/account/profile', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ profile, updatedAt }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new ApiError(res.status === 401 ? 'session' : 'server', String(data.error || `Server error ${res.status}`))
    return data
  }

  /** Starts connecting OpenRouter: a link that sends the browser to OpenRouter to approve EDITH. */
  async startConnect(): Promise<ConnectLink> {
    const res = await this.request('/connect/openrouter/start', { method: 'POST', headers: this.headers() })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.id) throw new ApiError('server', String(data.error || `Server error ${res.status}`), String(data.kind || ''))
    return data as ConnectLink
  }

  /** Once OpenRouter approved, this returns the key (once). */
  async pollConnect(link: ConnectLink): Promise<ConnectPoll> {
    const res = await this.request('/connect/openrouter/poll', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ id: link.id, pollToken: link.pollToken }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new ApiError('server', String(data.error || `Server error ${res.status}`))
    return data as ConnectPoll
  }

  async signOut(): Promise<void> {
    await this.request('/account/signout', { method: 'POST', headers: this.headers() })
  }

  async deleteAccount(): Promise<void> {
    const res = await this.request('/account/delete', { method: 'POST', headers: this.headers() })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok) throw new ApiError('server', String(data.error || `Server error ${res.status}`))
  }

  async providers(): Promise<ProviderInfo[]> {
    // X-Edith-Can tells the server this app can ask for a server address of the wearer's own.
    const res = await this.request('/providers', { headers: this.headers({ 'X-Edith-Can': 'ownServer' }) })
    if (!res.ok) throw new ApiError('server', `Server error ${res.status}`)
    const data = await res.json()
    return Array.isArray(data.providers) ? data.providers : []
  }

  /**
   * Asks the server whether a key works for a provider, and which models it offers.
   * `code` says what was wrong (provider, format, elsewhere, rejected, network, other).
   */
  async checkKey(provider: string, key: string, base = ''): Promise<{ ok: boolean; error: string; code: string; other: string; freeTier: boolean } & ModelList> {
    const res = await this.request('/check-key', {
      method: 'POST',
      headers: { 'X-AI-Provider': provider, 'X-AI-Key': key, ...(base ? { 'X-AI-Base': base } : {}) },
    })
    const data = await res.json().catch(() => ({}))
    return {
      ok: Boolean(data.ok),
      error: String(data.error || `Server error ${res.status}`),
      code: String(data.code || (data.ok ? '' : 'other')),
      other: String(data.other || ''),
      freeTier: Boolean(data.freeTier),
      models: Array.isArray(data.models) ? data.models : [],
      defaultModel: String(data.defaultModel || ''),
    }
  }

  /** The models for a provider and key. */
  async models(provider: string, key: string, base = ''): Promise<ModelList> {
    const headers = { 'X-Device-Id': this.deviceId(), 'X-AI-Provider': provider, 'X-AI-Key': key, ...(base ? { 'X-AI-Base': base } : {}) }
    const res = await this.request('/models', { headers })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new ApiError(res.status === 401 ? 'setup' : 'server', String(data.error || `Server error ${res.status}`))
    return { models: Array.isArray(data.models) ? data.models : [], defaultModel: String(data.defaultModel || '') }
  }

  /**
   * Saved chats, newest first. With a query, the chats whose title or words match it
   * (sent in the body, so the words stay out of URLs).
   */
  async chats(query = ''): Promise<ChatSummary[]> {
    const res = query
      ? await this.request('/chats/search', {
          method: 'POST',
          headers: this.headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ q: query }),
        })
      : await this.request('/chats', { headers: this.headers() })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new ApiError(res.status === 401 ? 'session' : 'server', String(data.error || `Server error ${res.status}`))
    return Array.isArray(data.chats) ? data.chats : []
  }

  /** A saved chat with its messages, or null when it no longer exists. */
  async openChat(id: string): Promise<SavedChat | null> {
    const res = await this.request(`/chats/${encodeURIComponent(id)}`, { headers: this.headers() })
    if (res.status === 404) return null
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.chat) throw new ApiError(res.status === 401 ? 'session' : 'server', String(data.error || `Server error ${res.status}`))
    const chat = data.chat as SavedChat
    return { ...chat, messages: Array.isArray(chat.messages) ? chat.messages.filter((m) => m && typeof m.content === 'string') : [] }
  }

  async deleteChat(id: string): Promise<void> {
    const res = await this.request(`/chats/${encodeURIComponent(id)}`, { method: 'DELETE', headers: this.headers() })
    if (!res.ok) throw new ApiError('server', `Server error ${res.status}`)
  }

  /** Fetches one of the wearer's calendar links through EDITH's server, as an iCal file. */
  async calendar(url: string): Promise<string> {
    const res = await this.request('/calendar', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ url }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new ApiError(res.status === 429 ? 'quota' : 'server', String(data.error || `Server error ${res.status}`))
    }
    return res.text()
  }

  /** The weather where the phone is, for the glasses dashboard. */
  async glance(at: string): Promise<Glance | null> {
    const res = await this.request(`/glance?at=${encodeURIComponent(at)}`, { headers: this.headers() })
    if (!res.ok) return null
    const data = await res.json().catch(() => null)
    return data && typeof data.city === 'string' ? (data as Glance) : null
  }

  /** Runs one of the wearer's own actions now; EDITH's server calls the webhook. */
  async runAction(name: string, actions: ActionLink[]): Promise<{ ok: boolean; error?: string }> {
    const res = await this.request('/action', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name, actions }),
    })
    const data = await res.json().catch(() => ({}))
    return { ok: Boolean(data.ok), error: data.error ? String(data.error) : undefined }
  }

  /**
   * Carries out what the wearer tapped to confirm: unlocking a door, opening a garage, or
   * (EDITH 3) a job on their PC, whose outcome comes back as `said`.
   */
  async confirm(token: string, home?: HomeSettings): Promise<{ ok: boolean; what?: string; said?: string; error?: string }> {
    const res = await this.request('/confirm', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ token, home }),
    })
    const data = await res.json().catch(() => ({}))
    return { ok: Boolean(data.ok), what: data.what, said: data.said ? String(data.said) : undefined, error: data.error }
  }

  /**
   * Text read aloud by a company's own voice, as a WAV file (2.1). `via` says which key pays:
   * the AI's ("chat") or the separate voice key ("voice"). `override` tries keys not saved yet.
   */
  async speak(text: string, voice: string, via: 'chat' | 'voice', signal?: AbortSignal, override?: Access): Promise<ArrayBuffer> {
    const res = await this.request(
      '/speak',
      { method: 'POST', headers: this.headers({ 'Content-Type': 'application/json' }, override), body: JSON.stringify({ text, voice, via }) },
      signal,
    )
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw failure(res.status, data)
    }
    return res.arrayBuffer()
  }

  /** The words in a recording so far, to show while the wearer is still speaking. */
  async transcribe(audio: { mime: 'audio/wav'; data: string }, signal?: AbortSignal): Promise<string> {
    const res = await this.request(
      '/transcribe',
      { method: 'POST', headers: this.headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ audio }) },
      signal,
    )
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw failure(res.status, data)
    return String(data.text || '')
  }

  /**
   * One segment of what someone else said, for subtitles on the glasses (1.8.0).
   * `spoken` is their language when the wearer has said which, `translateTo` the
   * wearer's when they want it turned round.
   */
  async room(
    audio: { mime: 'audio/wav'; data: string },
    options: { spoken?: string; translateTo?: string } = {},
    signal?: AbortSignal,
  ): Promise<{ text: string; translated: string }> {
    const res = await this.request(
      '/room',
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ audio, spoken: options.spoken || '', translateTo: options.translateTo || '' }),
      },
      signal,
    )
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw failure(res.status, data)
    return { text: String(data.text || ''), translated: String(data.translated || '') }
  }

  /** Forgets the conversation so far on the server, for a new chat (memories stay). */
  async forgetConversation(): Promise<void> {
    const res = await this.request('/history', { method: 'DELETE', headers: this.headers() })
    if (!res.ok) throw new ApiError('server', `Server error ${res.status}`)
  }

  /** Deletes this device's memories, conversation, saved chats and lists from the server. */
  async forget(): Promise<void> {
    for (const path of ['/memory', '/history', '/chats', '/lists']) {
      const res = await this.request(path, { method: 'DELETE', headers: this.headers() })
      if (!res.ok) throw new ApiError('server', `Server error ${res.status}`)
    }
  }

  /**
   * Sends a question and streams the answer: handlers fire as the transcript,
   * tool use and answer text arrive. Resolves with the finished reply.
   */
  async chat(
    payload: AskPayload,
    history: ChatTurn[],
    options: AnswerOptions,
    handlers: StreamHandlers,
    signal?: AbortSignal,
    /** A different AI than the phone's usual one, for a second opinion (1.7.0). */
    withAi?: Access,
  ): Promise<ChatReply> {
    const body = JSON.stringify({ localTime: localTime(), history: history.slice(-20), ...options, ...payload })
    const res = await this.withRetry(
      () =>
        this.request(
          '/chat',
          {
            method: 'POST',
            headers: this.headers({ 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, withAi),
            body,
          },
          signal,
        ),
      signal,
    )

    if (!(res.headers.get('content-type') || '').includes('ndjson')) {
      // Errors before the answer starts come back as JSON.
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.error) throw failure(res.status, data)
      return toReply(data, history)
    }

    let done: ChatReply | null = null
    try {
      for await (const event of readLines(res, signal)) {
        switch (event.type) {
          case 'transcript':
            handlers.onTranscript?.(String(event.text || ''))
            break
          case 'status':
            handlers.onStatus?.(String(event.stage || ''))
            break
          case 'delta':
            handlers.onDelta?.(String(event.text || ''))
            break
          case 'reset':
            handlers.onReset?.()
            break
          case 'tool':
            handlers.onTool?.(Array.isArray(event.names) ? event.names.map(String) : [])
            break
          case 'error':
            throw failure(0, event)
          case 'done':
            done = toReply(event, history)
            break
        }
      }
    } catch (err) {
      if (err instanceof ApiError) throw err
      if (signal?.aborted) throw new ApiError('cancelled', 'Cancelled.')
      throw new ApiError('offline', 'The connection dropped before the answer finished.')
    }
    if (!done) throw new ApiError('offline', 'The connection dropped before the answer finished.')
    return done
  }

  /** The wearer's lists, newest first. */
  async lists(): Promise<SavedList[]> {
    const res = await this.request('/lists', { headers: this.headers() })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new ApiError(res.status === 401 ? 'session' : 'server', String(data.error || `Server error ${res.status}`))
    return (Array.isArray(data.lists) ? data.lists : []).map(cleanList)
  }

  /** Saves a list under its name, or deletes it when `items` is empty. */
  async saveList(list: SavedList): Promise<void> {
    const res = await this.request('/lists', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(list),
    })
    if (!res.ok) throw new ApiError('server', `Server error ${res.status}`)
  }

  private headers(extra: Record<string, string> = {}, override?: Access): Record<string, string> {
    const a = override ?? this.access()
    const session = this.session()
    return {
      'X-Device-Id': this.deviceId(),
      'X-Edith-Language': getLanguage(),
      ...(this.location() ? { 'X-Edith-Location': this.location() } : {}),
      ...(session ? { 'X-Edith-Session': session } : {}),
      ...(a.provider ? { 'X-AI-Provider': a.provider } : {}),
      ...(a.provider && a.key ? { 'X-AI-Key': a.key } : {}),
      ...(a.provider && a.model ? { 'X-AI-Model': a.model } : {}),
      ...(a.base ? { 'X-AI-Base': a.base } : {}),
      ...(a.voiceProvider ? { 'X-Voice-Provider': a.voiceProvider } : {}),
      ...(a.voiceProvider && a.voiceKey ? { 'X-Voice-Key': a.voiceKey } : {}),
      ...extra,
    }
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    // Built by hand rather than with AbortSignal.any/timeout, which older
    // iOS WebViews lack.
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, REQUEST_TIMEOUT_MS)
    const forwardAbort = () => controller.abort()
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener('abort', forwardAbort, { once: true })

    try {
      const res = await fetch(this.base + path, { ...init, signal: controller.signal })
      // For a streamed answer the timer stays armed while the body is read, so a
      // stuck stream still ends at the deadline; firing after it finished is harmless.
      if (!(res.headers.get('content-type') || '').includes('ndjson')) clearTimeout(timer)
      if (res.status === 401 && res.headers.get('X-Edith-Session') === 'ended') this.onSessionEnded()
      return res
    } catch (err) {
      clearTimeout(timer)
      if (signal?.aborted) throw new ApiError('cancelled', 'Cancelled.')
      if (timedOut) throw new ApiError('offline', 'The server took too long to answer.')
      throw new ApiError('offline', `Can't reach the server (${(err as Error)?.message || 'network error'}).`)
    } finally {
      signal?.removeEventListener('abort', forwardAbort)
    }
  }

  /** Retry rate-limit and gateway blips (429/502/503/504) and network errors before an answer starts. */
  private async withRetry(send: () => Promise<Response>, signal?: AbortSignal): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const last = attempt === RETRY_WAITS_MS.length
      try {
        const res = await send()
        const retryable = [429, 502, 503, 504].includes(res.status) && !(res.headers.get('content-type') || '').includes('json')
        if (last || !retryable) return res
      } catch (err) {
        if (last || (err instanceof ApiError && err.kind === 'cancelled')) throw err
      }
      await wait(RETRY_WAITS_MS[attempt], signal)
    }
  }
}

function failure(status: number, data: Record<string, unknown>): ApiError {
  const message = String(data.error || `Server error ${status}`)
  const kind = String(data.kind || '')
  if (kind === 'session') return new ApiError('session', message, kind)
  if (status === 401 || data.needsKey || kind === 'key') return new ApiError('setup', message, kind)
  if (data.needsVoiceKey || kind === 'voice') return new ApiError('voice', message, kind)
  if (kind === 'quota' || /quota/i.test(message)) return new ApiError('quota', message, kind)
  if (kind === 'unclear') return new ApiError('unclear', message, kind)
  if (kind === 'model') return new ApiError('model', message, kind)
  if (kind === 'blocked') return new ApiError('server', message, kind, { why: typeof data.why === 'string' ? data.why : undefined, until: typeof data.until === 'number' ? data.until : undefined })
  if (kind === 'network' || kind === 'timeout' || kind === 'overloaded') return new ApiError('offline', message, kind)
  return new ApiError('server', message, kind)
}

function toReply(data: Record<string, unknown>, history: ChatTurn[]): ChatReply {
  const pick = data.pick as { question?: unknown; options?: unknown } | undefined
  return {
    list: data.list && typeof data.list === 'object' ? cleanList(data.list) : undefined,
    pick:
      pick && Array.isArray(pick.options) && pick.options.length
        ? { question: String(pick.question || ''), options: pick.options.map(String).slice(0, 12) }
        : undefined,
    reply: String(data.reply || ''),
    userText: String(data.userText || ''),
    history: Array.isArray(data.history) ? (data.history as ChatTurn[]) : history,
    toolsUsed: Array.isArray(data.toolsUsed) ? (data.toolsUsed as string[]) : [],
    model: typeof data.model === 'string' ? data.model : undefined,
    chatId: typeof data.chatId === 'string' ? data.chatId : undefined,
    timers: Array.isArray(data.timers) ? (data.timers as ChatReply['timers']) : undefined,
    cancelTimers: data.cancelTimers === true ? true : undefined,
    confirm: data.confirm && typeof data.confirm === 'object' ? (data.confirm as ChatReply['confirm']) : undefined,
    warning: data.warning && typeof data.warning === 'object' ? (data.warning as ChatReply['warning']) : undefined,
  }
}

/** A list as it arrives from the server, with anything odd dropped. */
export function cleanList(raw: unknown): SavedList {
  const list = (raw ?? {}) as Partial<SavedList>
  const items = (Array.isArray(list.items) ? list.items : []).map((item) => String(item).trim()).filter(Boolean).slice(0, 40)
  return {
    name: String(list.name || '').trim().slice(0, 40),
    items,
    done: [...new Set((Array.isArray(list.done) ? list.done : []).map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < items.length))],
    updated: typeof list.updated === 'number' ? list.updated : undefined,
  }
}

/** Yields each JSON line of a streamed response. */
async function* readLines(res: Response, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  if (!res.body) throw new ApiError('offline', 'The server sent an empty reply.')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const cancel = () => void reader.cancel().catch(() => {})
  signal?.addEventListener('abort', cancel, { once: true })
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        try {
          yield JSON.parse(line)
        } catch {
          // A malformed line is skipped rather than failing the whole answer.
        }
      }
      if (done) return
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new ApiError('cancelled', 'Cancelled.'))
      },
      { once: true },
    )
  })
}

/** e.g. "Sunday, 13 September 2026 at 10:42 (Asia/Dubai)" so answers use the wearer's clock. */
function localTime(): string {
  const now = new Date()
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  const text = now.toLocaleString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  return zone ? `${text} (${zone})` : text
}
