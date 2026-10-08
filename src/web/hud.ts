// The HUD in the middle of the page: JARVIS's web radar and waveform (drawRadar / drawWave in
// jarvis-cloudflare/public/index.html), drawn in EDITH's gold. On top of that it reacts like the
// desktop JARVIS HUD: green while listening, a faster sweep while thinking, pulses and particles
// while answering or speaking, and red when muted or offline.

export type HudState = 'initialising' | 'online' | 'setup' | 'listening' | 'thinking' | 'answering' | 'speaking' | 'muted' | 'offline'

type Rgb = readonly [number, number, number]

const PRI: Rgb = [245, 197, 66] // --pri  #f5c542
const GREEN: Rgb = [61, 255, 154] // --green #3dff9a
const MUTED: Rgb = [255, 51, 102] // --muted-c #ff3366
const ACC: Rgb = [255, 140, 26] // --acc #ff8c1a

const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a)).toFixed(3)})`
const hex = ([r, g, b]: Rgb) => `rgb(${r},${g},${b})`

/** The radar is drawn in JARVIS's 600 x 600 space and scaled to the canvas. */
const SIZE = 600

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
}

export class Hud {
  private readonly ctx: CanvasRenderingContext2D
  private readonly wctx: CanvasRenderingContext2D
  private state: HudState = 'initialising'
  private level = 0
  private angle = 0
  private pulse = 0
  private wt = 0
  private glow = 1
  private glowTarget = 1
  private lastJitter = 0
  private pulses: number[] = []
  private particles: Particle[] = []
  private last = 0
  private scale = 1
  private readonly calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

  constructor(
    private readonly radar: HTMLCanvasElement,
    wave: HTMLCanvasElement,
  ) {
    this.ctx = radar.getContext('2d')!
    this.wctx = wave.getContext('2d')!
    const fit = () => this.fit()
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fit).observe(radar)
    window.addEventListener('resize', fit)
    this.fit()
    requestAnimationFrame((t) => this.draw(t))
  }

  setState(state: HudState): void {
    this.state = state
    if (state !== 'listening') this.level = 0
  }

  /** The microphone's level while listening, 0..1. */
  setLevel(level: number): void {
    this.level = level
  }

  /** Sharp on high-density screens: the canvas gets up to twice JARVIS's 600 pixels. */
  private fit(): void {
    const css = this.radar.getBoundingClientRect().width || SIZE
    const k = Math.max(1, Math.min(2, ((window.devicePixelRatio || 1) * css) / SIZE))
    const px = Math.round(SIZE * k)
    if (px !== this.radar.width) {
      this.radar.width = px
      this.radar.height = px
    }
    this.scale = px / SIZE
  }

  private draw(now: number): void {
    // Frame-rate independent: JARVIS's steps are per 60 Hz frame.
    const k = this.last ? Math.min(3, (now - this.last) / (1000 / 60)) : 1
    this.last = now
    this.drawRadar(k, now)
    this.drawWave(k)
    requestAnimationFrame((t) => this.draw(t))
  }

  private drawRadar(k: number, now: number): void {
    const ctx = this.ctx
    const s = this.state
    const red = s === 'muted' || s === 'offline'
    const active = s === 'answering' || s === 'speaking'
    const base = red ? MUTED : PRI
    const sweep = red ? MUTED : s === 'listening' ? GREEN : PRI

    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0)
    ctx.clearRect(0, 0, SIZE, SIZE)
    const cx = 300
    const cy = 300

    // Outer ring and its 60 ticks.
    ctx.strokeStyle = rgba(base, 0.4)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(cx, cy, 270, 0, Math.PI * 2)
    ctx.stroke()
    for (let i = 0; i < 60; i++) {
      const a = (i * Math.PI) / 30
      const r1 = 270
      const r2 = i % 5 === 0 ? 256 : 264
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1)
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2)
      ctx.stroke()
    }
    // Range rings and the crosshair.
    ctx.strokeStyle = rgba(base, 0.18)
    for (let r = 60; r <= 240; r += 45) {
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.strokeStyle = rgba(base, 0.13)
    ctx.beginPath()
    ctx.moveTo(cx, 30)
    ctx.lineTo(cx, 570)
    ctx.moveTo(30, cy)
    ctx.lineTo(570, cy)
    ctx.stroke()

    // Answering or speaking: rings pulse outwards from the core (the desktop HUD's pulses).
    if (active && !this.calm && this.pulses.length < 3 && Math.random() < 0.07 * k) this.pulses.push(80)
    this.pulses = this.pulses.map((r) => r + 4.2 * k).filter((r) => r < 270)
    ctx.lineWidth = 1.5
    for (const r of this.pulses) {
      ctx.strokeStyle = rgba(base, 0.9 * (1 - (r - 80) / 190))
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.stroke()
    }

    // The sweep.
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(this.angle)
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.arc(0, 0, 260, 0, 0.6)
    ctx.closePath()
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 260)
    g.addColorStop(0, rgba(sweep, 0.32))
    g.addColorStop(0.8, rgba(sweep, 0.05))
    g.addColorStop(1, rgba(sweep, 0))
    ctx.fillStyle = g
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(260, 0)
    ctx.strokeStyle = rgba(sweep, 0.6)
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.restore()

    // The core's glow: breathes when idle, follows the voice while listening, jumps while answering.
    if (now - this.lastJitter > (active ? 120 : 500)) {
      this.glowTarget = active ? 1.06 + Math.random() * 0.1 : red ? 0.95 : 1
      this.lastJitter = now
    }
    this.glow += (this.glowTarget - this.glow) * Math.min(1, (active ? 0.38 : 0.15) * k)
    const core = (90 + Math.sin(this.pulse) * 6) * this.glow + (s === 'listening' ? this.level * 46 : 0)
    const innerG = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, core))
    const coreColor = s === 'listening' ? GREEN : base
    innerG.addColorStop(0, rgba(coreColor, active ? 0.3 : 0.22))
    innerG.addColorStop(0.6, rgba(coreColor, 0.06))
    innerG.addColorStop(1, rgba(coreColor, 0))
    ctx.fillStyle = innerG
    ctx.beginPath()
    ctx.arc(cx, cy, Math.max(1, core), 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = rgba(base, 0.5)
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(cx, cy, 80, 0, Math.PI * 2)
    ctx.stroke()

    // Thinking: an amber arc chases round the core.
    if (s === 'thinking') {
      ctx.strokeStyle = rgba(ACC, 0.75)
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(cx, cy, 80, this.angle * 2.4, this.angle * 2.4 + 1.1)
      ctx.stroke()
    }

    // Answering or speaking: sparks fly off the core.
    if (active && !this.calm && Math.random() < 0.28 * k) {
      const a = Math.random() * Math.PI * 2
      const v = 1.4 + Math.random() * 2.2
      this.particles.push({ x: cx + Math.cos(a) * 84, y: cy + Math.sin(a) * 84, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.4, life: 1 })
    }
    const drag = Math.pow(0.97, k)
    this.particles = this.particles.filter((p) => p.life > 0)
    for (const p of this.particles) {
      p.x += p.vx * k
      p.y += p.vy * k
      p.vx *= drag
      p.vy *= drag
      p.life -= 0.028 * k
      ctx.fillStyle = rgba(base, p.life)
      ctx.beginPath()
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2)
      ctx.fill()
    }

    const speed = this.calm ? 0.006 : active ? 0.05 : s === 'thinking' ? 0.035 : 0.022
    this.angle += speed * k
    this.pulse += (s === 'thinking' ? 0.12 : 0.06) * k
  }

  private drawWave(k: number): void {
    const w = this.wctx
    const s = this.state
    w.clearRect(0, 0, 400, 56)
    const amp =
      s === 'listening' ? 4 + Math.min(1, this.level * 1.6) * 20 : s === 'speaking' || s === 'answering' ? 18 : 3
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
