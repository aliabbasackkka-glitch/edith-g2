// What EDITH's website keeps in this browser: the AI key and settings, a random device key,
// and the chat it was in. Nothing here leaves the browser except in the request headers and
// bodies EdithApi sends to EDITH's server. localStorage can be missing or full (private
// windows, blocked site data), so every read and write is guarded and the page still works,
// it just forgets on reload.

import type { AnswerStyle } from '../prefs'

export interface WebSettings {
  /** The AI provider id from /api/providers, or "" before setup. */
  provider: string
  key: string
  model: string
  /** "Your own server": its https address. */
  base: string
  /** A second AI for speech when the chosen one can't hear. */
  voiceProvider: string
  voiceKey: string
  style: AnswerStyle
  /** The answer language, one of EDITH's nine. */
  language: string
  /** Read answers aloud. Off unless turned on. */
  speak: boolean
  /** The voice that reads them: one of the AI company's voices, or "" for the browser's own (2.1). */
  voiceName: string
  /** Which key pays for that voice: the AI's ("chat") or the separate voice key ("voice"). */
  voiceVia: '' | 'chat' | 'voice'
}

const KEYS = {
  settings: 'edith.web.settings',
  device: 'edith.web.device',
  chat: 'edith.web.chat',
}

const STYLES: AnswerStyle[] = ['short', 'normal', 'detailed']

export const DEFAULT_SETTINGS: WebSettings = {
  provider: '',
  key: '',
  model: '',
  base: '',
  voiceProvider: '',
  voiceKey: '',
  style: 'normal',
  language: '',
  speak: false,
  voiceName: '',
  voiceVia: '',
}

/** Whether this browser kept the last thing written; false in some private windows. */
export let storageWorks = true

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    storageWorks = false
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    storageWorks = false
  }
}

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '')

export function loadSettings(): WebSettings {
  let raw: Record<string, unknown> = {}
  try {
    raw = JSON.parse(read(KEYS.settings) || '{}') || {}
  } catch {
    raw = {}
  }
  const style = STYLES.includes(raw.style as AnswerStyle) ? (raw.style as AnswerStyle) : 'normal'
  return {
    provider: text(raw.provider, 40),
    key: text(raw.key, 400),
    model: text(raw.model, 200),
    base: text(raw.base, 500),
    voiceProvider: text(raw.voiceProvider, 40),
    voiceKey: text(raw.voiceKey, 400),
    style,
    language: text(raw.language, 5),
    speak: raw.speak === true,
    voiceName: text(raw.voiceName, 40),
    voiceVia: raw.voiceVia === 'chat' || raw.voiceVia === 'voice' ? raw.voiceVia : '',
  }
}

export function saveSettings(settings: WebSettings): void {
  write(KEYS.settings, JSON.stringify(settings))
}

/** This browser's random device key, made once: "edith_" and 24 letters and digits. */
export function deviceId(): string {
  const stored = read(KEYS.device) || ''
  if (/^edith_[a-z0-9]{24}$/.test(stored)) return stored
  const id = randomId('edith_', 24)
  write(KEYS.device, id)
  return id
}

export function loadChatId(): string {
  return cleanChatId(read(KEYS.chat) || '')
}

export function saveChatId(id: string): void {
  write(KEYS.chat, id || null)
}

/** Removes everything EDITH's website kept in this browser. */
export function forgetBrowser(): void {
  for (const key of Object.values(KEYS)) write(key, null)
}

/** A saved chat's id as the server accepts it, or "". */
export function cleanChatId(raw: string): string {
  return /^[A-Za-z0-9_-]{6,40}$/.test(raw) ? raw : ''
}

/** A new chat id, the way the glasses app makes them. */
export function newChatId(): string {
  return randomId('c', 20)
}

function randomId(prefix: string, length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return prefix + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}
