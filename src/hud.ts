// The heads-up display on the glasses: a title, a status line and a body panel.
//
//   ◆ EDITH  10:42              ● ONLINE  ■■■□ 76%
//  ╭──────────────────────────────────────╮
//  │ » what's the weather in dubai        │
//  │                                      │
//  │ 38°C and sunny, high of 41°C.        │
//  ╰──────────────────────────────────────╯
//
// Every write crosses BLE (~80 ms each), so updates are coalesced, skipped when
// nothing changed, and strictly serialised - the host can't take them in parallel.
//
// EDITH 1.7.0 adds a second layout: the body panel shrinks and a list takes the rest of
// the display, for things to pick from, lists to tick off and the keys to type with. The
// glasses scroll and highlight the list themselves and report what is chosen, so only a
// change of items costs a rebuild. Discreet mode dims every panel, which is a page
// property and so also a rebuild.
//
// The page also declares EDITH's items for the glasses contextual menu (tap then
// long press). The menu is part of the page, so every rebuild carries it again.

import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'

export type Slot = 'title' | 'status' | 'body'
export type HudContent = Record<Slot, string>

export interface MenuItem {
  id: number // non-zero, unique
  name: string // at most 32 UTF-8 bytes
}

interface Box {
  id: number
  name: string
  x: number
  y: number
  width: number
  height: number
  border: number
  padding: number
  brightness: number // textColor, 0-4
  capture: 0 | 1
}

const SLOTS: Slot[] = ['title', 'status', 'body']

// The title and status sit in their own framed panels, like the readout in EDITH's own
// interface; the firmware draws the borders, so they stay square whatever the text does.
const BOXES: Record<Slot, Box> = {
  title: { id: 1, name: 'title', x: 8, y: 0, width: 272, height: 44, border: 1, padding: 8, brightness: 3, capture: 0 },
  status: { id: 2, name: 'status', x: 296, y: 0, width: 272, height: 44, border: 1, padding: 8, brightness: 4, capture: 0 },
  // The body captures input: taps and presses arrive, and long answers
  // scroll natively with a swipe.
  body: { id: 3, name: 'body', x: 0, y: 46, width: 576, height: 242, border: 1, padding: 14, brightness: 4, capture: 1 },
}

// With a list on screen the body keeps the top two lines and the list takes the rest. The
// list captures input instead of the body: the glasses allow exactly one of each page.
const LIST_BOX = { id: 4, name: 'list', x: 0, y: 132, width: 576, height: 156, border: 1, padding: 10 }
const BODY_WITH_LIST_HEIGHT = 84

/** Panels are dimmer in discreet mode, for meetings, cinemas and dark rooms. */
const DIM: Record<Slot, number> = { title: 0, status: 0, body: 1 }

/**
 * Rough capacity of the body panel, for deciding when to hint that it scrolls.
 * Measured in the simulator: ~9.4 px per character, 28 px per line.
 */
export const BODY_CHARS_PER_LINE = 52
export const BODY_LINES = 7
/** What fits above a list. */
export const LIST_BODY_LINES = 2

const PAGE_TEXT_LIMIT = 1000 // createStartUpPageContainer / rebuildPageContainer
const UPGRADE_TEXT_LIMIT = 2000 // textContainerUpgrade
const COALESCE_MS = 60
/** Item names the glasses will draw; longer ones are cut. */
const LIST_ITEM_CHARS = 48
const LIST_MAX_ITEMS = 40

export class Hud {
  private readonly wanted: HudContent
  private shown: HudContent = { title: '', status: '', body: '' }
  private queue: Promise<unknown> = Promise.resolve()
  private flushQueued = false
  private startupSpent = false
  private list: string[] | null = null
  private itemWidth = 0
  private dim = false

  constructor(
    private readonly bridge: EvenAppBridge,
    initial: HudContent,
    private menu: MenuItem[] = [],
  ) {
    this.wanted = { ...initial }
  }

  /**
   * Replaces the contextual menu's items. The menu is part of the page, so a change
   * rebuilds it (which also closes an open menu on the glasses); no change does nothing.
   */
  setMenu(items: MenuItem[]): void {
    const same = items.length === this.menu.length && items.every((item, i) => item.id === this.menu[i].id && item.name === this.menu[i].name)
    if (same) return
    this.menu = items
    if (this.startupSpent) void this.rebuild()
  }

  /**
   * Shows a list under the body panel, or takes it away with null. `itemWidth` is how wide
   * one item is drawn: the full panel for things to pick from, narrower for keys.
   * Returns false when the glasses wouldn't draw it, so EDITH can fall back to plain text.
   */
  setList(items: string[] | null, { itemWidth = 0 } = {}): Promise<boolean> {
    const next = items ? items.slice(0, LIST_MAX_ITEMS).map((item) => item.slice(0, LIST_ITEM_CHARS) || ' ') : null
    const same =
      this.itemWidth === itemWidth &&
      (next === null
        ? this.list === null
        : this.list !== null && this.list.length === next.length && this.list.every((item, i) => item === next[i]))
    if (same) return Promise.resolve(true)
    this.list = next
    this.itemWidth = itemWidth
    return this.rebuild()
  }

  hasList(): boolean {
    return this.list !== null
  }

  /** Dims every panel (discreet mode), or brings them back. */
  setDim(dim: boolean): Promise<boolean> {
    if (dim === this.dim) return Promise.resolve(true)
    this.dim = dim
    return this.startupSpent ? this.rebuild() : Promise.resolve(true)
  }

  /**
   * Draw the page for the first time. createStartUpPageContainer is one-shot
   * per session - even a failed call spends it - so a failure falls back to
   * rebuildPageContainer, the only route left.
   */
  start(): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.startupSpent) return this.rebuildNow()
      this.startupSpent = true
      const result = await this.bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer({ containerTotalNum: this.containerCount(), textObject: this.page(), ...this.listObject(), menuObject: this.menuObject() }),
      )
      if (result !== StartUpPageCreateResult.success) {
        console.error(`[hud] createStartUpPageContainer returned ${result}; trying a rebuild`)
        return this.rebuildNow()
      }
      this.markPageBuilt()
      return true
    })
  }

  /** Redraw the whole page, e.g. after the host cleared it. */
  rebuild(): Promise<boolean> {
    return this.enqueue(() => this.rebuildNow())
  }

  set(update: Partial<HudContent>): void {
    for (const slot of SLOTS) {
      const text = update[slot]
      if (text !== undefined) this.wanted[slot] = text || ' '
    }
    this.scheduleFlush()
  }

  private containerCount(): number {
    return SLOTS.length + (this.list ? 1 : 0)
  }

  private page(): TextContainerProperty[] {
    return SLOTS.map((slot) => {
      const box = BOXES[slot]
      const withList = this.list !== null
      return new TextContainerProperty({
        xPosition: box.x,
        yPosition: box.y,
        width: box.width,
        height: withList && slot === 'body' ? BODY_WITH_LIST_HEIGHT : box.height,
        borderWidth: box.border,
        borderColor: 6,
        borderRadius: 8,
        paddingLength: box.padding,
        containerID: box.id,
        containerName: box.name,
        // The glasses allow one container per page to take input: the list when there is one.
        isEventCapture: withList ? 0 : box.capture,
        textColor: this.dim ? DIM[slot] : box.brightness,
        content: this.wanted[slot].slice(0, PAGE_TEXT_LIMIT),
      })
    })
  }

  private listObject(): { listObject?: ListContainerProperty[] } {
    if (!this.list) return {}
    return {
      listObject: [
        new ListContainerProperty({
          xPosition: LIST_BOX.x,
          yPosition: LIST_BOX.y,
          width: LIST_BOX.width,
          height: LIST_BOX.height,
          borderWidth: LIST_BOX.border,
          borderColor: 6,
          borderRadius: 8,
          paddingLength: LIST_BOX.padding,
          containerID: LIST_BOX.id,
          containerName: LIST_BOX.name,
          isEventCapture: 1,
          itemContainer: new ListItemContainerProperty({
            itemCount: this.list.length,
            itemWidth: this.itemWidth || LIST_BOX.width - LIST_BOX.padding * 2,
            isItemSelectBorderEn: 1,
            itemName: this.list,
          }),
        }),
      ],
    }
  }

  private menuObject(): MenuContainerProperty | undefined {
    if (!this.menu.length) return undefined
    return new MenuContainerProperty({
      menuItems: this.menu.map((item) => new MenuItemProperty({ itemID: item.id, itemName: item.name })),
    })
  }

  private async rebuildNow(): Promise<boolean> {
    const ok = await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({ containerTotalNum: this.containerCount(), textObject: this.page(), ...this.listObject(), menuObject: this.menuObject() }),
    )
    if (!ok) {
      console.error('[hud] rebuildPageContainer failed')
      return false
    }
    this.markPageBuilt()
    return true
  }

  private markPageBuilt(): void {
    for (const slot of SLOTS) this.shown[slot] = this.wanted[slot].slice(0, PAGE_TEXT_LIMIT)
    // Text past the page limit, or set() calls made while the page was
    // building, are completed with in-place updates.
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushQueued || !this.startupSpent) return
    this.flushQueued = true
    void this.enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, COALESCE_MS))
      this.flushQueued = false
      for (const slot of SLOTS) {
        const text = this.wanted[slot].slice(0, UPGRADE_TEXT_LIMIT)
        if (text === this.shown[slot]) continue
        const box = BOXES[slot]
        const ok = await this.bridge.textContainerUpgrade(
          new TextContainerUpgrade({ containerID: box.id, containerName: box.name, content: text }),
        )
        if (ok) this.shown[slot] = text
        else console.warn(`[hud] textContainerUpgrade(${slot}) failed`)
      }
    })
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.catch((err) => console.error('[hud]', err))
    return run
  }
}
