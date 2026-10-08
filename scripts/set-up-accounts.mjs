// Turns on customer accounts for EDITH: sign in with Google or an email and password, so AI
// keys, settings, memories and chat follow a customer to any phone.
//
//   1. Signs this PC in to Firebase (with your Google account) and picks or makes a project.
//   2. Makes the Firebase web app and reads its public settings.
//   3. Walks you through the clicks Firebase needs.
//   4. Uploads to Cloudflare: FIREBASE_WEB_CONFIG, ACCOUNT_PROVIDERS, ACCOUNT_SECRET (made
//      here once and never shown), and FIREBASE_SERVICE_ACCOUNT from the key file you
//      download, so "Delete account" also removes the Firebase user.
//   5. Deploys EDITH and checks that accounts are on.
//
//   npm run set-up-accounts
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { ROOT, fail, isSetUp, putSecrets, serverStatus, useAccount, whoami, wrangler } from './cloudflare.mjs'
import { edithUrl } from './env.mjs'

const FIREBASE_TOOLS = 'firebase-tools@15'
// A fresh prompt per question, so the terminal is free while the Firebase CLI uses it.
async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}
const pause = (what) => ask(`\n${what}\nPress Enter when done. `)
const yes = async (question, fallback) => {
  const answer = (await ask(`${question} ${fallback ? '(Y/n)' : '(y/N)'} `)).toLowerCase()
  return answer ? answer.startsWith('y') : fallback
}

/** Runs the Firebase CLI. With `interactive`, it talks to this terminal; otherwise its JSON result comes back. */
function firebase(args, { interactive = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn('npx', ['--yes', FIREBASE_TOOLS, ...args], {
      cwd: ROOT,
      shell: true,
      stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout?.on('data', (d) => (out += d))
    child.stderr?.on('data', (d) => (out += d))
    child.on('exit', (code) => {
      let json = null
      try {
        json = JSON.parse(out.slice(out.indexOf('{')))
      } catch {
        json = null
      }
      resolve({ code: code ?? 1, json, out })
    })
  })
}

function run(command) {
  return new Promise((resolve) => spawn(command, { cwd: ROOT, stdio: 'inherit', shell: true }).on('exit', (code) => resolve(code ?? 1)))
}

// ── Cloudflare first, so nothing is half done if it isn't ready
if (!isSetUp()) fail('Put your D1 database id in wrangler.jsonc and run `npm run deploy` first (see the README).')
const server = edithUrl()
if (!server) fail('Set EDITH_URL in .env.local to your EDITH server first.')
const host = new URL(server).host
const me = await whoami()
if (!me) fail('This PC is not signed in to Cloudflare. Run `npx wrangler login`, click Allow, then run this again.')
if (me.accounts?.length) useAccount(me.accounts[0].id)
console.log(`\nEDITH server: ${server}`)
console.log('This sets up customer sign-in with Firebase (free). It takes about 10 minutes, mostly clicking in your browser.')

// ── 1. Firebase sign-in and project
console.log('\n1. Signing this PC in to Firebase...')
let projects = await firebase(['projects:list', '--json'])
if (projects.json?.status !== 'success') {
  console.log('A browser window will open: sign in with the Google account that should own EDITH\'s sign-in, and allow access.')
  if ((await firebase(['login'], { interactive: true })).code !== 0) fail('Firebase sign-in did not finish. Run this again.')
  projects = await firebase(['projects:list', '--json'])
  if (projects.json?.status !== 'success') fail(`Couldn't list your Firebase projects:\n${projects.out.slice(-800)}`)
}

const list = projects.json.result || []
let projectId = ''
const existing = list.find((p) => /edith/i.test(`${p.projectId} ${p.displayName}`))
if (existing && (await yes(`Use your Firebase project "${existing.displayName || existing.projectId}" (${existing.projectId})?`, true))) {
  projectId = existing.projectId
} else {
  const id = `edith-accounts-${crypto.randomBytes(3).toString('hex')}`
  console.log(`Making a Firebase project called EDITH (${id})...`)
  const made = await firebase(['projects:create', id, '--display-name', 'EDITH', '--json'])
  if (made.json?.status === 'success') {
    projectId = id
  } else {
    console.log(`\nFirebase couldn't make the project here (often because its terms haven't been accepted yet).`)
    console.log('Open https://console.firebase.google.com, click "Create a project", name it EDITH, and finish the steps')
    console.log('(Google Analytics isn\'t needed). Then copy the project ID shown under the name.')
    projectId = await ask('Project ID: ')
  }
}
if (!/^[a-z0-9-]{4,40}$/.test(projectId)) fail("That isn't a Firebase project ID, so nothing was changed.")
console.log(`Firebase project: ${projectId}`)

// ── 2. Web app settings (public: they identify the project, they aren't passwords)
console.log('\n2. Getting the Firebase web app settings...')
const apps = await firebase(['apps:list', 'WEB', '--project', projectId, '--json'])
let appId = (apps.json?.result || [])[0]?.appId || ''
if (!appId) {
  const made = await firebase(['apps:create', 'WEB', 'EDITH', '--project', projectId, '--json'])
  appId = made.json?.result?.appId || ''
  if (!appId) fail(`Couldn't make the Firebase web app:\n${made.out.slice(-800)}`)
}
const sdk = await firebase(['apps:sdkconfig', 'WEB', appId, '--project', projectId, '--json'])
const found = sdk.json?.result?.sdkConfig || sdk.json?.result
if (!found?.apiKey || found.projectId !== projectId) fail(`Couldn't read the web app settings:\n${sdk.out.slice(-800)}`)
// Sign-in pages run on EDITH's own address, which passes /__/auth/* through to Firebase.
const webConfig = { apiKey: found.apiKey, authDomain: host, projectId, appId: found.appId, messagingSenderId: found.messagingSenderId }
console.log('Got them.')

// ── 3. The clicks Firebase needs
const console_ = `https://console.firebase.google.com/project/${projectId}`
console.log('\n3. Turn on the sign-in methods. Keep this window open and do each step in your browser.')
await pause(
  `a) Open ${console_}/authentication/providers\n` +
    '   If you see "Get started", click it.\n' +
    '   Click Google > Enable > pick your support email > Save.\n' +
    '   Click "Add new provider" > Email/Password > turn on Email/Password (leave "Email link" off) > Save.',
)
await pause(
  `b) Open ${console_}/authentication/settings\n` +
    `   Click "Authorized domains" > "Add domain" > type ${host} > Add.`,
)
await pause(
  `c) Open https://console.cloud.google.com/apis/credentials?project=${projectId}\n` +
    '   Under "OAuth 2.0 Client IDs", click "Web client (auto created by Google Service)".\n' +
    `   Under "Authorized redirect URIs", click "Add URI", paste https://${host}/__/auth/handler, then Save.\n` +
    `   Then open https://console.cloud.google.com/auth/branding?project=${projectId}\n` +
    '   and set the app name to EDITH (that is what Google shows people when they sign in). Save.',
)

const providers = ['google', 'email']

// ── 4. The service account key lets "Delete account" remove the Firebase user as well
let serviceAccount = ''
console.log(
  `\n4. So that "Delete account" removes people from Firebase too, EDITH needs a Firebase key.\n` +
    `   Open ${console_}/settings/serviceaccounts/adminsdk and click "Generate new private key" > "Generate key".\n` +
    '   A .json file downloads. Nothing from it is shown here.',
)
if (await yes('Did you download it?', true)) {
  const downloads = path.join(os.homedir(), 'Downloads')
  const newest = existsSync(downloads)
    ? readdirSync(downloads)
        .filter((f) => f.startsWith(`${projectId}-firebase-adminsdk`) && f.endsWith('.json'))
        .map((f) => path.join(downloads, f))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
    : undefined
  let file = newest && (await yes(`Use ${newest}?`, true)) ? newest : ''
  if (!file) file = (await ask('Path to the downloaded .json file: ')).replace(/^"|"$/g, '')
  try {
    const key = JSON.parse(readFileSync(file, 'utf8'))
    if (key.project_id !== projectId || !key.private_key || !key.client_email) throw new Error('not this project\'s key')
    serviceAccount = JSON.stringify({ project_id: key.project_id, client_email: key.client_email, private_key: key.private_key })
    if (await yes('Delete the downloaded file now that EDITH has it? (Recommended)', true)) rmSync(file)
  } catch (err) {
    console.log(`That file didn't work (${err.message}). Accounts will still work; run this again later to add the key.`)
  }
}

// ── 5. Upload to Cloudflare, deploy, check
console.log('\n5. Saving the settings on Cloudflare...')
const listed = await wrangler(['secret', 'list', '--format', 'json'])
let names = []
try {
  names = JSON.parse(listed.stdout.slice(listed.stdout.indexOf('['))).map((s) => s.name)
} catch {
  names = []
}
const secrets = { FIREBASE_WEB_CONFIG: JSON.stringify(webConfig), ACCOUNT_PROVIDERS: providers.join(',') }
// The profile encryption key is made once. Replacing it would make every saved key unreadable.
if (!names.includes('ACCOUNT_SECRET')) secrets.ACCOUNT_SECRET = crypto.randomBytes(32).toString('base64url')
if (serviceAccount) secrets.FIREBASE_SERVICE_ACCOUNT = serviceAccount
await putSecrets(secrets)
console.log(`Saved: ${Object.keys(secrets).join(', ')}.`)

console.log('\nDeploying EDITH (this builds the sign-in page too)...')
if ((await run('npm run deploy')) !== 0) fail('The deploy failed (see above). Fix that, then run `npm run deploy`.')

let on = false
for (let i = 0; i < 20 && !on; i++) {
  on = Boolean((await serverStatus(server))?.accounts)
  if (!on) await new Promise((r) => setTimeout(r, 3000))
}
if (!on) fail(`EDITH didn't report accounts as on yet. Check ${server}/api/status in a minute.`)
console.log(`\nAccounts are on (${providers.join(', ')}).`)
console.log(`Check the sign-in page: open ${server}/signin in your browser. It should ask for a code.`)
console.log('In EDITH 1.4.0 or later, customers tap Settings > Account > Sign in.')
