// Even Hub rejects a package whose files mention a web address that app.json's network
// whitelist doesn't cover - 1.7.3 was turned down for seven, all of them examples in
// settings fields. This runs before packing so it can never happen quietly again.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'dist'

const files = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })

const manifest = JSON.parse(readFileSync('app.json', 'utf8'))
const allowed = (manifest.permissions?.find((p) => p.name === 'network')?.whitelist || []).map((url) =>
  url.replace(/\/+$/, '').toLowerCase(),
)

// The privacy page is a plain web page served from EDITH's own server; links to read are
// not calls the app makes. Everything the app itself ships has to be on the list.
const found = new Map()
for (const file of files(DIR)) {
  for (const url of readFileSync(file, 'utf8').match(/https?:\/\/[^\s"'`)\\<>]+/g) || []) {
    const origin = url.toLowerCase().match(/^https?:\/\/[^/]+/)?.[0] || url.toLowerCase()
    if (allowed.some((ok) => origin === ok || ok.startsWith(origin))) continue
    if (!found.has(url)) found.set(url, file)
  }
}

if (found.size) {
  console.error(`\n${found.size} address(es) in ${DIR} that app.json's network whitelist does not cover:\n`)
  for (const [url, file] of found) console.error(`  ${url}   (${file})`)
  // The sign-in and OpenRouter pages are served from EDITH's own server and are only built
  // by `npm run build`; `--mode package` leaves them out. Their Google addresses here mean
  // this dist is the server's, not the one being packed.
  if ([...found.values()].every((file) => /signin|connect/.test(file))) {
    console.error('\nThose are the sign-in and OpenRouter pages, which EDITH serves on the web and never packs.')
    console.error('This dist came from `npm run build`. `npm run pack` rebuilds with --mode package and checks that.\n')
  } else {
    console.error('\nAn example in a settings field must not carry "https://" - the server adds it (publicHttps).')
    console.error(`Whitelist: ${allowed.join(', ') || '(empty)'}\n`)
  }
  process.exit(1)
}

console.log(`URLs: every address in ${DIR} is covered by the network whitelist.`)
