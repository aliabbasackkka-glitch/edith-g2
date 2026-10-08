import './phone.css'
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { Edith } from './edith'
import { guessLanguage, setLanguage, t } from './i18n'
import { Phone } from './phone'

// Until the saved language loads, start in the phone's own language.
setLanguage(guessLanguage())

const site = __EDITH_URL__ || location.origin
const phone = new Phone(document.querySelector<HTMLElement>('#app')!)
phone.setPrivacyUrl(`${site}/privacy.html`)
phone.setState('boot')

async function main(): Promise<void> {
  // Outside the Even app (or simulator) the bridge never arrives; say so.
  const hint = window.setTimeout(() => phone.addNote(t('note.waitingForApp')), 4000)
  const bridge = await waitForEvenAppBridge()
  window.clearTimeout(hint)
  await new Edith(bridge, phone).start()
}

main().catch((err) => {
  console.error('[edith] failed to start', err)
  phone.setState('error')
  phone.addNote(t('note.failedToStart', { error: (err as Error)?.message ?? String(err) }), 'error')
})
