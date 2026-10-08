// The languages EDITH's screens come in, and lookups for the phone (t) and the
// glasses (tg). The glasses font has no Arabic letters, so Arabic glasses text is
// written in English letters (arLatin) while the phone shows Arabic script.

import { ar, arLatin } from './ar'
import { de } from './de'
import { en, type GlassesKey, type Key, type Strings } from './en'
import { es } from './es'
import { fr } from './fr'
import { it } from './it'
import { ja } from './ja'
import { ko } from './ko'
import { zh } from './zh'

export type Lang = 'en' | 'de' | 'fr' | 'es' | 'it' | 'zh' | 'ja' | 'ko' | 'ar'
export type { GlassesKey, Key }

/** In the order the language picker lists them, each in its own words. */
export const LANGUAGES: Array<{ code: Lang; name: string }> = [
  { code: 'en', name: 'English' },
  { code: 'de', name: 'Deutsch' },
  { code: 'fr', name: 'Français' },
  { code: 'es', name: 'Español' },
  { code: 'it', name: 'Italiano' },
  { code: 'zh', name: '中文' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'ar', name: 'العربية' },
]

const PHONE: Record<Lang, Strings> = {
  en,
  de,
  fr,
  es,
  it,
  zh,
  ja,
  ko,
  ar: { ...ar, ...arLatin },
}

let current: Lang = 'en'

export const isLang = (code: string): code is Lang => typeof code === 'string' && Object.prototype.hasOwnProperty.call(PHONE, code)

export function setLanguage(code: string): Lang {
  current = isLang(code) ? code : 'en'
  return current
}

export const getLanguage = (): Lang => current

export const languageName = (code: string): string => LANGUAGES.find((l) => l.code === code)?.name ?? code

/** The phone's own language, if EDITH has it; otherwise English. */
export function guessLanguage(): Lang {
  const wanted = typeof navigator === 'undefined' ? [] : [...(navigator.languages ?? []), navigator.language]
  for (const tag of wanted) {
    const code = String(tag || '').toLowerCase().slice(0, 2)
    if (isLang(code)) return code
  }
  return 'en'
}

export const isRtl = (): boolean => current === 'ar'

function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match))
}

/** Phone text in the current language. */
export function t(key: Key, vars: Record<string, string | number> = {}): string {
  return fill(PHONE[current][key] ?? en[key], vars)
}

/** Glasses text in the current language (Arabic in English letters). */
export function tg(key: GlassesKey, vars: Record<string, string | number> = {}): string {
  const text = current === 'ar' ? arLatin[key] : PHONE[current][key]
  return fill(text ?? en[key], vars)
}

/** The locale for times on the glasses: Arabic digits don't draw there. */
export const glassesLocale = (): string => (current === 'ar' ? 'en-GB' : current)
