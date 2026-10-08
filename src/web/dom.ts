// Small DOM helpers. Text always goes in as text (textContent), never as HTML.

export function $<T extends HTMLElement = HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector)
  if (!el) throw new Error(`EDITH: missing ${selector}`)
  return el
}

/** A status line under a control: plain, ok (green) or error (red). Empty hides it. */
export function setStatus(el: HTMLElement, text: string, tone: '' | 'ok' | 'error' = ''): void {
  el.textContent = text
  if (tone) el.dataset.tone = tone
  else delete el.dataset.tone
}

/** Whether a key press is meant for a text field rather than for EDITH's shortcuts. */
export function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true
  if (target instanceof HTMLInputElement) return !['checkbox', 'radio', 'button', 'submit', 'range', 'file'].includes(target.type)
  return false
}
