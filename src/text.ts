// Text helpers for the G2 display.
//
// The firmware has one proportional LVGL font covering ASCII, Latin-1, arrows,
// box drawing, block elements and a few geometric shapes. Anything else is
// silently skipped, so an emoji or a curly quote just vanishes and leaves a
// gap. Normalise what has a close equivalent and strip the rest.

const REPLACEMENTS: Array<[RegExp, string]> = [
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐-―−]/g, '-'],
  [/…/g, '...'],
  [/[•‣⁃◦]/g, '-'],
  [/[  -​  　]/g, ' '],
]

// Emoji, dingbats, pictographs, variation selectors and joiners. The symbol
// blocks the font does support (U+2605-U+2667, box drawing, arrows) are left alone.
const UNSUPPORTED = /[\u{1F000}-\u{1FAFF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}\u{2600}-\u{2604}\u{2668}-\u{26FF}\u{FE00}-\u{FE0F}\u{200C}\u{200D}\u{E0020}-\u{E007F}]/gu

/**
 * Markdown the model might still produce, reduced to plain text. Line-start
 * patterns use [ \t] rather than \s so they never swallow the blank line above.
 */
export function stripMarkdown(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/```[a-z]*\n?([\s\S]*?)```/gi, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1$2')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^[ \t]*[*+][ \t]+/gm, '- ')
    .replace(/^[ \t]*\|?([ \t]*:?-{3,}:?[ \t]*\|)+[ \t]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// The font covers Latin, Greek, Cyrillic and CJK but no Arabic letters, which would
// silently vanish. Arabic that still reaches the glasses (a transcript, or a word in
// an answer) is spelled out in English letters instead: rough, but readable.
const ARABIC_LETTERS: Record<string, string> = {
  'ء': "'", 'آ': 'aa', 'أ': 'a', 'ؤ': 'u', 'إ': 'i', 'ئ': 'i', 'ا': 'a', 'ب': 'b', 'ة': 'a', 'ت': 't',
  'ث': 'th', 'ج': 'j', 'ح': 'h', 'خ': 'kh', 'د': 'd', 'ذ': 'dh', 'ر': 'r', 'ز': 'z', 'س': 's', 'ش': 'sh',
  'ص': 's', 'ض': 'd', 'ط': 't', 'ظ': 'z', 'ع': 'a', 'غ': 'gh', 'ف': 'f', 'ق': 'q', 'ك': 'k', 'ل': 'l',
  'م': 'm', 'ن': 'n', 'ه': 'h', 'و': 'w', 'ى': 'a', 'ي': 'y', 'پ': 'p', 'چ': 'ch', 'ڤ': 'v', 'گ': 'g',
  'ک': 'k', 'ی': 'y', '،': ',', '؛': ';', '؟': '?', 'ـ': '',
}

export function latinizeArabic(input: string): string {
  if (!/[؀-ۿ]/.test(input)) return input
  return input
    .replace(/[ً-ٰٟ]/g, '') // vowel marks
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[؀-ۿ]/g, (c) => ARABIC_LETTERS[c] ?? '')
}

/** Make arbitrary model output safe and tidy for the glasses font. */
export function forGlasses(input: string): string {
  let s = latinizeArabic(stripMarkdown(input))
  for (const [pattern, replacement] of REPLACEMENTS) s = s.replace(pattern, replacement)
  return s
    .replace(UNSUPPORTED, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Shorten to at most `max` characters, ending on a word boundary with "...". */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max - 3)
  const space = cut.lastIndexOf(' ')
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + '...'
}

// Chinese, Japanese and Korean characters are about twice as wide as Latin ones,
// and a line can break between any two of them.
export const WIDE = /[ᄀ-ᇿ⺀-꓏가-힯豈-﫿︰-﹏＀-｠￠-￦]/

/**
 * Rough line count for the body panel. The font is proportional, so this only
 * decides whether to show the "swipe for more" hint - it never cuts text.
 */
export function estimateLines(s: string, charsPerLine: number): number {
  let lines = 0
  for (const paragraph of s.split('\n')) {
    let width = 0
    let count = 1
    // Latin words stay whole; each wide character is a word of its own.
    const words = paragraph.match(new RegExp(`${WIDE.source}|[^\\s${WIDE.source.slice(1, -1)}]+|\\s+`, 'g')) ?? []
    for (const word of words) {
      if (/^\s+$/.test(word)) {
        if (width) width += 1
        continue
      }
      const w = WIDE.test(word) ? 2 : word.length
      if (width + w > charsPerLine && width > 0) {
        count++
        width = w
      } else {
        width += w
      }
    }
    lines += count
  }
  return lines
}

/**
 * The end of a text that fits in `maxLines` lines, starting on a word and marked with
 * "...", to keep the newest words in view. Text that already fits comes back whole.
 */
export function tailToFit(s: string, charsPerLine: number, maxLines: number): string {
  if (estimateLines(s, charsPerLine) <= maxLines) return s
  // Where the tail may start: on a word after a space or line break, or on a wide character.
  const starts: number[] = []
  for (let i = 1; i < s.length; i++) {
    if ((/\s/.test(s[i - 1]) && !/\s/.test(s[i])) || WIDE.test(s[i])) starts.push(i)
  }
  // Later starts give shorter tails: find the earliest one that fits.
  let best = -1
  for (let lo = 0, hi = starts.length - 1; lo <= hi; ) {
    const mid = (lo + hi) >> 1
    if (estimateLines(`...${s.slice(starts[mid])}`, charsPerLine) <= maxLines) {
      best = mid
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return best < 0 ? `...${s.slice(-charsPerLine * maxLines)}` : `...${s.slice(starts[best])}`
}

/** At most `max` UTF-8 bytes (a glasses menu item allows 32), cut between characters with "...". */
export function fitBytes(s: string, max: number): string {
  const encoder = new TextEncoder()
  if (encoder.encode(s).length <= max) return s
  let out = ''
  for (const ch of s) {
    if (encoder.encode(`${out}${ch}...`).length > max) break
    out += ch
  }
  return `${out.trimEnd()}...`
}
