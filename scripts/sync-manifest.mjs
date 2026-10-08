// Copies EDITH_URL into app.json's network whitelist before packaging, so the
// packaged app is allowed to reach the server it was built against.
import { readFileSync, writeFileSync } from 'node:fs'
import { edithUrl } from './env.mjs'

const url = edithUrl()
if (!url) {
  console.error('Set EDITH_URL in .env.local to your EDITH server, e.g. https://edith.example.workers.dev')
  process.exit(1)
}

const manifest = JSON.parse(readFileSync('app.json', 'utf8'))
const network = manifest.permissions?.find((p) => p.name === 'network')
if (!network) {
  console.error('app.json has no "network" permission to update.')
  process.exit(1)
}
network.whitelist = [url]
writeFileSync('app.json', JSON.stringify(manifest, null, 2) + '\n')
console.log(`app.json network whitelist -> ${url}`)
