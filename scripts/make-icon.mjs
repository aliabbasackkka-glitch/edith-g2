// Draws EDITH's Even Hub store icon: store/icon.png, 24x24.
// Rules from the developer portal: 1-bit (#F4F4F4 on transparent) and every lit
// pixel inside a 2x2 block, so the art is designed on a 12x12 grid and doubled.
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

// A bold "E", filling the frame edge to edge.
const GRID = [
  '############',
  '############',
  '###.........',
  '###.........',
  '###.........',
  '#########...',
  '#########...',
  '###.........',
  '###.........',
  '###.........',
  '############',
  '############',
]

const SIZE = 24
const LIT = [0xf4, 0xf4, 0xf4, 0xff]

const rows = []
for (let y = 0; y < SIZE; y++) {
  const row = [0] // PNG filter type: none
  for (let x = 0; x < SIZE; x++) {
    const on = GRID[y >> 1][x >> 1] === '#'
    row.push(...(on ? LIT : [0, 0, 0, 0]))
  }
  rows.push(...row)
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

const header = Buffer.alloc(13)
header.writeUInt32BE(SIZE, 0)
header.writeUInt32BE(SIZE, 4)
header[8] = 8 // bit depth
header[9] = 6 // RGBA

mkdirSync('store', { recursive: true })
writeFileSync(
  'store/icon.png',
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]),
)

// Self-check against the portal's 2x2 rule.
const lit = (x, y) => x >= 0 && y >= 0 && x < SIZE && y < SIZE && GRID[y >> 1][x >> 1] === '#'
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (!lit(x, y)) continue
    const inBlock = [[0, 0], [-1, 0], [0, -1], [-1, -1]].some(
      ([dx, dy]) => lit(x + dx, y + dy) && lit(x + dx + 1, y + dy) && lit(x + dx, y + dy + 1) && lit(x + dx + 1, y + dy + 1),
    )
    if (!inBlock) throw new Error(`pixel ${x},${y} is not part of a 2x2 block`)
  }
}
console.log('store/icon.png written (24x24, 1-bit, 2x2 blocks OK)')

// A 16x enlarged copy with a grid, to redraw it by hand in the portal's pixel editor:
// thin lines between pixels, brighter lines around each 2x2 block.
const SCALE = 16
const BIG = SIZE * SCALE
const preview = []
for (let y = 0; y < BIG; y++) {
  preview.push(0)
  for (let x = 0; x < BIG; x++) {
    const on = lit(Math.floor(x / SCALE), Math.floor(y / SCALE))
    const blockLine = x % (SCALE * 2) === 0 || y % (SCALE * 2) === 0
    const pixelLine = x % SCALE === 0 || y % SCALE === 0
    let v = on ? 0xf4 : 0x16
    if (blockLine) v = on ? 0x9a : 0x5a
    else if (pixelLine) v = on ? 0xc8 : 0x2c
    preview.push(v, v, v, 0xff)
  }
}
const previewHeader = Buffer.from(header)
previewHeader.writeUInt32BE(BIG, 0)
previewHeader.writeUInt32BE(BIG, 4)
writeFileSync(
  'store/icon-preview.png',
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', previewHeader),
    chunk('IDAT', deflateSync(Buffer.from(preview))),
    chunk('IEND', Buffer.alloc(0)),
  ]),
)
console.log('store/icon-preview.png written (384x384 drawing guide)')
