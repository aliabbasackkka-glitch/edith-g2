// Reads a setting the way Vite does: the process environment wins, then .env files.
import { existsSync, readFileSync } from 'node:fs'

export function readEnv(name) {
  if (process.env[name]) return process.env[name].trim()
  for (const file of ['.env.production.local', '.env.local', '.env.production', '.env']) {
    if (!existsSync(file)) continue
    const match = readFileSync(file, 'utf8').match(new RegExp(`^\\s*${name}\\s*=\\s*["']?([^"'\\s#]*)`, 'm'))
    if (match?.[1]) return match[1].trim()
  }
  return ''
}

/** EDITH_URL as a bare https origin, or '' if unset or still the placeholder. */
export function edithUrl() {
  const url = readEnv('EDITH_URL').replace(/\/+$/, '')
  return /^https?:\/\/[^/\s]+$/.test(url) && !/your-edith-site|your-subdomain/.test(url) ? url : ''
}
