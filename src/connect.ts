// Where the browser lands after connecting OpenRouter (see server/lib/connect.mjs): says
// whether it worked, in the phone's language. The phone picks up the key by itself.
// Served from EDITH's server only; it isn't part of the .ehpk.

import './phone.css'
import './signin.css'
import { guessLanguage, isLang, isRtl, getLanguage, setLanguage, t, type Key } from './i18n'

const params = new URLSearchParams(location.search)
const wanted = params.get('lang') || ''
setLanguage(isLang(wanted) ? wanted : guessLanguage())
document.documentElement.lang = getLanguage()
document.documentElement.dir = isRtl() ? 'rtl' : 'ltr'
document.title = t('connect.pageTitle')

const status = params.get('status')
const message: Key = status === 'ok' ? 'connect.pageDone' : status === 'expired' ? 'connect.pageExpired' : 'connect.pageFailed'

const root = document.querySelector<HTMLElement>('#connect')!
root.innerHTML = /* html */ `
  <main class="shell">
    <header class="top">
      <div class="brand">
        <div class="wordmark">EDITH</div>
        <div class="tagline"></div>
      </div>
    </header>
    <section class="signin-card">
      <h1></h1>
      <p class="signin-status"></p>
    </section>
    <p class="help signin-foot"><a href="/privacy"></a></p>
  </main>
`
root.querySelector('.tagline')!.textContent = t('app.tagline')
root.querySelector('h1')!.textContent = t('connect.pageTitle')
const text = root.querySelector<HTMLElement>('.signin-status')!
text.textContent = t(message)
text.dataset.tone = status === 'ok' ? 'ok' : 'error'
root.querySelector('a')!.textContent = t('signin.privacy')
