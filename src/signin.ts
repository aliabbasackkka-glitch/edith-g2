// The page customers open in Safari or Chrome to sign EDITH in on their phone:
// sign in with Google, or with an email and password (Firebase Authentication), then
// confirm the code EDITH is showing. The server links the account to that phone.
// This page is served from EDITH's server only; it isn't part of the .ehpk.

import './phone.css'
import './signin.css'
import { initializeApp } from 'firebase/app'
import {
  GoogleAuthProvider,
  OAuthProvider,
  createUserWithEmailAndPassword,
  getAuth,
  getRedirectResult,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type Auth,
  type User,
} from 'firebase/auth'
import { getLanguage, guessLanguage, isLang, isRtl, setLanguage, t, type Key } from './i18n'

type Step = 'code' | 'methods' | 'confirm' | 'done'
type Method = 'google' | 'microsoft' | 'email'

interface AccountConfig {
  enabled: boolean
  providers: Method[]
  firebase?: Record<string, string>
}

const TEMPLATE = /* html */ `
  <main class="shell">
    <header class="top">
      <div class="brand">
        <div class="wordmark">EDITH</div>
        <div class="tagline" data-t="app.tagline"></div>
      </div>
    </header>

    <section class="signin-card">
      <h1 data-t="signin.pageTitle"></h1>
      <p class="help" data-t="signin.intro"></p>

      <div class="signin-step" data-step="code" hidden>
        <label class="field">
          <span class="field-label" data-t="signin.enterCode"></span>
          <input class="code-input mono" dir="ltr" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="9" placeholder="ABCD-EFGH" />
        </label>
        <div class="actions"><button class="button code-go" type="button" data-t="signin.codeContinue"></button></div>
      </div>

      <div class="signin-step" data-step="methods" hidden>
        <div class="code-box">
          <span class="field-label" data-t="signin.codeLabel"></span>
          <span class="code mono" dir="ltr"></span>
          <span class="help" data-t="signin.codeHelp"></span>
        </div>
        <div class="methods">
          <button class="button method" type="button" data-method="google" data-t="signin.google"></button>
          <button class="button method" type="button" data-method="microsoft" data-t="signin.microsoft"></button>
          <button class="button quiet method" type="button" data-method="email" data-t="signin.email"></button>
        </div>
        <form class="email-form" hidden novalidate>
          <input class="email-input" type="email" dir="ltr" autocomplete="username" data-t-placeholder="signin.emailPlaceholder" />
          <input class="password-input" type="password" dir="ltr" autocomplete="current-password" data-t-placeholder="signin.passwordPlaceholder" />
          <div class="actions">
            <button class="button" type="submit" data-t="signin.signIn"></button>
            <button class="button quiet create-account" type="button" data-t="signin.createAccount"></button>
          </div>
          <button class="link-button forgot" type="button" data-t="signin.forgot"></button>
        </form>
      </div>

      <div class="signin-step" data-step="confirm" hidden>
        <p class="confirm-text" dir="auto"></p>
        <p class="help confirm-warn"></p>
        <div class="actions">
          <button class="button confirm-yes" type="button" data-t="signin.yes"></button>
          <button class="button quiet confirm-other" type="button" data-t="signin.other"></button>
        </div>
      </div>

      <p class="signin-status" aria-live="polite"></p>
    </section>

    <p class="help signin-foot"><a href="/privacy" data-t="signin.privacy"></a></p>
  </main>
`

const MIN_PASSWORD = 8
const params = new URLSearchParams(location.search)
const wantedLanguage = params.get('lang') || ''
setLanguage(isLang(wantedLanguage) ? wantedLanguage : guessLanguage())

const root = document.querySelector<HTMLElement>('#signin')!
root.innerHTML = TEMPLATE
const $ = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!

document.documentElement.lang = getLanguage()
document.documentElement.dir = isRtl() ? 'rtl' : 'ltr'
document.title = t('signin.pageTitle')
for (const el of root.querySelectorAll<HTMLElement>('[data-t]')) el.textContent = t(el.dataset.t as Key)
for (const el of root.querySelectorAll<HTMLElement>('[data-t-placeholder]')) el.setAttribute('placeholder', t(el.dataset.tPlaceholder as Key))

/** "abcd efgh" or "ABCD-EFGH" -> "ABCDEFGH". */
const cleanCode = (s: string | null) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
const showCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`

let code = cleanCode(params.get('code'))
let auth: Auth | null = null
let user: User | null = null

function show(step: Step): void {
  for (const el of root.querySelectorAll<HTMLElement>('.signin-step')) el.hidden = el.dataset.step !== step
  if (step === 'methods') $('.code').textContent = showCode(code)
}

function status(text: string, tone: 'info' | 'error' | 'ok' = 'info'): void {
  const el = $('.signin-status')
  el.textContent = text
  el.dataset.tone = tone
}

function busy(on: boolean): void {
  for (const b of root.querySelectorAll<HTMLButtonElement>('button')) b.disabled = on
  if (on) status(t('signin.working'))
}

/** This page's address with the code and language. */
const pageUrl = () => `${location.origin}${location.pathname}?code=${showCode(code)}&lang=${getLanguage()}`

function explain(err: unknown): void {
  const reason = (err as { code?: string })?.code ?? ''
  const quiet = ['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled']
  if (quiet.includes(reason)) return status('')
  const messages: Record<string, Key> = {
    'auth/account-exists-with-different-credential': 'signin.existsOther',
    'auth/invalid-email': 'signin.badEmail',
    'auth/missing-email': 'signin.enterEmail',
    'auth/missing-password': 'signin.enterPassword',
    'auth/invalid-credential': 'signin.wrongPassword',
    'auth/invalid-login-credentials': 'signin.wrongPassword',
    'auth/wrong-password': 'signin.wrongPassword',
    'auth/user-not-found': 'signin.wrongPassword',
    'auth/email-already-in-use': 'signin.emailInUse',
    'auth/weak-password': 'signin.weakPassword',
    'auth/password-does-not-meet-requirements': 'signin.weakPassword',
    'auth/too-many-requests': 'signin.tooMany',
    'auth/unauthorized-domain': 'signin.notSetUp',
    'auth/operation-not-allowed': 'signin.notSetUp',
  }
  console.warn('[signin]', reason || err)
  status(t(messages[reason] ?? 'signin.error'), 'error')
}

/** Is the code still waiting for a sign-in? Shows why not. */
async function codeIsWaiting(): Promise<boolean> {
  try {
    const res = await fetch(`/api/account/link/check?code=${encodeURIComponent(code)}`, { cache: 'no-store' })
    const data = await res.json()
    if (data.ok) return true
    status(t(data.reason === 'expired' ? 'signin.expired' : 'signin.unknownCode'), 'error')
  } catch {
    status(t('signin.error'), 'error')
  }
  return false
}

async function useCode(): Promise<void> {
  const typed = cleanCode($<HTMLInputElement>('.code-input').value)
  if (typed.length !== 8) return status(t('signin.unknownCode'), 'error')
  code = typed
  history.replaceState(null, '', pageUrl())
  status('')
  if (await codeIsWaiting()) show('methods')
}

function showConfirm(): void {
  if (!user) return
  const who = user.email || user.displayName || ''
  $('.confirm-text').textContent = t('signin.confirm', { who })
  $('.confirm-warn').textContent = t('signin.confirmWarn', { code: showCode(code) })
  status('')
  show('confirm')
}

async function signInWith(method: Method): Promise<void> {
  if (!auth) return
  if (method === 'email') {
    $('.email-form').hidden = false
    $<HTMLInputElement>('.email-input').focus()
    return status('')
  }
  const provider = method === 'google' ? new GoogleAuthProvider() : new OAuthProvider('microsoft.com')
  provider.setCustomParameters({ prompt: 'select_account' })
  busy(true)
  try {
    user = (await signInWithPopup(auth, provider)).user
    busy(false)
    showConfirm()
  } catch (err) {
    busy(false)
    const reason = (err as { code?: string })?.code ?? ''
    // In-app browsers and some privacy settings block the popup: sign in on this page instead.
    if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(reason)) {
      return signInWithRedirect(auth, provider)
    }
    explain(err)
  }
}

/** The email typed in, or null after asking for it. */
function typedEmail(): string | null {
  const email = $<HTMLInputElement>('.email-input').value.trim()
  if (email) return email
  status(t('signin.enterEmail'), 'error')
  $<HTMLInputElement>('.email-input').focus()
  return null
}

/** Signs in with an email and password, or with `create`, makes the account first. */
async function signInWithPassword(create: boolean): Promise<void> {
  if (!auth) return
  const email = typedEmail()
  if (!email) return
  const password = $<HTMLInputElement>('.password-input').value
  if (!password) {
    status(t('signin.enterPassword'), 'error')
    return $<HTMLInputElement>('.password-input').focus()
  }
  if (create && password.length < MIN_PASSWORD) return status(t('signin.weakPassword'), 'error')
  busy(true)
  try {
    const result = create
      ? await createUserWithEmailAndPassword(auth, email, password)
      : await signInWithEmailAndPassword(auth, email, password)
    user = result.user
    $<HTMLInputElement>('.password-input').value = ''
    busy(false)
    showConfirm()
  } catch (err) {
    busy(false)
    explain(err)
  }
}

async function resetPassword(): Promise<void> {
  if (!auth) return
  const email = typedEmail()
  if (!email) return
  busy(true)
  try {
    await sendPasswordResetEmail(auth, email, { url: pageUrl() })
    busy(false)
    status(t('signin.resetSent', { email }), 'ok')
  } catch (err) {
    busy(false)
    explain(err)
  }
}

async function confirm(): Promise<void> {
  if (!user || !auth) return
  busy(true)
  try {
    const idToken = await user.getIdToken()
    const res = await fetch('/api/account/link/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, idToken }),
    })
    const data = await res.json().catch(() => ({}))
    busy(false)
    if (data.ok) {
      // EDITH has its own session now; nothing stays signed in on this browser.
      await signOut(auth).catch(() => {})
      user = null
      show('done')
      return status(t('signin.done'), 'ok')
    }
    status(t(data.reason === 'expired' ? 'signin.expired' : data.reason === 'used' || data.reason === 'unknown' ? 'signin.unknownCode' : 'signin.error'), 'error')
  } catch {
    busy(false)
    status(t('signin.error'), 'error')
  }
}

async function useAnotherAccount(): Promise<void> {
  if (auth) await signOut(auth).catch(() => {})
  user = null
  status('')
  show('methods')
}

async function main(): Promise<void> {
  $('.code-go').addEventListener('click', () => void useCode())
  $('.code-input').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') void useCode()
  })
  for (const b of root.querySelectorAll<HTMLButtonElement>('.method')) {
    b.addEventListener('click', () => void signInWith(b.dataset.method as Method))
  }
  $('.email-form').addEventListener('submit', (e) => {
    e.preventDefault()
    void signInWithPassword(false)
  })
  $('.create-account').addEventListener('click', () => void signInWithPassword(true))
  $('.forgot').addEventListener('click', () => void resetPassword())
  $('.confirm-yes').addEventListener('click', () => void confirm())
  $('.confirm-other').addEventListener('click', () => void useAnotherAccount())

  let config: AccountConfig | null = null
  try {
    config = await (await fetch('/api/account/config', { cache: 'no-store' })).json()
  } catch {
    config = null
  }
  if (!config?.enabled || !config.firebase) return status(t('signin.notSetUp'), 'error')
  for (const b of root.querySelectorAll<HTMLButtonElement>('.method')) b.hidden = !config.providers.includes(b.dataset.method as Method)

  auth = getAuth(initializeApp(config.firebase))
  auth.languageCode = getLanguage() === 'zh' ? 'zh-CN' : getLanguage()

  try {
    const back = await getRedirectResult(auth)
    if (back?.user) {
      user = back.user
      if (code && (await codeIsWaiting())) return showConfirm()
    }
  } catch (err) {
    explain(err)
  }

  if (!code) return show('code')
  if (await codeIsWaiting()) show('methods')
}

void main()
