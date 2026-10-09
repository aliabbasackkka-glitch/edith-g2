// The HUD in the middle of the page: EDITH's core, a sphere of glowing nodes joined by threads of
// light (the same core as the PC app). It turns slowly on its own; drag it to spin it, hover to
// stir it, tap or click it to send a wave through it. It is gold, greener while listening, amber
// while thinking and red when muted or offline, and it bounces when EDITH talks: a spring carries
// the microphone's level, every piece of answer that arrives and every word read aloud.

export type HudState = 'initialising' | 'online' | 'setup' | 'listening' | 'thinking' | 'answering' | 'speaking' | 'muted' | 'offline'

type Rgb = readonly [number, number, number]

const PRI: Rgb = [245, 197, 66] // --pri  #f5c542
const BRIGHT: Rgb = [254, 249, 145] // --pri-bright #fef991
const GREEN: Rgb = [61, 255, 154] // --green #3dff9a
const MUTED: Rgb = [255, 51, 102] // --muted-c #ff3366
const ACC: Rgb = [255, 140, 26] // --acc #ff8c1a

const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a)).toFixed(3)})`
const hex = ([r, g, b]: Rgb) => `rgb(${r},${g},${b})`
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

/** The core is drawn in a 600 x 600 space and scaled to the canvas. */
const SIZE = 600
const CX = 300
const CY = 300
const RADIUS = 168
const N_SHELL = 230
const N_CORE = 50

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
}

/** A small seeded random, so the sphere is the same shape on every visit. */
function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class Hud {
  private readonly ctx: CanvasRenderingContext2D
  private readonly wctx: CanvasRenderingContext2D
  private state: HudState = 'initialising'
  private micLevel = 0
  private speech: (() => number) | null = null
  private level = 0
  private scale = 1
  private scaleV = 0
  private energy = 0
  private yaw = 0.6
  private pitch = -0.22
  private vyaw = 0.18
  private vpitch = 0
  private t = 0
  private wt = 0
  private last = 0
  private px = 1
  private drag: { x: number; y: number; moved: boolean; id: number } | null = null
  private mouse: { x: number; y: number } | null = null
  private pings: number[] = []
  private particles: Particle[] = []
  private readonly dirs: Array<[number, number, number]> = []
  private readonly rad: number[] = []
  private readonly phase: number[] = []
  private readonly size: number[] = []
  private edges: Array<[number, number]> = []
  private chords: Array<[number, number]> = []
  private readonly sprite: HTMLCanvasElement
  private readonly calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

  constructor(
    private readonly radar: HTMLCanvasElement,
    wave: HTMLCanvasElement,
  ) {
    this.ctx = radar.getContext('2d')!
    this.wctx = wave.getContext('2d')!
    this.build()
    this.sprite = this.glowSprite()
    const fit = () => this.fit()
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fit).observe(radar)
    window.addEventListener('resize', fit)
    this.fit()
    this.listen()
    requestAnimationFrame((t) => this.draw(t))
  }

  setState(state: HudState): void {
    this.state = state
    if (state !== 'listening') this.micLevel = 0
  }

  /** The microphone's level while listening, 0..1. */
  setLevel(level: number): void {
    this.micLevel = level
  }

  /** Where to read the voice's loudness while EDITH speaks, or null for the stand-in flutter. */
  setSpeechSource(source: (() => number) | null): void {
    this.speech = source
  }

  /** A nudge: the core swells and bounces back. Bigger for longer words or pieces of answer. */
  kick(strength = 0.6): void {
    const s = Math.max(0, Math.min(1.5, strength))
    this.scaleV += 0.9 * s
    this.energy = Math.min(1, this.energy + 0.25 * s)
  }

  // ── geometry ──
  private build(): void {
    const rnd = seeded(55)
    const uni = (a: number, b: number) => a + (b - a) * rnd()
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd())
    const golden = Math.PI * (3 - Math.sqrt(5))
    // An even spread over the sphere, then roughened so it reads hand-made.
    for (let i = 0; i < N_SHELL; i++) {
      let y = 1 - (2 * (i + 0.5)) / N_SHELL
      const r = Math.sqrt(Math.max(0, 1 - y * y))
      let x = Math.cos(golden * i) * r
      let z = Math.sin(golden * i) * r
      x += uni(-0.07, 0.07)
      y += uni(-0.07, 0.07)
      z += uni(-0.07, 0.07)
      const l = Math.hypot(x, y, z) || 1
      this.dirs.push([x / l, y / l, z / l])
      this.rad.push(uni(0.9, 1.05))
    }
    // A looser cloud inside, for depth.
    for (let i = 0; i < N_CORE; i++) {
      const x = gauss()
      const y = gauss()
      const z = gauss()
      const l = Math.hypot(x, y, z) || 1
      this.dirs.push([x / l, y / l, z / l])
      this.rad.push(uni(0.32, 0.8))
    }
    for (let i = 0; i < this.dirs.length; i++) {
      this.phase.push(uni(0, Math.PI * 2))
      this.size.push(uni(0.7, 1.35))
    }
    const base = this.dirs.map(([x, y, z], i) => [x * this.rad[i], y * this.rad[i], z * this.rad[i]])
    const d2 = (a: number, b: number) => (base[a][0] - base[b][0]) ** 2 + (base[a][1] - base[b][1]) ** 2 + (base[a][2] - base[b][2]) ** 2
    const seen = new Set<string>()
    const add = (a: number, b: number, list: Array<[number, number]>) => {
      const key = a < b ? `${a}-${b}` : `${b}-${a}`
      if (seen.has(key)) return
      seen.add(key)
      list.push(a < b ? [a, b] : [b, a])
    }
    const nearest = (i: number, pool: number, k: number) =>
      Array.from({ length: pool }, (_, j) => j)
        .filter((j) => j !== i)
        .map((j) => [d2(i, j), j] as const)
        .sort((a, b) => a[0] - b[0])
        .slice(0, k)
    for (let i = 0; i < N_SHELL; i++) for (const [dd, j] of nearest(i, N_SHELL, 4)) if (dd < 0.17) add(i, j, this.edges)
    for (let i = N_SHELL; i < this.dirs.length; i++) for (const [, j] of nearest(i, this.dirs.length, 3)) add(i, j, this.edges)
    // A few long threads across the middle, like a constellation map.
    while (this.chords.length < 16) {
      const a = Math.floor(rnd() * N_SHELL)
      const b = Math.floor(rnd() * N_SHELL)
      if (a !== b && d2(a, b) > 1.6) add(a, b, this.chords)
    }
  }

  private glowSprite(): HTMLCanvasElement {
    const c = document.createElement('canvas')
    c.width = c.height = 64
    const g = c.getContext('2d')!
    const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32)
    rg.addColorStop(0, 'rgba(255,250,210,1)')
    rg.addColorStop(0.18, 'rgba(254,236,140,0.82)')
    rg.addColorStop(0.45, 'rgba(245,197,66,0.27)')
    rg.addColorStop(1, 'rgba(245,197,66,0)')
    g.fillStyle = rg
    g.fillRect(0, 0, 64, 64)
    return c
  }

  // ── input: drag to spin, hover to stir, tap to ping ──
  private toSpace(event: PointerEvent): { x: number; y: number } {
    const box = this.radar.getBoundingClientRect()
    return { x: ((event.clientX - box.left) / (box.width || 1)) * SIZE, y: ((event.clientY - box.top) / (box.height || 1)) * SIZE }
  }

  private listen(): void {
    const c = this.radar
    c.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      const p = this.toSpace(event)
      this.drag = { ...p, moved: false, id: event.pointerId }
      try {
        c.setPointerCapture(event.pointerId)
      } catch {
        // capture is a nicety
      }
      c.classList.add('grabbing')
    })
    c.addEventListener('pointermove', (event) => {
      const p = this.toSpace(event)
      if (event.pointerType === 'mouse') this.mouse = p
      if (!this.drag || this.drag.id !== event.pointerId) return
      const dx = p.x - this.drag.x
      const dy = p.y - this.drag.y
      if (Math.abs(dx) + Math.abs(dy) > 4) this.drag.moved = true
      this.vyaw = dx * 0.35
      this.vpitch = dy * 0.35
      this.yaw += dx * 0.008
      this.pitch = Math.max(-1.2, Math.min(1.2, this.pitch + dy * 0.008))
      this.drag.x = p.x
      this.drag.y = p.y
    })
    const end = (event: PointerEvent) => {
      if (!this.drag || this.drag.id !== event.pointerId) return
      if (!this.drag.moved && event.type === 'pointerup') {
        const p = this.toSpace(event)
        if (Math.hypot(p.x - CX, p.y - CY) < RADIUS * 1.25) {
          this.pings.push(0)
          this.kick(0.9)
        }
      }
      this.drag = null
      c.classList.remove('grabbing')
    }
    c.addEventListener('pointerup', end)
    c.addEventListener('pointercancel', end)
    c.addEventListener('pointerleave', () => {
      this.mouse = null
    })
  }

  /** Sharp on high-density screens: the canvas gets up to twice the 600-pixel space. */
  private fit(): void {
    const css = this.radar.getBoundingClientRect().width || SIZE
    const k = Math.max(1, Math.min(2, ((window.devicePixelRatio || 1) * css) / SIZE))
    const px = Math.round(SIZE * k)
    if (px !== this.radar.width) {
      this.radar.width = px
      this.radar.height = px
    }
    this.px = px / SIZE
  }

  private draw(now: number): void {
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 1 / 60
    this.last = now
    this.step(dt)
    this.drawCore()
    this.drawWave(dt * 60)
    requestAnimationFrame((t) => this.draw(t))
  }

  // ── motion ──
  private step(dt: number): void {
    const s = this.state
    const red = s === 'muted' || s === 'offline'
    this.t += dt
    // How loud things are: the microphone while listening; while speaking the browser gives no
    // sound level, so a syllable-like flutter stands in (each word also kicks the spring).
    let target = 0
    if (s === 'listening') target = this.micLevel
    else if (s === 'speaking')
      target = this.speech
        ? Math.min(1, this.speech() * 1.4)
        : 0.35 + 0.3 * Math.abs(Math.sin(this.t * 21)) * Math.abs(Math.sin(this.t * 6.7 + 1.3))
    this.level += (target - this.level) * (target > this.level ? 0.45 : 0.12)
    this.energy *= Math.pow(0.94, dt * 60)
    // The bounce: an under-damped spring pulled towards a size set by how loud it is.
    const rest = red ? 0.9 : 1 + 0.2 * this.level + 0.018 * Math.sin(this.t * 1.7)
    this.scaleV += (170 * (rest - this.scale) - 7.5 * this.scaleV) * dt
    this.scale = Math.max(0.7, Math.min(1.45, this.scale + this.scaleV * dt))
    const spin = this.calm ? 0.05 : red ? 0.08 : { thinking: 1.05, answering: 0.5, speaking: 0.45, listening: 0.3 }[s as string] ?? 0.2
    if (!this.drag) {
      this.vyaw += (spin - this.vyaw) * Math.min(1, dt * 1.8)
      this.vpitch *= 1 - Math.min(1, dt * 3)
      this.yaw += this.vyaw * dt
      this.pitch += (-0.22 - this.pitch) * Math.min(1, dt * 0.8) + this.vpitch * dt * 0.2
    }
    this.pings = this.pings.map((a) => a + dt).filter((a) => a < 1.6)
    if (!this.calm && (s === 'speaking' || s === 'answering' || s === 'listening') && Math.random() < 0.12 + 0.5 * this.level) {
      const a = Math.random() * Math.PI * 2
      const r0 = RADIUS * this.scale
      const v = (30 + Math.random() * 60) * (0.6 + this.level)
      this.particles.push({ x: CX + Math.cos(a) * r0, y: CY + Math.sin(a) * r0, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1 })
    }
    const drag = Math.pow(0.985, dt * 60)
    this.particles = this.particles
      .filter((p) => p.life > 0)
      .slice(-160)
      .map((p) => ({ x: p.x + p.vx * dt, y: p.y + p.vy * dt, vx: p.vx * drag, vy: p.vy * drag, life: p.life - dt * 1.4 }))
  }

  private colours(): { line: Rgb; node: Rgb } {
    const s = this.state
    if (s === 'muted' || s === 'offline') return { line: MUTED, node: [255, 136, 153] }
    if (s === 'listening') return { line: mix(PRI, GREEN, 0.45), node: mix(BRIGHT, GREEN, 0.35) }
    if (s === 'thinking') return { line: mix(PRI, ACC, 0.45), node: BRIGHT }
    return { line: PRI, node: BRIGHT }
  }

  // ── drawing ──
  private drawCore(): void {
    const ctx = this.ctx
    const { line, node } = this.colours()
    const lvl = this.level
    const R = RADIUS * this.scale
    ctx.setTransform(this.px, 0, 0, this.px, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.clearRect(0, 0, SIZE, SIZE)

    // Halo behind the core, brighter when it talks.
    const halo = ctx.createRadialGradient(CX, CY, 0, CX, CY, R * 1.75)
    halo.addColorStop(0, rgba(line, (46 + 90 * lvl + 60 * this.energy) / 255))
    halo.addColorStop(0.45, rgba(line, (18 + 30 * lvl) / 255))
    halo.addColorStop(1, rgba(line, 0))
    ctx.fillStyle = halo
    ctx.beginPath()
    ctx.arc(CX, CY, R * 1.75, 0, Math.PI * 2)
    ctx.fill()

    // A faint crosshair, and an orbit ring, tilted, turning the other way.
    ctx.strokeStyle = rgba(PRI, 0.1)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(10, CY)
    ctx.lineTo(CX - R * 1.25, CY)
    ctx.moveTo(CX + R * 1.25, CY)
    ctx.lineTo(590, CY)
    ctx.stroke()
    ctx.save()
    ctx.translate(CX, CY)
    ctx.rotate((-18 * Math.PI) / 180)
    ctx.setLineDash([6, 5])
    ctx.lineDashOffset = -this.t * 14
    ctx.strokeStyle = rgba(PRI, (70 + 80 * lvl) / 255)
    ctx.lineWidth = 1.2
    ctx.beginPath()
    ctx.ellipse(0, 0, R * 1.42, R * 0.42, 0, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.restore()

    // Project every node: turn it, ripple it, push it from the cursor.
    const cy = Math.cos(this.yaw)
    const sy = Math.sin(this.yaw)
    const cp = Math.cos(this.pitch)
    const sp = Math.sin(this.pitch)
    const t = this.t
    const amp = 0.012 + 0.075 * lvl + 0.05 * this.energy + (this.state === 'thinking' ? 0.02 : 0)
    const scan = this.state === 'thinking' ? Math.sin(t * 1.6) : null
    const m = this.drag ? null : this.mouse
    const n = this.dirs.length
    const X = new Float32Array(n)
    const Y = new Float32Array(n)
    const D = new Float32Array(n)
    const G = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const [dx, dy, dz] = this.dirs[i]
      let r = this.rad[i] * (1 + amp * (Math.sin(dx * 5 + t * 3.1 + this.phase[i]) * 0.6 + Math.sin(dy * 6 - t * 4.3) * 0.4))
      for (const age of this.pings) {
        // a tap sends a wave from the top of the sphere to the bottom
        const front = age * 2.2 - (1 - dy)
        if (front > 0 && front < 0.6) r += 0.14 * (1 - age / 1.6) * Math.sin((front / 0.6) * Math.PI)
      }
      let x = dx * r
      let y = dy * r
      let z = dz * r
      const x1 = x * cy + z * sy
      z = -x * sy + z * cy
      x = x1
      const y1 = y * cp - z * sp
      z = y * sp + z * cp
      y = y1
      const persp = 2.8 / (2.8 - z)
      let px = CX + x * R * persp
      let py = CY - y * R * persp
      let glow = 0
      if (m) {
        const dd = Math.hypot(px - m.x, py - m.y)
        if (dd < 80) {
          const f = 1 - dd / 80
          glow = f
          px += (px - m.x) * 0.25 * f
          py += (py - m.y) * 0.25 * f
        }
      }
      if (scan !== null) glow = Math.max(glow, Math.max(0, 1 - Math.abs(dy - scan) * 4) * 0.8)
      X[i] = px
      Y[i] = py
      D[i] = Math.max(0, Math.min(1, (z / 1.05 + 1) / 2))
      G[i] = glow
    }

    ctx.globalCompositeOperation = 'lighter'
    // Threads, bucketed by brightness so each bucket is one stroke.
    const buckets: Array<Array<[number, number]>> = [[], [], [], [], [], []]
    for (const [a, b] of this.edges) {
      const v = (D[a] + D[b]) / 2 + Math.max(G[a], G[b]) * 0.6
      buckets[Math.min(5, Math.floor(v * 5.99))].push([a, b])
    }
    const boost = 0.75 + 0.5 * lvl + 0.4 * this.energy
    buckets.forEach((pairs, k) => {
      if (!pairs.length) return
      ctx.strokeStyle = rgba(line, ((18 + 30 * k) * boost) / 255)
      ctx.lineWidth = 0.8 + 0.18 * k
      ctx.beginPath()
      for (const [a, b] of pairs) {
        ctx.moveTo(X[a], Y[a])
        ctx.lineTo(X[b], Y[b])
      }
      ctx.stroke()
    })
    ctx.strokeStyle = rgba(line, (22 + 40 * lvl) / 255)
    ctx.lineWidth = 0.7
    ctx.beginPath()
    for (const [a, b] of this.chords) {
      ctx.moveTo(X[a], Y[a])
      ctx.lineTo(X[b], Y[b])
    }
    ctx.stroke()

    // Nodes: a glow each, bigger and brighter at the front.
    for (let i = 0; i < n; i++) {
      const tw = 0.75 + 0.25 * Math.sin(t * 2.3 + this.phase[i] * 3)
      const s = (3 + 7 * D[i]) * this.size[i] * (1 + 0.6 * G[i] + 0.35 * lvl)
      ctx.globalAlpha = Math.max(0.05, Math.min(1, (0.18 + 0.82 * D[i]) * tw + G[i] * 0.6))
      ctx.drawImage(this.sprite, X[i] - s, Y[i] - s, s * 2, s * 2)
    }
    ctx.globalAlpha = 1

    // The heart: a soft light in the middle that beats with the voice.
    const core = ctx.createRadialGradient(CX, CY, 0, CX, CY, R * 0.55)
    core.addColorStop(0, rgba(node, (60 + 150 * lvl + 80 * this.energy) / 255))
    core.addColorStop(1, rgba(line, 0))
    ctx.fillStyle = core
    ctx.beginPath()
    ctx.arc(CX, CY, R * 0.55, 0, Math.PI * 2)
    ctx.fill()

    for (const p of this.particles) {
      ctx.fillStyle = rgba(node, p.life * 0.86)
      ctx.beginPath()
      ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2)
      ctx.fill()
    }
    for (const age of this.pings) {
      ctx.strokeStyle = rgba(node, 0.78 * (1 - age / 1.6))
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(CX, CY, R * (1 + age * 0.9), 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.globalCompositeOperation = 'source-over'
  }

  private drawWave(k: number): void {
    const w = this.wctx
    const s = this.state
    w.clearRect(0, 0, 400, 56)
    const amp =
      s === 'listening' ? 4 + Math.min(1, this.micLevel * 1.6) * 20 : s === 'speaking' || s === 'answering' ? 8 + 16 * Math.max(this.level, this.energy) : 3
    w.strokeStyle =
      s === 'speaking' || s === 'listening'
        ? hex(GREEN)
        : s === 'thinking'
          ? hex(ACC)
          : s === 'muted' || s === 'offline'
            ? hex(MUTED)
            : hex(PRI)
    w.lineWidth = 1.5
    w.beginPath()
    for (let x = 0; x < 400; x++) {
      const y = 28 + Math.sin(x * 0.07 + this.wt) * amp * 0.5 + Math.sin(x * 0.19 + this.wt * 1.3) * amp * 0.4
      if (x === 0) w.moveTo(x, y)
      else w.lineTo(x, y)
    }
    w.stroke()
    this.wt += (this.calm ? 0.04 : 0.18) * k
  }
}
