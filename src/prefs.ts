// How EDITH answers, what the glasses menu holds, and what EDITH is connected to: answer
// length, how answers appear on the glasses, live words, the wearer's own instructions, the
// specialist, the menu, and (1.6.0) location, the dashboard, hands-free follow-ups,
// specialists they wrote, calendar links, a smart home, their own actions and routines.
// Kept on the phone, synced with an account, and checked the same way by the server
// (server/lib/prefs.mjs).

export type AnswerStyle = 'short' | 'normal' | 'detailed'
export type Pace = 'instant' | 'fast' | 'relaxed'
export type Specialist = 'general' | 'translator' | 'coach' | 'chef' | 'tutor'
/** A built-in specialist, or one the wearer wrote (custom:0 to custom:2). */
export type SpecialistChoice = Specialist | string
export type MenuChoice =
  | 'newChat'
  | 'briefing'
  | 'type'
  | 'lists'
  | 'chats'
  | 'history'
  | 'second'
  | 'switchAi'
  | 'specialist'
  | 'repeat'
  | 'discreet'
  | 'send'
  | 'subtitles'
  | 'translate'
/** How the phone screen looks: EDITH's own, or the Even Hub palette. */
export type Theme = 'edith' | 'even'
/** What a touch on the ring does, when it isn't simply the same as the temple. */
export type RingAction = 'same' | 'repeat' | 'history' | 'briefing' | 'type' | 'lists'
/** How talking starts: a tap or a hold, or only a hold, for pockets and busy hands. */
export type TalkStart = 'tapOrHold' | 'holdOnly'

export const STYLES: AnswerStyle[] = ['short', 'normal', 'detailed']
export const PACES: Pace[] = ['instant', 'fast', 'relaxed']
export const THEMES: Theme[] = ['edith', 'even']
export const SPECIALISTS: Specialist[] = ['general', 'translator', 'coach', 'chef', 'tutor']
export const MENU_CHOICES: MenuChoice[] = [
  'newChat',
  'briefing',
  'type',
  'lists',
  'chats',
  'history',
  'second',
  'switchAi',
  'specialist',
  'repeat',
  'discreet',
  'send',
  'subtitles',
  'translate',
]
export const DEFAULT_MENU: MenuChoice[] = ['newChat', 'briefing', 'type', 'history', 'switchAi']
export const RING_ACTIONS: RingAction[] = ['same', 'repeat', 'history', 'briefing', 'type', 'lists']
export const TALK_STARTS: TalkStart[] = ['tapOrHold', 'holdOnly']

/** What the Translator can translate into. '' lets EDITH choose from what it hears. */
export const TRANSLATE_TARGETS = ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ru', 'el', 'tr', 'pl', 'id', 'zh', 'ja', 'ko', 'ar']

export const MAX_INSTRUCTIONS = 500
export const MAX_QUICK = 5
export const MAX_QUICK_LENGTH = 120
export const MAX_CUSTOM = 3
export const MAX_CUSTOM_NAME = 24
export const MAX_CALENDARS = 3
export const MAX_ACTIONS = 10
export const MAX_ROUTINES = 3
export const MAX_ROUTINE_STEPS = 4

/** A specialist the wearer wrote: what it's called and what it should do. */
export interface CustomSpecialist {
  name: string
  instructions: string
}

/** A calendar's private iCal address. */
export interface CalendarLink {
  name: string
  url: string
}

/** Home Assistant: the address it answers on, and a long-lived access token. */
export interface HomeSettings {
  url: string
  token: string
}

/** One of the wearer's own actions: a webhook with a name to say. */
export interface ActionLink {
  name: string
  url: string
  method: 'POST' | 'GET'
}

export type RoutineStep = { say: string; action?: undefined } | { action: string; say?: undefined }

/** A routine: one name, then things to ask EDITH or actions to run, in order. */
export interface Routine {
  name: string
  steps: RoutineStep[]
}

export interface Prefs {
  theme: Theme
  style: AnswerStyle
  pace: Pace
  /** Show the words on the glasses while the wearer is still speaking. */
  liveWords: boolean
  instructions: string
  specialist: SpecialistChoice
  translateTo: string
  /** The built-in items in the glasses menu, or null for the default ones. */
  menu: MenuChoice[] | null
  /** Questions to ask from the glasses menu. */
  quick: string[]
  /** Send where the phone is, so answers can use it. */
  location: boolean
  /** Show the time, weather and next event on the glasses home screen. */
  dashboard: boolean
  /** Keep listening for a moment after an answer. */
  followUp: boolean
  /** Start listening as soon as EDITH is opened from the glasses menu. */
  openListening: boolean
  /** What a touch on the ring does; 'same' leaves it behaving like the temple. */
  ring: RingAction
  /** Whether a tap starts listening, or only a hold does. */
  talk: TalkStart
  /** Dim the glasses, for meetings, cinemas and dark rooms. */
  discreet: boolean
  /** Guess whole words from the keys while typing on the glasses. English only, so it can be turned off (1.7.4). */
  guessing: boolean
  /** What the other person speaks for subtitles, or "" to let the voice AI work it out (1.8.0). */
  roomLanguage: string
  custom: CustomSpecialist[]
  calendars: CalendarLink[]
  home: HomeSettings
  actions: ActionLink[]
  routines: Routine[]
}

export const DEFAULT_PREFS: Prefs = {
  theme: 'edith',
  style: 'normal',
  pace: 'instant',
  liveWords: true,
  instructions: '',
  specialist: 'general',
  translateTo: '',
  menu: null,
  quick: [],
  location: true,
  dashboard: true,
  followUp: true,
  openListening: true,
  ring: 'same',
  talk: 'tapOrHold',
  discreet: false,
  guessing: true,
  roomLanguage: '',
  custom: [],
  calendars: [],
  home: { url: '', token: '' },
  actions: [],
  routines: [],
}

const oneOf = <T extends string>(list: readonly T[], value: unknown, fallback: T): T =>
  list.includes(value as T) ? (value as T) : fallback

const plain = (value: unknown, max: number): string => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

/**
 * An address the app will keep. The scheme may be left off - the examples in the fields no
 * longer show it, because a package may only carry addresses its manifest allows - and
 * EDITH's server, which is what actually calls these, fills it in (1.7.4).
 */
const httpsUrl = (value: unknown, max = 500): string => {
  const url = String(value ?? '').trim().slice(0, max)
  return /^(https:\/\/)?[^\s/]+\.[^\s]+$/i.test(url) ? url : ''
}

/** Which specialist is on: a built-in one, or custom:0 to custom:2 when it's one they wrote. */
export function cleanSpecialist(value: unknown, custom: CustomSpecialist[] = []): SpecialistChoice {
  const raw = String(value ?? '')
  const made = raw.match(/^custom:([0-2])$/)
  if (made) return custom[Number(made[1])] ? raw : 'general'
  return oneOf(SPECIALISTS, raw, 'general')
}

/** The specialist a choice points at, or null for a built-in one. */
export const customSpecialist = (prefs: Prefs): CustomSpecialist | null => {
  const made = String(prefs.specialist).match(/^custom:([0-2])$/)
  return made ? prefs.custom[Number(made[1])] ?? null : null
}

export function cleanQuick(list: unknown): string[] {
  return (Array.isArray(list) ? list : [])
    .map((q) => plain(q, MAX_QUICK_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_QUICK)
}

export const cleanCustom = (list: unknown): CustomSpecialist[] =>
  (Array.isArray(list) ? list : [])
    .map((c) => ({ name: plain((c as CustomSpecialist)?.name, MAX_CUSTOM_NAME), instructions: plain((c as CustomSpecialist)?.instructions, MAX_INSTRUCTIONS) }))
    .filter((c) => c.name && c.instructions)
    .slice(0, MAX_CUSTOM)

export const cleanCalendars = (list: unknown): CalendarLink[] =>
  (Array.isArray(list) ? list : [])
    .map((c) => ({ name: plain((c as CalendarLink)?.name, 24), url: httpsUrl((c as CalendarLink)?.url) }))
    .filter((c) => c.url)
    .slice(0, MAX_CALENDARS)

export const cleanActions = (list: unknown): ActionLink[] =>
  (Array.isArray(list) ? list : [])
    .map((a) => ({
      name: plain((a as ActionLink)?.name, 40),
      url: httpsUrl((a as ActionLink)?.url),
      method: String((a as ActionLink)?.method).toUpperCase() === 'GET' ? ('GET' as const) : ('POST' as const),
    }))
    .filter((a) => a.name && a.url)
    .slice(0, MAX_ACTIONS)

export const cleanRoutines = (list: unknown): Routine[] =>
  (Array.isArray(list) ? list : [])
    .map((r) => ({
      name: plain((r as Routine)?.name, 24),
      steps: (Array.isArray((r as Routine)?.steps) ? (r as Routine).steps : [])
        .map((s) => (s?.action ? { action: plain(s.action, 40) } : { say: plain(s?.say, 120) }))
        .filter((s) => s.action || s.say)
        .slice(0, MAX_ROUTINE_STEPS) as RoutineStep[],
    }))
    .filter((r) => r.name && r.steps.length)
    .slice(0, MAX_ROUTINES)

const cleanHome = (raw: unknown): HomeSettings => ({
  url: String((raw as HomeSettings)?.url ?? '').trim().slice(0, 300),
  token: String((raw as HomeSettings)?.token ?? '').trim().slice(0, 2000),
})

/** Preferences from storage or an account, with anything missing or unknown set to its default. */
export function cleanPrefs(raw: Partial<Record<keyof Prefs, unknown>> | null | undefined): Prefs {
  const p = raw ?? {}
  const custom = cleanCustom(p.custom)
  return {
    theme: oneOf(THEMES, p.theme, DEFAULT_PREFS.theme),
    style: oneOf(STYLES, p.style, DEFAULT_PREFS.style),
    pace: oneOf(PACES, p.pace, DEFAULT_PREFS.pace),
    liveWords: p.liveWords !== false,
    instructions: typeof p.instructions === 'string' ? p.instructions.slice(0, MAX_INSTRUCTIONS) : '',
    specialist: cleanSpecialist(p.specialist, custom),
    translateTo: TRANSLATE_TARGETS.includes(p.translateTo as string) ? (p.translateTo as string) : '',
    menu: Array.isArray(p.menu) ? [...new Set(p.menu.filter((id): id is MenuChoice => MENU_CHOICES.includes(id)))] : null,
    quick: cleanQuick(p.quick),
    location: p.location !== false,
    dashboard: p.dashboard !== false,
    followUp: p.followUp !== false,
    openListening: p.openListening !== false,
    ring: oneOf(RING_ACTIONS, p.ring, DEFAULT_PREFS.ring),
    talk: oneOf(TALK_STARTS, p.talk, DEFAULT_PREFS.talk),
    discreet: p.discreet === true,
    guessing: p.guessing !== false,
    roomLanguage: TRANSLATE_TARGETS.includes(p.roomLanguage as string) ? (p.roomLanguage as string) : '',
    custom,
    calendars: cleanCalendars(p.calendars),
    home: cleanHome(p.home),
    actions: cleanActions(p.actions),
    routines: cleanRoutines(p.routines),
  }
}
