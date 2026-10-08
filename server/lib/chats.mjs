// Saved chats and long-term recall, for EDITH 1.5.0 and later (which send a chat id with
// each question). Older apps send none and keep using history/<device>.
//
//   chats/<uk>/<chat>       one chat: title, specialist, and its last 100 messages
//   chatindex/<uk>          the chat list, newest first: id, title, specialist, updated, count
//   recall/<uk>/<YYYY-MM>   every question and answer that month, shortened, so EDITH can
//                           recall past conversations (kept 12 months)
//
// A request without a device id ("anon") is nobody in particular: it has no chats, and
// nothing it says is saved or recalled.

import { getHistory, isAnon, listJSON, readJSON, removeKey, writeJSON } from "./storage.mjs";

const MAX_CHATS = 50;
const MAX_MESSAGES = 100;
const RECALL_MONTHS = 12;
const RECALL_PER_MONTH = 1500;
const RECALL_TEXT = 300;
const TITLE_LENGTH = 48;

export const cleanChatId = (id) => (/^[A-Za-z0-9_-]{6,40}$/.test(String(id || "")) ? String(id) : "");
const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);
const clip = (text, n) => {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** The first words of what was asked: a chat's title until a better one is made. */
const firstWords = (text) => clip(text, TITLE_LENGTH);

function monthsBack(count, now = Date.now()) {
  const d = new Date(now);
  return Array.from({ length: count }, (_, i) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
}

const entryOf = (chat) => ({
  id: chat.id,
  title: chat.title,
  specialist: chat.specialist || "general",
  updated: chat.updated,
  count: chat.messages.length,
});

async function writeIndexEntry(uk, chat) {
  // Through listChats, so an older conversation still becomes a chat when a question comes first.
  const index = await listChats(uk);
  const next = [entryOf(chat), ...index.filter((e) => e.id !== chat.id)].sort((a, b) => b.updated - a.updated);
  // The oldest chats beyond the limit go, with everything in them.
  for (const old of next.slice(MAX_CHATS)) await removeKey(`chats/${uk}/${old.id}`);
  await writeJSON(`chatindex/${uk}`, next.slice(0, MAX_CHATS));
}

/**
 * The chat list. The first time, the conversation an older EDITH kept becomes the
 * first saved chat (a copy: older apps on other phones still see it).
 */
export async function listChats(uk) {
  if (isAnon(uk)) return [];
  const index = await readJSON(`chatindex/${uk}`, null);
  if (index) return index;
  const legacy = await getHistory(uk);
  if (!legacy.length) {
    await writeJSON(`chatindex/${uk}`, []);
    return [];
  }
  const firstQuestion = legacy.find((m) => m.role === "user")?.content || "";
  const updated = Date.parse(legacy[legacy.length - 1].at || "") || Date.now();
  const chat = {
    id: "earlier",
    title: firstWords(firstQuestion) || "Earlier chat",
    titled: false,
    specialist: "general",
    created: Date.parse(legacy[0].at || "") || updated,
    updated,
    messages: legacy.map(({ role, content, at }) => ({ role, content, at })),
  };
  await writeJSON(`chats/${uk}/${chat.id}`, chat);
  await writeJSON(`chatindex/${uk}`, [entryOf(chat)]);
  return [entryOf(chat)];
}

export const getChat = async (uk, id) => (isAnon(uk) ? null : readJSON(`chats/${uk}/${id}`, null));

/**
 * Adds a question and its answer to a chat, making the chat if it's new. Says whether
 * it wants a (new) title: after the first answer, and again after the sixth, as the
 * conversation finds its topic.
 */
export async function appendToChat(uk, id, { userText, reply, specialist = "general" }) {
  if (isAnon(uk)) return { chat: null, needsTitle: false };
  const now = Date.now();
  const at = new Date(now).toISOString();
  const chat = (await getChat(uk, id)) || { id, title: firstWords(userText), titled: false, created: now, messages: [] };
  chat.messages = [...chat.messages, { role: "user", content: userText, at }, { role: "model", content: reply, at }].slice(-MAX_MESSAGES);
  chat.specialist = specialist;
  chat.updated = now;
  if (!chat.title) chat.title = firstWords(userText);
  await writeJSON(`chats/${uk}/${id}`, chat);
  await writeIndexEntry(uk, chat);
  const answers = chat.messages.filter((m) => m.role === "model").length;
  return { chat, needsTitle: (!chat.titled && answers === 1) || answers === 6 };
}

export async function setChatTitle(uk, id, title) {
  if (isAnon(uk)) return;
  const chat = await getChat(uk, id);
  if (!chat || !title) return;
  chat.title = clip(title, TITLE_LENGTH);
  chat.titled = true;
  await writeJSON(`chats/${uk}/${id}`, chat);
  const index = (await readJSON(`chatindex/${uk}`, null)) || [];
  await writeJSON(`chatindex/${uk}`, index.map((e) => (e.id === id ? { ...e, title: chat.title } : e)));
}

export async function deleteChat(uk, id) {
  if (isAnon(uk)) return;
  await removeKey(`chats/${uk}/${id}`);
  const index = (await readJSON(`chatindex/${uk}`, null)) || [];
  await writeJSON(`chatindex/${uk}`, index.filter((e) => e.id !== id));
  // Its lines in recall go too, so a deleted chat can't be recalled.
  for (const { key, value } of await listJSON(`recall/${uk}/`)) {
    const kept = (value || []).filter((r) => r.chat !== id);
    if (kept.length !== (value || []).length) await writeJSON(key, kept);
  }
}

/** Every chat, the chat list and the recall archive. */
export async function deleteAllChats(uk) {
  if (isAnon(uk)) return;
  for (const prefix of [`chats/${uk}/`, `recall/${uk}/`]) {
    for (const { key } of await listJSON(prefix)) await removeKey(key);
  }
  await removeKey(`chatindex/${uk}`);
}

/* ── recall ─────────────────────────────────────────────────────────────── */

/** Files one question and answer for recall, and lets the month from a year ago go. */
export async function remember(uk, chatId, userText, reply, now = Date.now()) {
  if (isAnon(uk)) return;
  const key = `recall/${uk}/${monthOf(now)}`;
  const rows = await readJSON(key, []);
  rows.push({ at: now, chat: chatId, q: clip(userText, RECALL_TEXT), a: clip(reply, RECALL_TEXT) });
  await writeJSON(key, rows.slice(-RECALL_PER_MONTH));
  const expired = new Date(now);
  await removeKey(`recall/${uk}/${new Date(Date.UTC(expired.getUTCFullYear(), expired.getUTCMonth() - RECALL_MONTHS, 1)).toISOString().slice(0, 7)}`);
}

const CJK = /[぀-ヿ㐀-鿿가-힯]/;

/** Search words: whole words, and pairs of characters for Chinese, Japanese and Korean. */
function searchTerms(query) {
  const words = String(query || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const terms = new Set();
  for (const word of words) {
    if (CJK.test(word) && word.length > 2) for (let i = 0; i < word.length - 1; i++) terms.add(word.slice(i, i + 2));
    else if (word.length > 1 || CJK.test(word)) terms.add(word);
  }
  return [...terms].slice(0, 20);
}

/** Past questions and answers that match, best and newest first. */
export async function recall(uk, query, monthsBackCount = 3, now = Date.now()) {
  const terms = searchTerms(query);
  if (!terms.length) return { error: "Say what to look for." };
  if (isAnon(uk)) return { found: 0, note: "Nothing about that in past conversations." };
  const months = Math.max(1, Math.min(RECALL_MONTHS, Math.round(Number(monthsBackCount) || 3)));
  const scored = [];
  for (const m of monthsBack(months, now)) {
    for (const row of await readJSON(`recall/${uk}/${m}`, [])) {
      const text = `${row.q} ${row.a}`.toLowerCase();
      const score = terms.filter((t) => text.includes(t)).length;
      if (score) scored.push({ score, row });
    }
  }
  if (!scored.length) return { found: 0, note: "Nothing about that in past conversations." };
  const index = (await readJSON(`chatindex/${uk}`, null)) || [];
  const titles = Object.fromEntries(index.map((e) => [e.id, e.title]));
  const best = scored.sort((a, b) => b.score - a.score || b.row.at - a.row.at).slice(0, 8);
  return {
    found: best.length,
    matches: best.map(({ row }) => ({
      when: new Date(row.at).toISOString().slice(0, 16).replace("T", " ") + " UTC",
      chat: titles[row.chat] || "",
      user_said: row.q,
      edith_said: row.a,
    })),
  };
}

/** Chats whose title or recalled lines match the search, newest first. */
export async function searchChats(uk, query) {
  if (isAnon(uk)) return [];
  const index = await listChats(uk);
  const terms = searchTerms(query);
  if (!terms.length) return index;
  const hits = new Set(index.filter((e) => terms.some((t) => e.title.toLowerCase().includes(t))).map((e) => e.id));
  for (const { value } of await listJSON(`recall/${uk}/`)) {
    for (const row of value || []) {
      if (terms.some((t) => `${row.q} ${row.a}`.toLowerCase().includes(t))) hits.add(row.chat);
    }
  }
  return index.filter((e) => hits.has(e.id));
}

/** Signing in: a phone's chats and recall join its account's. */
export async function moveChats(from, to) {
  if (isAnon(from) || isAnon(to) || from === to) return;
  // Each side's older conversation becomes a chat first, so neither drops out of the list.
  await listChats(from);
  await listChats(to);
  const renamed = new Map();
  const moved = [];
  for (const { key, value } of await listJSON(`chats/${from}/`)) {
    if (!value?.id) continue;
    // Both sides can have an "earlier" chat: the phone's gets a new id rather than replacing the account's.
    const id = (await getChat(to, value.id)) ? `${value.id.slice(0, 24)}-${crypto.randomUUID().slice(0, 8)}` : value.id;
    if (id !== value.id) renamed.set(value.id, id);
    const chat = { ...value, id };
    await writeJSON(`chats/${to}/${id}`, chat);
    await removeKey(key);
    moved.push(entryOf(chat));
  }
  if (moved.length) {
    const toIndex = (await readJSON(`chatindex/${to}`, null)) || [];
    const merged = [...moved, ...toIndex.filter((e) => !moved.some((m) => m.id === e.id))].sort((a, b) => b.updated - a.updated);
    for (const old of merged.slice(MAX_CHATS)) await removeKey(`chats/${to}/${old.id}`);
    await writeJSON(`chatindex/${to}`, merged.slice(0, MAX_CHATS));
  }
  await removeKey(`chatindex/${from}`);
  for (const { key, value } of await listJSON(`recall/${from}/`)) {
    const month = key.slice(key.lastIndexOf("/") + 1);
    const target = `recall/${to}/${month}`;
    const rows = (value || []).map((row) => (renamed.has(row.chat) ? { ...row, chat: renamed.get(row.chat) } : row));
    const merged = [...(await readJSON(target, [])), ...rows].sort((a, b) => a.at - b.at);
    await writeJSON(target, merged.slice(-RECALL_PER_MONTH));
    await removeKey(key);
  }
}
