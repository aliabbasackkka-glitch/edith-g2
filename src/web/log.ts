// The ACTIVITY LOG: JARVIS's log box with the desktop app's typewriter. Lines are typed out
// one after another; an answer that is still streaming stays "open" and keeps typing as its
// words arrive. Everything goes in as text (a Text node), never as HTML.

export type LogKind = 'sys' | 'you' | 'edith' | 'err'

export interface LogLine {
  /** Replaces the line's text (e.g. a voice question once its words are known). */
  set(text: string): void
  /** Adds to the end of an open line. */
  append(text: string): void
  /** No more text is coming: the typewriter moves on to the next line. */
  close(): void
  /** Takes the line out of the log. */
  remove(): void
}

interface Line {
  el: HTMLDivElement
  node: Text
  target: string
  shown: number
  open: boolean
  gone: boolean
}

export class ActivityLog {
  /** Lines still being typed, oldest first. */
  private queue: Line[] = []
  private frame = 0
  private readonly calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

  constructor(private readonly box: HTMLElement) {}

  /** Adds a line. `open` lines keep typing what append() adds until close(). */
  add(text: string, kind: LogKind, { instant = false, open = false } = {}): LogLine {
    const el = document.createElement('div')
    el.className = kind
    const node = document.createTextNode('')
    el.append(node)
    const line: Line = { el, node, target: text, shown: 0, open, gone: false }
    const stick = this.atBottom()
    this.box.append(el)
    if (instant || this.calm) {
      line.shown = text.length
      node.data = text
      if (open) this.queue.push(line)
    } else {
      this.queue.push(line)
      this.kick()
    }
    if (stick) this.box.scrollTop = this.box.scrollHeight
    return {
      set: (next) => {
        if (line.gone) return
        let same = 0
        while (same < Math.min(line.shown, next.length) && next[same] === line.target[same]) same++
        line.target = next
        if (line.shown > same) {
          line.shown = same
          line.node.data = next.slice(0, same)
        }
        if (this.calm || !this.queue.includes(line)) this.flushLine(line)
        else this.kick()
      },
      append: (more) => {
        if (line.gone || !more) return
        line.target += more
        if (this.calm || !this.queue.includes(line)) this.flushLine(line)
        else this.kick()
      },
      close: () => {
        line.open = false
        if (this.calm) this.flushLine(line)
        this.kick()
      },
      remove: () => {
        line.gone = true
        line.el.remove()
        this.queue = this.queue.filter((l) => l !== line)
        this.kick()
      },
    }
  }

  clear(): void {
    for (const line of this.queue) line.gone = true
    this.queue = []
    this.box.replaceChildren()
  }

  /** Shows a line's whole text at once (lines already typed, or reduced motion). */
  private flushLine(line: Line): void {
    const stick = this.atBottom()
    line.shown = line.target.length
    line.node.data = line.target
    if (!line.open) this.queue = this.queue.filter((l) => l !== line)
    if (stick) this.box.scrollTop = this.box.scrollHeight
  }

  private kick(): void {
    if (!this.frame && this.queue.length) this.frame = requestAnimationFrame(() => this.type())
  }

  /** One frame of typing: about the desktop app's 6 ms a character, faster when behind. */
  private type(): void {
    this.frame = 0
    const line = this.queue[0]
    if (!line) return
    const stick = this.atBottom()
    const behind = line.target.length - line.shown
    if (behind > 0) {
      line.shown += Math.min(behind, Math.max(3, Math.ceil(behind / 24)))
      line.node.data = line.target.slice(0, line.shown)
      if (stick) this.box.scrollTop = this.box.scrollHeight
    }
    if (line.shown >= line.target.length) {
      if (line.open) return // waits for more words; append() starts it again
      this.queue.shift()
    }
    this.kick()
  }

  /** Whether the reader is at the end of the log (so new lines keep it scrolled there). */
  private atBottom(): boolean {
    return this.box.scrollHeight - this.box.scrollTop - this.box.clientHeight < 24
  }
}
