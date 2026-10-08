// Google Gemini, native API, with the wearer's own key. "Auto" walks a ladder of fast
// models, since free quota is per project per model.

import {
  ProviderError,
  cleanTranscript,
  providerError,
  readSse,
  request,
  transcribeInstruction,
} from "../http.mjs";

const LABEL = "Google Gemini";
const API = "https://generativelanguage.googleapis.com/v1beta/models";
const list = (v, dflt) => String(v || dflt).split(",").map((s) => s.trim()).filter(Boolean);

// Read when used, not at import: a Cloudflare Worker only sees its variables during a request.
export const chatModels = () => list(process.env.CHAT_MODELS,
  "gemini-3.8-flash,gemini-3.7-flash,gemini-3.5-flash,gemini-flash-latest,gemini-3-flash-preview,gemini-3.1-flash-lite");
const transcribeModels = () => list(process.env.TRANSCRIBE_MODELS,
  "gemini-3.1-flash-lite,gemini-3-flash-preview,gemini-3.8-flash");

// Give up early: a fast, honest error beats a host timeout. The attempt cap also
// keeps a request well under a Worker's subrequest limit.
const searchMs = () => Number(process.env.GEMINI_SEARCH_MS || 7000);
const searchAttempts = () => Number(process.env.GEMINI_SEARCH_ATTEMPTS || 14);

const modelCooldown = new Map(); // "access id|model" -> until
const MODEL_COOLDOWN_MS = 20 * 60 * 1000;
const OVERLOAD_COOLDOWN_MS = 60 * 1000;

const keyRejected = (status, text) =>
  (status === 400 && text.includes("API_KEY_INVALID")) || status === 401 || status === 403;

/** One model with the access's key. */
async function openModel(access, model, method, body, budget, signal) {
  if (Date.now() > budget.until || budget.tries >= budget.maxTries) return { status: 429, text: "", exhausted: true };
  budget.tries++;
  const suffix = method === "stream" ? "streamGenerateContent?alt=sse&" : "generateContent?";
  const res = await request(`${API}/${model}:${suffix}key=${access.keys[0]}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  }, LABEL);
  if (res.ok) return { res };
  const text = await res.text();
  return { status: res.status, text, keyRejected: keyRejected(res.status, text) };
}

/** Walks the model ladder until one model answers; throws a ProviderError otherwise. */
async function openLadder(access, models, method, body, signal) {
  const budget = { until: Date.now() + searchMs(), tries: 0, maxTries: searchAttempts() };
  const now = Date.now();
  const parked = (m) => (modelCooldown.get(`${access.id}|${m}`) || 0) > now;
  const queue = [...models.filter((m) => !parked(m)), ...models.filter(parked)];

  let last = { status: 0, text: "" };
  for (const model of queue) {
    const out = await openModel(access, model, method, body, budget, signal);
    if (out.res) return { res: out.res, model };
    last = out;
    if (out.exhausted || out.keyRejected) break; // out of time, or the key itself is bad
    if (out.status === 429 || (out.status === 400 && models.length > 1)) {
      modelCooldown.set(`${access.id}|${model}`, Date.now() + MODEL_COOLDOWN_MS);
      continue;
    }
    if (out.status >= 500) {
      modelCooldown.set(`${access.id}|${model}`, Date.now() + OVERLOAD_COOLDOWN_MS);
      console.warn(`model ${model} -> ${out.status}, trying the next`);
      continue;
    }
    break;
  }

  if (last.keyRejected) throw new ProviderError("key", "Google rejected this Gemini API key.", last.status);
  if (last.status === 429 || last.exhausted) {
    throw new ProviderError("quota", "Your Gemini key is out of free quota for now. It resets daily.", 429);
  }
  throw providerError(last.status, last.text, LABEL);
}

// Gemini's schema uses upper-case type names.
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "type" && typeof v === "string") out[k] = v.toUpperCase();
    else if (k === "properties") out[k] = Object.fromEntries(Object.entries(v).map(([p, s]) => [p, toGeminiSchema(s)]));
    else if (k === "items") out[k] = toGeminiSchema(v);
    else out[k] = v;
  }
  return out;
}

/**
 * A conversation turn loop. next() streams one model turn, calling onText for
 * each piece of answer text, and returns { text, toolCalls }.
 */
export function geminiConversation({ access, model, system, history, userText, image, tools, signal }) {
  const models = !model || model === "auto" ? chatModels() : [model];
  const contents = [
    ...history.map((h) => ({ role: h.role === "assistant" ? "model" : "user", parts: [{ text: h.text }] })),
    // A photo taken on the phone travels with the question it belongs to (1.7.0).
    {
      role: "user",
      parts: image ? [{ text: userText }, { inlineData: { mimeType: image.mime, data: image.data } }] : [{ text: userText }],
    },
  ];
  const declarations = [{
    functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) })),
  }];
  let thinkingOff = true;
  const convo = {
    model: models[0],
    async next({ onText }) {
      const body = () => ({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        ...(tools.length ? { tools: declarations } : {}),
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 1024,
          // Thinking is pure latency for short glasses answers; models that require it reject this.
          ...(thinkingOff ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
      });
      let opened;
      try {
        opened = await openLadder(access, models, "stream", body(), signal);
      } catch (err) {
        if (!(thinkingOff && err.kind === "other" && /thinking/i.test(err.message))) throw err;
        thinkingOff = false;
        opened = await openLadder(access, models, "stream", body(), signal);
      }
      convo.model = opened.model;

      // Every part is kept as sent, so thought signatures survive into the next turn.
      const parts = [];
      const calls = [];
      let text = "";
      for await (const { data } of readSse(opened.res)) {
        let chunk;
        try { chunk = JSON.parse(data); } catch { continue; }
        if (chunk.error) throw new ProviderError("other", `Google Gemini error: ${chunk.error.message || "unknown"}`);
        const cand = chunk.candidates?.[0];
        if (!cand && chunk.promptFeedback?.blockReason) throw new ProviderError("refused", "Gemini declined to answer that.");
        for (const part of cand?.content?.parts || []) {
          parts.push(part);
          if (part.functionCall) {
            calls.push({ id: part.functionCall.id || "", name: part.functionCall.name, args: part.functionCall.args || {} });
          } else if (typeof part.text === "string" && part.text && !part.thought) {
            text += part.text;
            onText(part.text);
          }
        }
        if (cand?.finishReason === "SAFETY" && !text && !calls.length) {
          throw new ProviderError("refused", "Gemini declined to answer that.");
        }
      }
      if (calls.length) contents.push({ role: "model", parts });
      return { text, toolCalls: calls };
    },
    addToolResults(calls, results) {
      contents.push({
        role: "user",
        parts: calls.map((c, i) => ({
          functionResponse: { ...(c.id ? { id: c.id } : {}), name: c.name, response: results[i] },
        })),
      });
    },
  };
  return convo;
}

export async function geminiTranscribe({ access, audio, signal, languageName = "" }) {
  const { res } = await openLadder(access, transcribeModels(), "generate", {
    systemInstruction: { parts: [{ text: transcribeInstruction(languageName) }] },
    contents: [{ role: "user", parts: [{ inlineData: { mimeType: audio.mime, data: audio.data } }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 500 },
  }, signal);
  const d = await res.json();
  return cleanTranscript((d.candidates?.[0]?.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join(""));
}

const AUTO = { id: "auto", name: "Auto (fastest available)" };

/** Auto, then the ladder's models: what a key that is busy right now can pick from. */
const ladderModels = () => ({
  models: [AUTO, ...chatModels().map((id) => ({ id, name: id }))],
  defaultModel: "auto",
});

/** Validates a user's key and lists the Gemini models it can use. */
export async function geminiModels(key) {
  const res = await request(`${API}?pageSize=1000&key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(8000) }, LABEL);
  if (res.status === 429) return ladderModels(); // a valid key that is merely busy
  if (!res.ok) {
    const text = await res.text();
    throw keyRejected(res.status, text) || res.status === 400
      ? new ProviderError("key", "Google rejected this Gemini API key.", res.status)
      : providerError(res.status, text, LABEL);
  }
  const d = await res.json();
  const models = (d.models || [])
    .filter((m) =>
      (m.supportedGenerationMethods || []).includes("generateContent") &&
      /^models\/gemini/.test(m.name) &&
      !/(embedding|tts|image|live|native-audio|aqa|robotics|computer-use|learnlm)/i.test(m.name))
    .map((m) => ({ id: m.name.replace(/^models\//, ""), name: m.displayName || m.name.replace(/^models\//, "") }));
  return { models: [AUTO, ...models], defaultModel: "auto" };
}
