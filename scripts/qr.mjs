// Shows the QR code that opens EDITH on your glasses. Scan it with the Even app.
//   npm run qr       your EDITH site (EDITH_URL): works anywhere, PC off
//   npm run qr:dev   this PC's dev server (npm run dev): phone on the same Wi-Fi
// Extra arguments go to `evenhub qr`, e.g. `npm run qr -- --external` for an image window.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { networkInterfaces } from 'node:os'
import { edithUrl } from './env.mjs'

const args = process.argv.slice(2)
const dev = args.includes('--dev')
const passThrough = args.filter((a) => a !== '--dev')

function lanUrl() {
  const virtual = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback|Docker|vboxnet|tailscale|ZeroTier|Bluetooth/i
  const rank = (ip) =>
    ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3
  const candidates = Object.entries(networkInterfaces())
    .filter(([name]) => !virtual.test(name))
    .flatMap(([name, addresses]) =>
      (addresses ?? [])
        .filter((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
        .map((a) => ({ name, address: a.address })),
    )
    .sort((a, b) => rank(a.address) - rank(b.address))
  const ip = process.env.EDITH_IP || candidates[0]?.address
  if (!ip) return null
  console.log(`\nDev server on ${process.env.EDITH_IP ? 'EDITH_IP' : candidates[0].name}. Keep \`npm run dev\` running.`)
  return `http://${ip}:5173`
}

const url = dev ? lanUrl() : edithUrl()
if (!url) {
  console.error(
    dev
      ? "Couldn't find this PC's Wi-Fi/LAN address. Run with EDITH_IP=192.168.x.x set."
      : 'EDITH_URL is not set in .env.local. Deploy first, or use `npm run qr:dev` for the dev server.',
  )
  process.exit(1)
}

console.log(`\nScan with the Even app to open EDITH: ${url}\n`)
// Run the CLI with this Node directly: no npx, no shell.
const cli = createRequire(import.meta.url).resolve('@evenrealities/evenhub-cli/main.js')
const child = spawn(process.execPath, [cli, 'qr', '--url', url, ...passThrough], { stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))
