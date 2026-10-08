// Sets the key EDITH uses to watch for harmful use (1.8.0):
//   MODERATION_PROVIDER  which AI judges the questions
//   MODERATION_KEY       its key (you paste it, typing hidden; never printed)
//   MODERATION_MODEL     the model to judge with
//
// A key of its own on purpose. Moderation never spends a customer's key, so a busy
// moderation key can't take chat down with it - and nobody's own quota is spent
// judging them.
//
//   npm run set-moderation-key            set it up
//   npm run set-moderation-key -- --off   turn it off again
import { fail, isSetUp, putSecrets, serverStatus, useAccount, whoami } from './cloudflare.mjs'
import { edithUrl } from './env.mjs'
import { createInterface } from 'node:readline/promises'

import { askHidden } from './prompt.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

// Cheap, fast models that do this well. Groq's Llama Guard is made for exactly this job.
const CHOICES = [
  { id: 'groq', label: 'Groq', model: 'meta-llama/llama-guard-4-12b', url: 'console.groq.com/keys', check: 'https://api.groq.com/openai/v1/models', prefix: /^gsk_[\w-]{20,}$/ },
  { id: 'groq', label: 'Groq (a normal model, if Llama Guard is unavailable)', model: 'llama-3.3-70b-versatile', url: 'console.groq.com/keys', check: 'https://api.groq.com/openai/v1/models', prefix: /^gsk_[\w-]{20,}$/ },
  { id: 'gemini', label: 'Gemini', model: 'gemini-2.5-flash-lite', url: 'aistudio.google.com/apikey', check: '', prefix: /^(AQ\.|AIza)[\w.-]{20,}$/ },
  { id: 'openai', label: 'ChatGPT', model: 'gpt-4.1-mini', url: 'platform.openai.com/api-keys', check: 'https://api.openai.com/v1/models', prefix: /^sk-[\w-]{20,}$/ },
]

if (!isSetUp()) fail('Put your D1 database id in wrangler.jsonc and run `npm run deploy` first (see the README).')
const server = edithUrl()
if (!server) fail('Set EDITH_URL in .env.local to your EDITH server first.')
const me = await whoami()
if (!me) fail('This PC is not signed in to Cloudflare. Run `npx wrangler login`, click Allow, then run this again.')
if (me.accounts?.length) useAccount(me.accounts[0].id)
console.log(`\nEDITH server: ${server}`)

if (process.argv.includes('--off')) {
  await putSecrets({ MODERATION_PROVIDER: null, MODERATION_KEY: null, MODERATION_MODEL: null, MODERATION_BASE: null })
  console.log('\nModeration is off. Nothing is judged and nothing new is recorded.')
  console.log('Bans already given stay until you lift them (see "Moderation" in the README).\n')
  process.exit(0)
}

console.log(`
EDITH will check what people ask and ban a phone that asks for
things like weapons, malware or sexual content involving children.

It never flags someone in distress, and it never uses their key to judge them:
that is what this separate key is for.
`)
CHOICES.forEach((c, i) => console.log(`  ${i + 1}. ${c.label} - ${c.model}`))
const picked = CHOICES[Number((await ask('\nWhich AI should judge? [1] ')) || '1') - 1]
if (!picked) fail('That was not one of the choices, so nothing was changed.')

let key = ''
for (let attempt = 1; attempt <= 3 && !key; attempt++) {
  const pasted = (await askHidden(`\nPaste a ${picked.label} key from ${picked.url} (typing is hidden), then press Enter:\n> `)) || ''
  if (!pasted) fail('No key given, so nothing was changed.')
  if (!picked.prefix.test(pasted)) {
    console.log(`That doesn't look like a ${picked.label} key. Try again.`)
    continue
  }
  if (picked.check) {
    const res = await fetch(picked.check, { headers: { Authorization: `Bearer ${pasted}` } }).catch(() => null)
    if (!res) fail(`Couldn't reach ${picked.label} to check the key. Check your internet and run this again.`)
    if (res.status === 401 || res.status === 403) {
      console.log(`${picked.label} rejected that key. Copy it again from ${picked.url}.`)
      continue
    }
    if (!res.ok) fail(`${picked.label} answered ${res.status} while checking the key. Try again in a minute.`)
    console.log(`${picked.label} key works.`)
  }
  key = pasted
}
if (!key) fail('No working key, so nothing was changed.')

await putSecrets({ MODERATION_PROVIDER: picked.id, MODERATION_KEY: key, MODERATION_MODEL: picked.model })
key = ''
console.log('\nSaved on the Cloudflare Worker. Checking...')

let status = null
for (let i = 0; i < 20; i++) {
  status = await serverStatus(server)
  if (status?.moderation) break
  await sleep(2000)
}
if (!status?.moderation) fail(`Saved, but the server doesn't report it yet. Wait a minute and check ${server}/api/status.`)

console.log(`
Done. EDITH is watching, on ${picked.label} (${picked.model}).

  - Serious rules ban a phone straight away; lighter ones warn, and the third bans.
  - Whoever is banned is told why. To lift a ban, see "Moderation" in the README.
`)
