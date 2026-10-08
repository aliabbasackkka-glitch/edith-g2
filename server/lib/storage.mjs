// Memories, conversation history, bans and rate counters, as JSON values under string
// keys. The host picks where they live with useStorage(): D1 on Cloudflare, Netlify
// Blobs on Netlify. Without one (local tests) they stay in process memory.
//
//   memories/<device>  history/<device>   what EDITH remembers and the recent chat
//   blocked/<device>   flags/<device>     bans, and what moderation flagged (lib/moderation.mjs)
//   rate/...           ics/<device>       sign-in, connect and calendar rate counters
//
// A phone signed in to an account uses the account's key (acct_...) in place of its
// own device key; the account records themselves are described in accounts.mjs. Only a
// session leads to an account's key: X-Device-Id can never name one (cleanDeviceId).

import { networkOf } from "./net.mjs";
import { sha256 } from "./secrets.mjs";

/** @typedef {{ kind: string, get(key: string): Promise<any>, set(key: string, value: any): Promise<void>, delete(key: string): Promise<void>, list(prefix: string): Promise<Array<{ key: string, value: any }>> }} StorageBackend */

const memory = new Map();
/** @type {StorageBackend | null} */
let backend = null;
let clientIpHeader = "x-forwarded-for";

/**
 * Configures storage for this host. clientIpHeader names the header the host
 * sets to the caller's IP, which the caller can't forge on that host.
 */
export function useStorage(storage, options = {}) {
  backend = storage;
  if (options.clientIpHeader) clientIpHeader = options.clientIpHeader;
}

export const storageKind = () => backend?.kind || "memory";

export async function readJSON(key, fallback) {
  if (!backend) return memory.has(key) ? structuredClone(memory.get(key)) : fallback;
  try {
    return (await backend.get(key)) ?? fallback;
  } catch (e) {
    console.error("storage read failed", key, e.message);
    return fallback;
  }
}

export async function writeJSON(key, value) {
  if (!backend) return void memory.set(key, structuredClone(value));
  try { await backend.set(key, value); } catch (e) { console.error("storage write failed", key, e.message); }
}

export async function removeKey(key) {
  if (!backend) return void memory.delete(key);
  try { await backend.delete(key); } catch (e) { console.error("storage delete failed", key, e.message); }
}

/** Every stored value whose key starts with prefix, as { key, value }. */
export async function listJSON(prefix) {
  if (!backend) {
    return [...memory.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) }));
  }
  try {
    return await backend.list(prefix);
  } catch (e) {
    console.error("storage list failed", prefix, e.message);
    return [];
  }
}

export const cleanKey = (s) => String(s || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);

/**
 * A request with no usable device id. It is nobody in particular, so it shares nothing:
 * memories, history, chats and lists read as empty for it and nothing is kept under it.
 */
export const ANON = "anon";
export const isAnon = (uk) => !uk || uk === ANON;

/**
 * A device id a phone may use, or "". An account's key (acct_...) is never one: anyone
 * who could work it out would otherwise open that account's data without its session.
 */
export function cleanDeviceId(raw) {
  const id = cleanKey(raw);
  return !id || /^acct_/i.test(id) || id.toLowerCase() === ANON ? "" : id;
}

export const deviceKey = (req) => cleanDeviceId(req.headers.get("x-device-id")) || ANON;

const MAX_MEMORIES = 200;
const MAX_HISTORY = 40;

export const getMemories = async (uk) => (isAnon(uk) ? [] : readJSON(`memories/${uk}`, []));
export const getHistory = async (uk) => (isAnon(uk) ? [] : readJSON(`history/${uk}`, []));
export const clearHistory = async (uk) => (isAnon(uk) ? undefined : removeKey(`history/${uk}`));

/** Forget everything: the memories go. */
export const clearMemories = async (uk) => (isAnon(uk) ? undefined : removeKey(`memories/${uk}`));

export async function saveMemory(uk, category, key, value) {
  if (isAnon(uk)) return;
  const rows = await getMemories(uk);
  const cat = cleanKey(category).toLowerCase() || "notes";
  const k = String(key || "").trim().slice(0, 80);
  if (!k) return;
  const next = rows.filter((r) => !(r.category === cat && r.key === k));
  next.push({ category: cat, key: k, value: String(value).slice(0, 500) });
  await writeJSON(`memories/${uk}`, next.slice(-MAX_MEMORIES));
}

export async function appendHistory(uk, rows) {
  if (isAnon(uk)) return;
  const at = new Date().toISOString();
  const history = await getHistory(uk);
  await writeJSON(`history/${uk}`, [...history, ...rows.map((r) => ({ ...r, at }))].slice(-MAX_HISTORY));
}

/** A phone's ban, with why it was given (see lib/moderation.mjs), or null. */
export const banOn = async (uk) => (isAnon(uk) ? null : readJSON(`blocked/${uk}`, null));

export const isBlocked = async (uk) => Boolean(await banOn(uk));

/** Bans a phone, with the reason it is told. Lifted by deleting blocked/<device>. */
export const banPhone = async (uk, why) => (isAnon(uk) ? undefined : writeJSON(`blocked/${uk}`, { at: Date.now(), why }));

/**
 * The caller's network, hashed: requests are counted per network without keeping IPs. An
 * IPv6 caller counts as its /64 (net.mjs), so one subscriber can't be a billion callers.
 */
export const clientNetwork = (req) => sha256(networkOf(req.headers.get(clientIpHeader) || "")).toString("hex").slice(0, 24);

/**
 * Counts one attempt under key; false once there were more than max in the window. A limit
 * on callers is keyed on clientNetwork(), never on the device id, which is whatever the
 * caller says it is.
 */
export async function allowRate(key, max, windowMs) {
  const now = Date.now();
  let rec = await readJSON(key, { count: 0, since: now });
  if (now - rec.since > windowMs) rec = { count: 0, since: now };
  rec.count++;
  await writeJSON(key, rec);
  return rec.count <= max;
}
