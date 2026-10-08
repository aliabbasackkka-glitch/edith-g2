// Shared plumbing for talking to AI providers: a typed error, response
// classification, and a Server-Sent Events reader for streamed replies.

import { publicFetch } from "./net.mjs";

/**
 * kind: "key" (rejected key), "quota" (rate limit or out of credits), "model"
 * (model unavailable to this key), "overloaded" (provider 5xx), "network",
 * "refused" (the model declined), "unclear" (no speech heard), "voice" (no way to
 * transcribe), "timeout", "other".
 */
export class ProviderError extends Error {
  constructor(kind, message, status = 0) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

/** Best-effort human message from a provider's error body. */
export function errorMessage(text) {
  try {
    const body = JSON.parse(text);
    const e = body?.error ?? body;
    if (typeof e === "string") return e;
    return String(e?.message || e?.msg || body?.message || body?.detail || text).slice(0, 300);
  } catch {
    return String(text || "").slice(0, 300);
  }
}

/**
 * What to say when a server the wearer named themselves doesn't answer: the
 * address is the thing to check, not the weather at some provider (1.7.4).
 */
export const unreachable = (label) => `EDITH couldn't reach ${label}. Check the address, and that the server is running.`;

/** Maps a failed HTTP response to a ProviderError, reading its body once. */
export async function providerErrorFrom(res, label, own = false) {
  return providerError(res.status, await res.text().catch(() => ""), label, own);
}

/** Maps a failed status and body to a ProviderError. */
export function providerError(status, text, label, own = false) {
  const detail = errorMessage(text);
  // Nothing answered at the address, or whatever did is not the AI they meant.
  if (own && (status >= 500 || status === 404)) return new ProviderError("network", unreachable(label), status);
  if (status === 401 || status === 403 || (status === 400 && /API_KEY_INVALID|invalid.?api.?key|incorrect api key/i.test(text))) {
    return new ProviderError("key", `${label} rejected this API key.`, status);
  }
  if (status === 402 || status === 429) {
    return new ProviderError("quota", `${label} says this key is out of quota or credits for now.`, status);
  }
  if (status === 404 || (status === 400 && /model/i.test(detail) && /(not found|not exist|does not exist|unknown|invalid|unsupported|not supported|decommission|deprecated)/i.test(detail))) {
    return new ProviderError("model", `${label} can't use that model with this key: ${detail}`, status);
  }
  if (status >= 500) return new ProviderError("overloaded", `${label} is busy right now. Try again in a moment.`, status);
  return new ProviderError("other", `${label} error ${status}: ${detail}`, status);
}

/**
 * Wraps fetch so network failures and aborts become ProviderErrors. `own` marks a server
 * the wearer named themselves: its address, and any redirect it answers with, must be
 * public https (net.mjs), so it can never point EDITH's server somewhere private.
 */
export async function request(url, init, label, own = false) {
  try {
    return await (own ? publicFetch(url, init) : fetch(url, init));
  } catch (err) {
    if (init?.signal?.aborted) throw new ProviderError("timeout", "Stopped before the answer finished.");
    throw new ProviderError("network", own ? unreachable(label) : `Couldn't reach ${label}.`);
  }
}

/**
 * Yields { event, data } for each Server-Sent Event in a streamed response.
 * Comment lines (": keep-alive") are skipped; multi-line data is joined.
 */
export async function* readSse(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let data = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.search(/\r?\n/)) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(buffer[newline] === "\r" ? newline + 2 : newline + 1);
        if (line === "") {
          if (data.length) yield { event, data: data.join("\n") };
          event = "";
          data = [];
        } else if (line.startsWith(":")) {
          continue;
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        } else if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        }
      }
      if (done) {
        if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, ""));
        if (data.length) yield { event, data: data.join("\n") };
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** A WAV upload as a File for multipart transcription endpoints. */
export function wavFile(base64) {
  return new File([Buffer.from(base64, "base64")], "question.wav", { type: "audio/wav" });
}

/** Removes quotes and returns "" for the "(unclear audio)" sentinel. */
export function cleanTranscript(text) {
  const t = String(text || "").trim().replace(/^["'“”]+|["'“”]+$/g, "");
  return !t || /^\(?unclear audio\)?\.?$/i.test(t) ? "" : t.slice(0, 2000);
}

export const TRANSCRIBE_INSTRUCTION =
  "You are a transcription engine. Output ONLY a verbatim transcription of the speech in the audio: no " +
  "commentary, no speaker labels, no quotation marks, no translation. If there is no intelligible speech, " +
  "output exactly: (unclear audio)";

/** The transcription instruction, with a hint about the expected language (a name such as "Japanese"). */
export const transcribeInstruction = (languageName) =>
  languageName
    ? `${TRANSCRIBE_INSTRUCTION} The speech is most likely in ${languageName}; write it in that language's usual script.`
    : TRANSCRIBE_INSTRUCTION;
