// Helpers for the setup scripts: runs this project's Wrangler, finds the signed-in
// account, and uploads secrets through stdin so they never appear on screen or in a file.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WRANGLER = path.join(path.dirname(createRequire(import.meta.url).resolve('wrangler/package.json')), 'bin', 'wrangler.js')
const CONFIG = path.join(ROOT, 'wrangler.jsonc')

const childEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false' }

export function fail(message) {
  console.error(`\n${message}`)
  process.exit(1)
}

/** Runs `wrangler <args>` and captures its output. `input` is written to its stdin. */
export function wrangler(args, { input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WRANGLER, ...args], {
      cwd: ROOT,
      env: childEnv,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    if (input !== undefined) child.stdin.end(input)
    child.on('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

/** Selects the account for every later Wrangler call. */
export function useAccount(id) {
  childEnv.CLOUDFLARE_ACCOUNT_ID = id
}

/** { email, accounts: [{ id, name }] } for the signed-in user, or null. */
export async function whoami() {
  const { code, stdout } = await wrangler(['whoami', '--json'])
  if (code !== 0) return null
  try {
    const data = JSON.parse(stdout.slice(stdout.indexOf('{')))
    return data.loggedIn ? data : null
  } catch {
    return null
  }
}

/** True once wrangler.jsonc names your D1 database (see "Self-hosting" in the README). */
export function isSetUp() {
  const id = readFileSync(CONFIG, 'utf8').match(/"database_id"\s*:\s*"([^"]+)"/)?.[1] ?? ''
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

/** Creates or replaces Worker secrets in one upload. Values go through stdin only. */
export async function putSecrets(secrets) {
  const { code, stdout, stderr } = await wrangler(['secret', 'bulk'], { input: JSON.stringify(secrets) })
  if (code !== 0) fail(`Cloudflare refused the secrets:\n${stderr || stdout}`)
}

/** EDITH's /api/status, or null when it doesn't answer. */
export async function serverStatus(server) {
  return fetch(`${server}/api/status`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
}
