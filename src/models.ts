// Model lists for the pickers: the provider's popular models (from EDITH's server,
// shown before a key is checked) merged with the models a checked key can use.

import type { ModelInfo } from './api'

/**
 * The id to use for `wanted` among `models`, or null if the key can't use it. An alias
 * such as "claude-haiku-4-5" matches its dated snapshot "claude-haiku-4-5-20251001".
 */
export function matchModel(wanted: string, models: ModelInfo[]): string | null {
  if (!wanted) return null
  if (models.some((m) => m.id === wanted)) return wanted
  return models.some((m) => m.id.startsWith(`${wanted}-`)) ? wanted : null
}

/**
 * Popular models first (with their friendly names), then every other model the key
 * offers. Before a key is checked (`live` is null) only the popular models are listed.
 */
export function modelChoices(popular: ModelInfo[], live: ModelInfo[] | null): { popular: ModelInfo[]; others: ModelInfo[] } {
  if (!live) return { popular, others: [] }
  const covered = new Set<string>()
  const available = popular.filter((p) => {
    const hits = live.filter((m) => m.id === p.id || m.id.startsWith(`${p.id}-`))
    hits.forEach((m) => covered.add(m.id))
    return hits.length > 0
  })
  return { popular: available, others: live.filter((m) => !covered.has(m.id)) }
}

/** Fills a <select> with model choices, grouped (under the given group names) when there are both kinds. */
export function fillModelSelect(
  select: HTMLSelectElement,
  choices: { popular: ModelInfo[]; others: ModelInfo[] },
  selected: string,
  groups: { popular: string; all: string } = { popular: 'Popular', all: 'All models' },
): void {
  const option = (m: ModelInfo) => {
    const el = document.createElement('option')
    el.value = m.id
    el.textContent = m.name && m.name !== m.id ? m.name : m.id
    return el
  }
  const group = (label: string, models: ModelInfo[]) => {
    const el = document.createElement('optgroup')
    el.label = label
    el.append(...models.map(option))
    return el
  }
  const { popular, others } = choices
  if (popular.length && others.length) select.replaceChildren(group(groups.popular, popular), group(groups.all, others))
  else select.replaceChildren(...[...popular, ...others].map(option))
  if (selected && ![...select.options].some((o) => o.value === selected)) {
    select.prepend(option({ id: selected, name: selected }))
  }
  if (selected) select.value = selected
}
