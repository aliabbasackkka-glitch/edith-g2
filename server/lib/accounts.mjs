// Accounts for EDITH's customers: sign in with Google or an email and password (through
// Firebase Authentication), and your AI keys, settings, memories and chat follow you
// to any phone.
//
// Google refuses sign-in inside other apps' web views, so it works like
// signing in on a TV:
//   1. The phone asks for a code:          POST /api/account/link/start
//   2. The person opens /signin?code=... in Safari or Chrome and signs in there. The
//      page sends the Firebase ID token:   POST /api/account/link/confirm
//   3. The phone, polling, gets a session: POST /api/account/link/poll
// The phone then sends X-Edith-Session with each request, and its memories and chat
// live under the account's key (acct_...) instead of its own device key.
//
//   accounts/<acct>                  Firebase user id, email, name, sign-in method, dates
//   profiles/<acct>                  settings and AI keys, AES-256-GCM encrypted
//   sessions/<token hash>            the account a phone's session belongs to
//   accountsessions/<acct>/<hash>    an account's sessions, to sign them all out
//   link/<code>                      sign-ins in progress (15 minutes)
//
// Settings: FIREBASE_WEB_CONFIG  the Firebase web app's config (public)
//           ACCOUNT_SECRET       random; the profile encryption keys derive from it
//           FIREBASE_SERVICE_ACCOUNT  lets "Delete account" remove the Firebase user too
//           ACCOUNT_PROVIDERS    the sign-in methods turned on (default google,email; microsoft also works
//                                once it's turned on in Firebase)

import { Buffer } from "node:buffer";
import { deleteAllChats, moveChats } from "./chats.mjs";
import { LANGUAGES } from "./languages.mjs";
import { clearLists } from "./lists.mjs";
import {
  MENU_ITEMS,
  PACES,
  PREF_FIELDS,
  RING_ACTIONS,
  STYLES,
  TALK_STARTS,
  TRANSLATE_TARGETS,
  cleanActionList,
  cleanCalendars,
  cleanCustomList,
  cleanHomeSettings,
  cleanInstructions,
  cleanQuick,
  cleanRoutines,
  cleanSpecialistChoice,
} from "./prefs.mjs";
import { sameSecret, sha256 } from "./secrets.mjs";
import { getHistory, getMemories, listJSON, readJSON, removeKey, writeJSON } from "./storage.mjs";

const subtle = globalThis.crypto.subtle;
const utf8 = (s) => new TextEncoder().encode(s);

export class AccountError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/* ── settings ──────────────────────────────────────────────────────────── */

function webConfig() {
  try {
    const config = JSON.parse(process.env.FIREBASE_WEB_CONFIG || "null");
    return config && /^[a-z0-9-]{4,40}$/.test(config.projectId || "") && config.apiKey ? config : null;
  } catch {
    return null;
  }
}

const secret = () => String(process.env.ACCOUNT_SECRET || "");

export const accountsEnabled = () => Boolean(webConfig() && secret().length >= 32);

const providersOn = () =>
  String(process.env.ACCOUNT_PROVIDERS || "google,email")
    .split(/[\s,]+/)
    .filter((p) => ["google", "microsoft", "email"].includes(p));

/** What the sign-in page needs: public Firebase settings, and the sign-in methods to show. */
export function accountConfig() {
  if (!accountsEnabled()) return { enabled: false, providers: [] };
  const { apiKey, authDomain, projectId, appId, messagingSenderId } = webConfig();
  return { enabled: true, firebase: { apiKey, authDomain, projectId, appId, messagingSenderId }, providers: providersOn() };
}

/* ── Firebase ID tokens ────────────────────────────────────────────────── */

const JWKS_URL = () =>
  process.env.FIREBASE_JWKS_URL || "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
let signingKeys = { at: 0, maxAgeMs: 0, keys: new Map() };

async function signingKey(kid) {
  const age = Date.now() - signingKeys.at;
  // Refetch when stale, or (at most once a minute) when Google has rotated to a key we haven't seen.
  if (age > signingKeys.maxAgeMs || (!signingKeys.keys.has(kid) && age > 60_000)) {
    const res = await fetch(JWKS_URL());
    if (!res.ok) throw new AccountError("verify", `Couldn't load Firebase's signing keys (HTTP ${res.status}).`);
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") || "")?.[1] || 3600);
    const keys = new Map();
    for (const jwk of (await res.json()).keys || []) {
      if (!jwk.kid || jwk.kty !== "RSA") continue;
      const key = await subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      keys.set(jwk.kid, key);
    }
    signingKeys = { at: Date.now(), maxAgeMs: maxAge * 1000, keys };
  }
  return signingKeys.keys.get(kid);
}

const SIGN_IN_METHODS = { "google.com": "google", "microsoft.com": "microsoft", password: "email", emailLink: "email" };

/** Checks a Firebase ID token the way the Firebase Admin SDK does, and returns who signed in. */
export async function verifyIdToken(idToken) {
  const config = webConfig();
  if (!config) throw new AccountError("disabled", "Accounts aren't set up.");
  const bad = () => new AccountError("token", "That sign-in didn't check out. Try again.");
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw bad();
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw bad();
  const key = await signingKey(header.kid);
  if (!key) throw bad();
  const signed = await subtle.verify("RSASSA-PKCS1-v1_5", key, Buffer.from(parts[2], "base64url"), utf8(`${parts[0]}.${parts[1]}`));
  if (!signed) throw bad();

  const now = Math.floor(Date.now() / 1000);
  const SKEW = 60;
  const { projectId } = config;
  if (claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}`) throw bad();
  if (typeof claims.exp !== "number" || claims.exp < now - SKEW) throw new AccountError("token", "That sign-in has expired. Sign in again.");
  if (typeof claims.iat !== "number" || claims.iat > now + SKEW) throw bad();
  if (typeof claims.auth_time === "number" && claims.auth_time > now + SKEW) throw bad();
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 128) throw bad();
  return {
    uid: claims.sub,
    email: typeof claims.email === "string" ? claims.email.slice(0, 200) : "",
    name: typeof claims.name === "string" ? claims.name.slice(0, 100) : "",
    method: SIGN_IN_METHODS[claims.firebase?.sign_in_provider] || "email",
  };
}

/* ── linking a phone ───────────────────────────────────────────────────── */

const LINK_MS = 15 * 60 * 1000;
// No 0/O or 1/I, so a code read off a screen can't be mistyped. 256 % 32 = 0, so no bias.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const accountKey = (uid) => `acct_${sha256(`account:${uid}`).toString("hex").slice(0, 40)}`;
const tokenHash = (token) => sha256(`session:${token}`).toString("hex");
const randomToken = () => Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const cleanCode = (code) => String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
export const showCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

/** Starts signing in a phone: a code for the person, and a poll token only the phone knows. */
export async function startLink(device, { origin, language }) {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
  const code = [...bytes].map((b) => CODE_ALPHABET[b % 32]).join("");
  const pollToken = randomToken();
  const now = Date.now();
  await writeJSON(`link/${code}`, { poll: tokenHash(pollToken), device, created: now, expires: now + LINK_MS, status: "pending" });
  const lang = LANGUAGES[language] ? `&lang=${language}` : "";
  return {
    code: showCode(code),
    pollToken,
    url: `${origin}/signin?code=${showCode(code)}${lang}`,
    expiresIn: Math.round(LINK_MS / 1000),
  };
}

async function openLink(rawCode) {
  const code = cleanCode(rawCode);
  if (code.length !== 8) return { code, link: null, reason: "unknown" };
  const link = await readJSON(`link/${code}`, null);
  if (!link) return { code, link: null, reason: "unknown" };
  if (Date.now() > link.expires) {
    await removeKey(`link/${code}`);
    return { code, link: null, reason: "expired" };
  }
  return { code, link, reason: "" };
}

/** For the sign-in page, before anyone signs in: is this code waiting? */
export async function checkLink(rawCode) {
  const { link, reason } = await openLink(rawCode);
  if (!link || link.status !== "pending") return { ok: false, reason: reason || "used" };
  return { ok: true, expiresIn: Math.round((link.expires - Date.now()) / 1000) };
}

/** The sign-in page's confirmation: this Firebase user signs in the phone showing this code. */
export async function confirmLink(rawCode, idToken) {
  const who = await verifyIdToken(idToken);
  const { code, link, reason } = await openLink(rawCode);
  if (!link || link.status !== "pending") return { ok: false, reason: reason || "used" };

  const acct = accountKey(who.uid);
  const now = Date.now();
  const existing = await readJSON(`accounts/${acct}`, null);
  await writeJSON(`accounts/${acct}`, {
    uid: who.uid,
    email: who.email || existing?.email || "",
    name: who.name || existing?.name || "",
    method: who.method,
    created: existing?.created || now,
    seen: now,
  });
  await writeJSON(`link/${code}`, { ...link, status: "approved", acct, method: who.method });
  return { ok: true, email: who.email, name: who.name };
}

/**
 * The phone's poll. Once approved it gets its session (once), and anything it had
 * remembered before signing in moves into the account.
 */
export async function pollLink(rawCode, pollToken, device) {
  const { code, link, reason } = await openLink(rawCode);
  if (!link) return { status: reason === "expired" ? "expired" : "unknown" };
  if (!sameSecret(link.poll, tokenHash(pollToken))) return { status: "unknown" };
  if (link.status !== "approved") return { status: "pending" };

  await removeKey(`link/${code}`);
  const account = await readJSON(`accounts/${link.acct}`, null);
  if (!account) return { status: "unknown" };
  const session = randomToken();
  const hash = tokenHash(session);
  const now = Date.now();
  const method = link.method || account.method;
  await writeJSON(`sessions/${hash}`, { acct: link.acct, method, created: now });
  await writeJSON(`accountsessions/${link.acct}/${hash}`, { created: now });
  await moveDeviceData(device || link.device, link.acct);
  return { status: "approved", session, account: publicAccount(account, method) };
}

/** Who is signed in, and how this phone signed in (each phone may have used a different way). */
const publicAccount = (a, method) => ({ email: a.email || "", name: a.name || "", method: method || a.method || "email" });

const MAX_MEMORIES = 200;

/** Memories and chat from before signing in join the account, then leave the phone's own key. */
async function moveDeviceData(device, acct) {
  if (!device || device === "anon" || device === acct) return;
  await moveChats(device, acct);
  const [ownMemories, accountMemories, ownHistory, accountHistory] = await Promise.all([
    getMemories(device),
    getMemories(acct),
    getHistory(device),
    getHistory(acct),
  ]);
  if (ownMemories.length) {
    const kept = new Set(accountMemories.map((m) => `${m.category}\n${m.key}`));
    const merged = [...ownMemories.filter((m) => !kept.has(`${m.category}\n${m.key}`)), ...accountMemories];
    await writeJSON(`memories/${acct}`, merged.slice(-MAX_MEMORIES));
    await removeKey(`memories/${device}`);
  }
  if (ownHistory.length) {
    if (!accountHistory.length) await writeJSON(`history/${acct}`, ownHistory);
    await removeKey(`history/${device}`);
  }
}

/* ── sessions ──────────────────────────────────────────────────────────── */

const SESSION_CACHE_MS = 60_000;
const sessionCache = new Map(); // token hash -> { acct, method, at }

/** The account a request's X-Edith-Session belongs to, or null when there is none or it ended. */
export async function sessionFor(req) {
  const token = (req.headers.get("x-edith-session") || "").trim();
  if (!token || token.length > 100) return null;
  const hash = tokenHash(token);
  const cached = sessionCache.get(hash);
  if (cached && Date.now() - cached.at < SESSION_CACHE_MS) return { acct: cached.acct, method: cached.method, hash };
  const rec = await readJSON(`sessions/${hash}`, null);
  if (!rec?.acct) {
    sessionCache.delete(hash);
    return null;
  }
  if (sessionCache.size > 1000) sessionCache.clear();
  sessionCache.set(hash, { acct: rec.acct, method: rec.method, at: Date.now() });
  return { acct: rec.acct, method: rec.method, hash };
}

export async function endSession({ acct, hash }) {
  sessionCache.delete(hash);
  await Promise.all([removeKey(`sessions/${hash}`), removeKey(`accountsessions/${acct}/${hash}`)]);
  return { ok: true };
}

/* ── profiles: settings and AI keys, encrypted ─────────────────────────── */

async function profileKey(acct) {
  const base = await subtle.importKey("raw", utf8(secret()), "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: utf8("edith-profile-v1"), info: utf8(acct) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const cleanId = (s) => (/^[a-z0-9_-]{1,40}$/.test(String(s || "")) ? String(s) : "");

/** Only the fields EDITH syncs, within sensible sizes. */
export function cleanProfile(p) {
  const keys = {};
  for (const [id, k] of Object.entries(p?.keys && typeof p.keys === "object" ? p.keys : {}).slice(0, 12)) {
    if (!cleanId(id) || typeof k?.key !== "string" || !k.key.trim()) continue;
    keys[id] = {
      key: k.key.trim().slice(0, 400),
      model: String(k.model || "").slice(0, 200),
      label: String(k.label || "").slice(0, 80),
      voice: Boolean(k.voice),
      // "Your own server": the address it answers on follows the account too (1.7.4).
      ...(/^https:\/\/\S+$/i.test(String(k.base || "")) ? { base: String(k.base).slice(0, 300) } : {}),
    };
  }
  return {
    keys,
    active: cleanId(p?.active),
    voice: cleanId(p?.voice) || "auto",
    language: LANGUAGES[p?.language] ? p.language : "",
    // Answer preferences and the glasses menu (EDITH 1.5.0 and later).
    theme: p?.theme === "even" ? "even" : "edith",
    style: STYLES.includes(p?.style) ? p.style : "normal",
    pace: PACES.includes(p?.pace) ? p.pace : "instant",
    liveWords: p?.liveWords !== false,
    instructions: cleanInstructions(p?.instructions),
    specialist: cleanSpecialistChoice(p?.specialist),
    translateTo: TRANSLATE_TARGETS[p?.translateTo] ? p.translateTo : "",
    menu: Array.isArray(p?.menu) ? [...new Set(p.menu.filter((id) => MENU_ITEMS.includes(id)))] : null,
    quick: cleanQuick(p?.quick),
    // Location, the glasses dashboard, follow-ups, own specialists, calendars, smart home,
    // actions and routines (EDITH 1.6.0 and later).
    location: p?.location !== false,
    dashboard: p?.dashboard !== false,
    followUp: p?.followUp !== false,
    // The glasses themselves (EDITH 1.7.0).
    openListening: p?.openListening !== false,
    ring: RING_ACTIONS.includes(p?.ring) ? p.ring : "same",
    talk: TALK_STARTS.includes(p?.talk) ? p.talk : "tapOrHold",
    discreet: p?.discreet === true,
    // Whether the keypad guesses whole words: English only, so it can be off (1.7.4).
    guessing: p?.guessing !== false,
    // What the other person speaks, for subtitles on the glasses (1.8.0).
    roomLanguage: TRANSLATE_TARGETS[p?.roomLanguage] ? p.roomLanguage : "",
    custom: cleanCustomList(p?.custom),
    calendars: cleanCalendars(p?.calendars),
    home: cleanHomeSettings(p?.home),
    actions: cleanActionList(p?.actions),
    routines: cleanRoutines(p?.routines),
  };
}

async function readProfile(acct) {
  const stored = await readJSON(`profiles/${acct}`, null);
  if (!stored?.data) return { profile: null, updatedAt: 0 };
  try {
    const plain = await subtle.decrypt(
      { name: "AES-GCM", iv: Buffer.from(stored.iv, "base64"), additionalData: utf8(acct) },
      await profileKey(acct),
      Buffer.from(stored.data, "base64"),
    );
    return { profile: cleanProfile(JSON.parse(new TextDecoder().decode(plain))), updatedAt: stored.updatedAt || 0 };
  } catch (err) {
    console.error("profile decrypt failed:", err?.message || err);
    return { profile: null, updatedAt: 0 };
  }
}

async function writeProfile(acct, profile, updatedAt) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = await subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8(acct) },
    await profileKey(acct),
    utf8(JSON.stringify(cleanProfile(profile))),
  );
  await writeJSON(`profiles/${acct}`, { v: 1, iv: Buffer.from(iv).toString("base64"), data: Buffer.from(data).toString("base64"), updatedAt });
}

/** GET /api/account: who is signed in, and their synced settings and keys. */
export async function accountSummary({ acct, method }) {
  const account = await readJSON(`accounts/${acct}`, null);
  if (!account) return null;
  const { profile, updatedAt } = await readProfile(acct);
  return { account: publicAccount(account, method), profile, updatedAt };
}

/**
 * POST /api/account/profile. The newest change wins: if the account changed after the
 * phone's copy, the phone gets the account's instead.
 */
export async function saveProfile({ acct }, body) {
  const updatedAt = Number(body?.updatedAt) || Date.now();
  const current = await readProfile(acct);
  if (current.profile && current.updatedAt > updatedAt) return { ok: false, stale: true, profile: current.profile, updatedAt: current.updatedAt };
  if (JSON.stringify(body?.profile ?? null).length > 20_000) throw new AccountError("size", "Those settings are too large.");
  let profile = body?.profile;
  // Settings an older app doesn't know about stay as a newer phone left them: only fields
  // the app actually sent are changed.
  if (current.profile && profile && typeof profile === "object") {
    const kept = PREF_FIELDS.filter((field) => !(field in profile)).map((field) => [field, current.profile[field]]);
    if (kept.length) profile = { ...profile, ...Object.fromEntries(kept) };
  }
  await writeProfile(acct, profile, updatedAt);
  return { ok: true, updatedAt };
}

/* ── deleting an account ───────────────────────────────────────────────── */

let googleToken = { value: "", expires: 0 };

/** An access token for the Firebase project, from FIREBASE_SERVICE_ACCOUNT, or "" without one. */
async function googleAccessToken() {
  if (googleToken.value && Date.now() < googleToken.expires) return googleToken.value;
  let account;
  try {
    account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "null");
  } catch {
    return "";
  }
  if (!account?.private_key || !account?.client_email) return "";
  const now = Math.floor(Date.now() / 1000);
  const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/identitytoolkit",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const der = Buffer.from(account.private_key.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""), "base64");
  const key = await subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = Buffer.from(await subtle.sign("RSASSA-PKCS1-v1_5", key, utf8(unsigned))).toString("base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`Google token: HTTP ${res.status}`);
  googleToken = { value: data.access_token, expires: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60_000 };
  return googleToken.value;
}

async function deleteFirebaseUser(uid) {
  const token = await googleAccessToken();
  if (!token) return false;
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${webConfig().projectId}/accounts:delete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ localId: uid }),
  });
  return res.ok;
}

/** Deletes an account and everything under it, signs out all its phones, and removes the Firebase user. */
export async function deleteAccount(acct) {
  const account = await readJSON(`accounts/${acct}`, null);
  const sessions = await listJSON(`accountsessions/${acct}/`);
  for (const { key } of sessions) {
    const hash = key.slice(key.lastIndexOf("/") + 1);
    sessionCache.delete(hash);
    await removeKey(`sessions/${hash}`);
    await removeKey(key);
  }
  await Promise.all(["profiles", "memories", "history", "devices", "accounts"].map((kind) => removeKey(`${kind}/${acct}`)));
  await deleteAllChats(acct);
  await clearLists(acct);
  let firebaseDeleted = false;
  if (account?.uid) {
    firebaseDeleted = await deleteFirebaseUser(account.uid).catch((err) => {
      console.error("firebase user delete failed:", err?.message || err);
      return false;
    });
  }
  return { ok: true, firebaseDeleted };
}
