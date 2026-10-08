// The wearer's lists (EDITH 1.7.0): shopping, packing, things to do. One record per
// person, so the AI can change a list while answering and the glasses can tick it off.
//
//   lists/<person>   [{ name, items, done, updated }], newest first
//
// `done` holds the positions already ticked, so ticking on the glasses never has to
// rewrite the items themselves. A request without a device id ("anon") keeps no lists: a list
// it changes is shown once and not saved.

import { isAnon, readJSON, removeKey, writeJSON } from "./storage.mjs";

export const MAX_LISTS = 12;
export const MAX_ITEMS = 40;
const NAME_MAX = 40;
const ITEM_MAX = 80;

const text = (raw, max) => String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export const cleanName = (raw) => text(raw, NAME_MAX);

export function cleanList(raw) {
  const items = (Array.isArray(raw?.items) ? raw.items : []).map((item) => text(item, ITEM_MAX)).filter(Boolean).slice(0, MAX_ITEMS);
  const done = [...new Set((Array.isArray(raw?.done) ? raw.done : []).map(Number))]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < items.length)
    .sort((a, b) => a - b);
  return { name: cleanName(raw?.name), items, done, updated: Number(raw?.updated) || Date.now() };
}

export async function getLists(uk) {
  if (isAnon(uk)) return [];
  const saved = await readJSON(`lists/${uk}`, []);
  return (Array.isArray(saved) ? saved : []).map(cleanList).filter((list) => list.name);
}

export const findList = (lists, name) => {
  const wanted = cleanName(name).toLowerCase();
  return lists.find((list) => list.name.toLowerCase() === wanted) ?? null;
};

/** Saves a list under its name. An empty list is deleted instead. */
export async function saveList(uk, raw) {
  const list = { ...cleanList(raw), updated: Date.now() };
  if (!list.name) return null;
  if (isAnon(uk)) return list;
  const rest = (await getLists(uk)).filter((other) => other.name.toLowerCase() !== list.name.toLowerCase());
  await writeJSON(`lists/${uk}`, list.items.length ? [list, ...rest].slice(0, MAX_LISTS) : rest);
  return list;
}

export const clearLists = async (uk) => (isAnon(uk) ? undefined : removeKey(`lists/${uk}`));

/**
 * Applies what the AI asked for to a list: replacing it, adding, removing, ticking or
 * unticking. Items are matched by what they say, so "milk" ticks off "2l milk".
 */
export function changeList(list, { items, add, remove, tick, untick }) {
  const next = { ...list, items: [...list.items], done: [...list.done] };
  const asList = (value) => (Array.isArray(value) ? value : typeof value === "string" && value.trim() ? [value] : []);

  if (asList(items).length) {
    next.items = asList(items).map((item) => text(item, ITEM_MAX)).filter(Boolean).slice(0, MAX_ITEMS);
    next.done = [];
  }
  for (const item of asList(add)) {
    const clean = text(item, ITEM_MAX);
    if (!clean || next.items.length >= MAX_ITEMS) continue;
    if (!next.items.some((have) => have.toLowerCase() === clean.toLowerCase())) next.items.push(clean);
  }
  for (const item of asList(remove)) {
    const at = indexOfItem(next.items, item);
    if (at < 0) continue;
    next.items.splice(at, 1);
    next.done = next.done.filter((i) => i !== at).map((i) => (i > at ? i - 1 : i));
  }
  for (const item of asList(tick)) {
    const at = indexOfItem(next.items, item);
    if (at >= 0 && !next.done.includes(at)) next.done.push(at);
  }
  for (const item of asList(untick)) {
    const at = indexOfItem(next.items, item);
    if (at >= 0) next.done = next.done.filter((i) => i !== at);
  }
  next.done = [...new Set(next.done)].sort((a, b) => a - b);
  return next;
}

/** Where an item is in a list: the same words, or the closest thing that contains them. */
function indexOfItem(items, wanted) {
  const needle = text(wanted, ITEM_MAX).toLowerCase();
  if (!needle) return -1;
  const exact = items.findIndex((item) => item.toLowerCase() === needle);
  if (exact >= 0) return exact;
  return items.findIndex((item) => item.toLowerCase().includes(needle) || needle.includes(item.toLowerCase()));
}
