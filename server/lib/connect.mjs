// Connecting an AI account without copying an API key. Today that's OpenRouter, through
// its OAuth PKCE flow (openrouter.ai/docs/use-cases/oauth-pkce). Like signing in, it
// happens in the phone's browser:
//   1. POST /api/connect/openrouter/start     a link, and a poll token only the phone knows
//   2. GET  /api/connect/openrouter/<id>      sends the browser to OpenRouter to approve EDITH
//   3. GET  /api/connect/openrouter/<id>/done OpenRouter sends the browser back with a code
//   4. POST /api/connect/openrouter/poll      the phone trades the code for its key, once
// The key is never stored here: only the one-time code waits (a few seconds, 15 minutes at
// most) until the phone asks for it, and the code is useless without the PKCE verifier.
//
//   connect/<id>   a connection in progress

import { Buffer } from "node:buffer";
import { LANGUAGES } from "./languages.mjs";
import { sameSecret, sha256 } from "./secrets.mjs";
import { readJSON, removeKey, writeJSON } from "./storage.mjs";

const CONNECT_MS = 15 * 60 * 1000;
const random = (bytes) => Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
const pollHash = (token) => sha256(`connect:${token}`).toString("hex");
const cleanId = (id) => (/^[A-Za-z0-9_-]{20,40}$/.test(String(id || "")) ? String(id) : "");

/** Where the browser lands afterwards: a page on EDITH's site that says how it went. */
const resultPage = (origin, status, language) => `${origin}/connect?status=${status}${LANGUAGES[language] ? `&lang=${language}` : ""}`;
const redirect = (location) => new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });

async function open(id) {
  const clean = cleanId(id);
  const record = clean ? await readJSON(`connect/${clean}`, null) : null;
  if (!record) return { id: clean, record: null, expired: false };
  if (Date.now() > record.expires) {
    await removeKey(`connect/${clean}`);
    return { id: clean, record: null, expired: true };
  }
  return { id: clean, record, expired: false };
}

export async function startConnect(device, { origin, language }) {
  const id = random(18);
  const pollToken = random(32);
  const now = Date.now();
  await writeJSON(`connect/${id}`, {
    device,
    verifier: random(32),
    poll: pollHash(pollToken),
    language: LANGUAGES[language] ? language : "",
    created: now,
    expires: now + CONNECT_MS,
    status: "pending",
  });
  // The language rides along in the link, so even an expired link says so in the phone's language.
  const lang = LANGUAGES[language] ? `?lang=${language}` : "";
  return { id, pollToken, url: `${origin}/api/connect/openrouter/${id}${lang}`, expiresIn: CONNECT_MS / 1000 };
}

/** Step 2: off to OpenRouter, with the PKCE challenge for this connection. */
export async function connectRedirect(rawId, origin, linkLanguage = "") {
  const { id, record } = await open(rawId);
  if (!record || record.status !== "pending") return redirect(resultPage(origin, "expired", record?.language || linkLanguage));
  const challenge = sha256(record.verifier).toString("base64url");
  const params = new URLSearchParams({
    callback_url: `${origin}/api/connect/openrouter/${id}/done`,
    code_challenge: challenge,
    code_challenge_method: "S256",
    key_label: "EDITH",
  });
  return redirect(`https://openrouter.ai/auth?${params}`);
}

/** Step 3: OpenRouter is back with a code (or without one, if the person said no). */
export async function connectCallback(rawId, code, origin) {
  const { id, record } = await open(rawId);
  if (!record || record.status !== "pending") return redirect(resultPage(origin, "expired", record?.language));
  const cleanCode = String(code || "").slice(0, 500);
  if (!cleanCode) {
    await removeKey(`connect/${id}`);
    return redirect(resultPage(origin, "failed", record.language));
  }
  await writeJSON(`connect/${id}`, { ...record, status: "approved", code: cleanCode });
  return redirect(resultPage(origin, "ok", record.language));
}

/** Step 4: the phone's poll. Once OpenRouter approved, the code becomes the phone's key. */
export async function pollConnect(rawId, pollToken) {
  const { id, record, expired } = await open(rawId);
  if (!record) return { status: expired ? "expired" : "unknown" };
  if (!sameSecret(record.poll, pollHash(pollToken))) return { status: "unknown" };
  if (record.status !== "approved") return { status: "pending" };
  await removeKey(`connect/${id}`);
  const res = await fetch("https://openrouter.ai/api/v1/auth/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: record.code, code_verifier: record.verifier, code_challenge_method: "S256" }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  const data = res ? await res.json().catch(() => ({})) : {};
  if (!res?.ok || typeof data.key !== "string" || !data.key) {
    console.error("openrouter key exchange failed:", res?.status, String(data?.error?.message || "").slice(0, 120));
    return { status: "failed" };
  }
  return { status: "connected", provider: "openrouter", key: data.key };
}
