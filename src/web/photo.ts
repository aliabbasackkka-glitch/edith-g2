// A photo picked or taken in the browser, made small enough to send with a question:
// at most 1024 px on its longest side, as JPEG, well under the server's limit.

import type { AskImage } from '../api'

const MAX_SIDE = 1024
/** The server refuses more than 1,800,000 base64 characters; stay clear of it. */
const MAX_BASE64 = 1_700_000

export class PhotoError extends Error {}

export async function shrinkPhoto(file: File): Promise<AskImage> {
  if (file.type && !file.type.startsWith('image/')) throw new PhotoError("That file isn't a photo.")
  const image = await decode(file)
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height))
    const width = Math.max(1, Math.round(image.width * scale))
    const height = Math.max(1, Math.round(image.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new PhotoError("This browser can't prepare photos.")
    // Transparent PNGs get a black background rather than JPEG's default.
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(image.source, 0, 0, width, height)
    for (const quality of [0.85, 0.7, 0.55, 0.4]) {
      const data = canvas.toDataURL('image/jpeg', quality).split(',')[1] || ''
      if (data && data.length <= MAX_BASE64) return { mime: 'image/jpeg', data }
    }
    throw new PhotoError('That photo is too big to send. Try another one.')
  } finally {
    image.close()
  }
}

interface Decoded {
  source: CanvasImageSource
  width: number
  height: number
  close(): void
}

/** Reads the file into something a canvas can draw, the right way up. */
async function decode(file: File): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }
    } catch {
      // Fall back to an <img>, which some browsers decode more formats with.
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    await img.decode()
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) }
  } catch {
    URL.revokeObjectURL(url)
    throw new PhotoError("That photo couldn't be opened here. Try a JPEG or PNG.")
  }
}
