// The AI providers EDITH supports. The phone app reads this list from
// GET /api/providers, so adding a provider here needs no new app version.

import { ProviderError, providerErrorFrom, request } from "../http.mjs";
import { LANGUAGES } from "../languages.mjs";
import { sha256 } from "../secrets.mjs";
import { anthropicConversation, anthropicModels } from "./anthropic.mjs";
import { geminiConversation, geminiModels, geminiTranscribe } from "./gemini.mjs";
import { openaiConversation, openaiModels, openaiTranscribe, pickDefault } from "./openai-compatible.mjs";

// EDITH's own address, which OpenRouter shows as the app a key is used by. Optional:
// EDITH_SITE_URL, or URL, which Netlify sets by itself.
const site = () => process.env.EDITH_SITE_URL || process.env.URL || "";
const HOUR = 60 * 60 * 1000;

/* ── OpenAI ──────────────────────────────────────────────────────────────── */
function openaiListModels(rows) {
  const ids = rows
    .map((r) => r.id)
    .filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) &&
      !/(audio|realtime|transcribe|tts|image|search|embedding|moderation|instruct|codex|dall-e|whisper|computer-use|deep-research|diarize|live)/i.test(id));
  const all = new Set(ids);
  const created = Object.fromEntries(rows.map((r) => [r.id, r.created || 0]));
  return ids
    .filter((id) => { const base = id.replace(/-\d{4}-\d{2}-\d{2}$/, ""); return base === id || !all.has(base); })
    .sort((a, b) => created[b] - created[a])
    .map((id) => ({ id, name: id }));
}

function openaiExtras(model) {
  if (/^(gpt-5\.\d|gpt-6)/.test(model)) return { reasoning_effort: "none" };
  if (/^gpt-5(-mini|-nano)?(-\d{4}-\d{2}-\d{2})?$/.test(model)) return { reasoning_effort: "minimal" };
  if (/^o\d/.test(model)) return { reasoning_effort: "low" };
  return {};
}

/* ── OpenRouter ──────────────────────────────────────────────────────────── */
let openrouterCatalog = { at: 0, rows: [] };

async function openrouterRows(signal) {
  if (Date.now() - openrouterCatalog.at < HOUR && openrouterCatalog.rows.length) return openrouterCatalog.rows;
  const res = await request("https://openrouter.ai/api/v1/models", { signal: signal || AbortSignal.timeout(8000) }, "OpenRouter");
  if (!res.ok) throw await providerErrorFrom(res, "OpenRouter");
  const body = await res.json();
  openrouterCatalog = { at: Date.now(), rows: Array.isArray(body.data) ? body.data : [] };
  return openrouterCatalog.rows;
}

async function openrouterCheckKey(key) {
  for (const path of ["/key", "/auth/key"]) {
    const res = await request(`https://openrouter.ai/api/v1${path}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    }, "OpenRouter");
    if (res.ok) return;
    if (res.status !== 404) throw await providerErrorFrom(res, "OpenRouter");
  }
}

// Free (":free") models that call tools well enough for EDITH, best first.
const OPENROUTER_FREE_PREFERENCES = [/^openai\/gpt-oss-120b:free$/, /^openai\/gpt-oss-20b:free$/, /^meta-llama\/llama-3\.3-70b-instruct:free$/, /^(deepseek|qwen|google|mistralai)\/.+:free$/, /:free$/];

/**
 * Whether an OpenRouter key's account has never bought credits. Such accounts can only
 * use ":free" models (a daily request cap), so the default becomes the best free one.
 */
export async function openrouterFreeTier(key, models) {
  const res = await request("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(8000),
  }, "OpenRouter");
  if (!res.ok) return { freeTier: false, defaultModel: "" };
  const info = (await res.json().catch(() => ({})))?.data || {};
  if (!info.is_free_tier) return { freeTier: false, defaultModel: "" };
  return { freeTier: true, defaultModel: pickDefault(models.filter((m) => m.id.endsWith(":free")), OPENROUTER_FREE_PREFERENCES) };
}

async function openrouterAudioModel(signal) {
  const audio = (await openrouterRows(signal)).filter((r) =>
    (r.architecture?.input_modalities || []).includes("audio") && !r.id.includes(":"));
  const newestFlash = audio
    .filter((r) => /^google\/gemini-[\d.]+-flash(-lite)?$/.test(r.id))
    .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))[0];
  const pick = newestFlash || audio[0];
  if (!pick) throw new ProviderError("voice", "OpenRouter has no model that can hear audio right now.");
  return pick.id;
}

/* ── the catalog ─────────────────────────────────────────────────────────── */
const HINTS_EN = {
  fastestAvailable: "fastest available",
  smartestFlash: "smartest Flash",
  quickest: "quickest",
  deepThinking: "deep thinking",
  paidKeys: "paid keys",
  faster: "faster",
  instant: "instant",
  fast: "fast",
  balanced: "balanced",
  flagship: "flagship",
  mostCapable: "most capable",
  slower: "slower",
  fastest: "fastest",
  pricier: "pricier",
  lowerCost: "lower cost",
  lowCost: "low cost",
  deeperReasoning: "deeper reasoning",
};

/** "GPT-6 Astra: most capable, slower", "Claude Opus 5 (recommended)". */
function englishName(label, hints) {
  const words = hints.filter((h) => h !== "recommended").map((h) => HINTS_EN[h] || h);
  return `${label}${words.length ? `: ${words.join(", ")}` : ""}${hints.includes("recommended") ? " (recommended)" : ""}`;
}
// `models` are the popular picks the phone shows before a key is checked, best
// first, as [id, name, ...hints]. Hints are codes the app words in its own
// language; `name` in the catalog is the English wording for older apps. Once a
// key is checked, the phone lists every model that key can use.
export const PROVIDERS = {
  gemini: {
    label: "Google Gemini",
    note: "Free key",
    keyUrl: "aistudio.google.com/apikey",
    adapter: "gemini",
    models: [
      ["auto", "Auto", "fastestAvailable", "recommended"],
      ["gemini-3.8-flash", "Gemini 3.8 Flash", "smartestFlash"],
      ["gemini-3.1-flash-lite", "Gemini 3.1 Flash-Lite", "quickest"],
      ["gemini-3.1-pro-preview", "Gemini 3.1 Pro", "deepThinking", "paidKeys"],
    ],
  },
  groq: {
    label: "Groq",
    note: "Free key, very fast",
    keyUrl: "console.groq.com/keys",
    adapter: "openai",
    models: [
      ["openai/gpt-oss-120b", "GPT-OSS 120B", "fast", "recommended"],
      ["openai/gpt-oss-20b", "GPT-OSS 20B", "faster"],
      ["llama-3.3-70b-versatile", "Llama 3.3 70B"],
      ["llama-3.1-8b-instant", "Llama 3.1 8B", "instant"],
    ],
    baseUrl: "https://api.groq.com/openai/v1",
    transcribe: { kind: "multipart", path: "/audio/transcriptions", models: ["whisper-large-v3-turbo", "whisper-large-v3"] },
    requestExtras: (model) => (/gpt-oss/.test(model) ? { reasoning_effort: "low" } : {}),
    listModels: (rows) => rows
      .filter((r) => r.active !== false && !/(whisper|guard|tts|orpheus|playai|distil|compound|allam)/i.test(r.id))
      .map((r) => ({ id: r.id, name: r.id })),
    defaults: [/^openai\/gpt-oss-120b$/, /^llama-3\.3-70b-versatile$/, /^openai\/gpt-oss-20b$/],
  },
  openai: {
    label: "OpenAI (ChatGPT)",
    keyUrl: "platform.openai.com/api-keys",
    adapter: "openai",
    models: [
      ["gpt-5.6-luna", "GPT-5.6 Luna", "fast", "recommended"],
      ["gpt-5.6-terra", "GPT-5.6 Terra", "balanced"],
      ["gpt-5.6-sol", "GPT-5.6 Sol", "flagship"],
      ["gpt-6-astra", "GPT-6 Astra", "mostCapable", "slower"],
    ],
    baseUrl: "https://api.openai.com/v1",
    transcribe: { kind: "multipart", path: "/audio/transcriptions", models: ["gpt-4o-mini-transcribe", "whisper-1"] },
    requestExtras: openaiExtras,
    listModels: openaiListModels,
    defaults: [/^gpt-5\.\d+-luna$/, /^gpt-5\.\d+-mini$/, /^gpt-5-mini$/, /^gpt-4\.1-mini$/, /^gpt-4o-mini$/],
  },
  anthropic: {
    label: "Anthropic (Claude)",
    note: "Needs a second key for voice",
    keyUrl: "console.anthropic.com/settings/keys",
    adapter: "anthropic",
    models: [
      // Sonnet first: smart and quick enough to talk to. Opus thinks longer than a
      // conversation on the glasses wants to wait.
      ["claude-sonnet-5", "Claude Sonnet 5", "fast", "recommended"],
      ["claude-haiku-4-5", "Claude Haiku 4.5", "fastest"],
      ["claude-opus-5", "Claude Opus 5", "slower"],
      ["claude-fable-5-1", "Claude Fable 5.1", "mostCapable", "pricier"],
    ],
  },
  xai: {
    label: "xAI (Grok)",
    keyUrl: "console.x.ai",
    adapter: "openai",
    models: [
      ["grok-4.6", "Grok 4.6", "recommended"],
      ["grok-4.5", "Grok 4.5"],
      ["grok-4.3", "Grok 4.3", "lowerCost"],
    ],
    baseUrl: "https://api.x.ai/v1",
    transcribe: { kind: "multipart", path: "/stt", models: [""], language: false },
    listModels: (rows) => rows
      .filter((r) => /^grok/i.test(r.id) && !/(image|video|voice|imagine|build|multi-agent|vision)/i.test(r.id))
      .map((r) => ({ id: r.id, name: r.id })),
    defaults: [/^grok-4\.6$/, /^grok-4\.5$/, /non-reasoning$/, /^grok-4/],
  },
  openrouter: {
    label: "OpenRouter",
    note: "Hundreds of models, one key",
    keyUrl: "openrouter.ai/keys",
    adapter: "openai",
    models: [
      ["google/gemini-3.8-flash", "Gemini 3.8 Flash", "fast", "recommended"],
      ["anthropic/claude-sonnet-5", "Claude Sonnet 5"],
      ["openai/gpt-5.6-luna", "GPT-5.6 Luna"],
      ["x-ai/grok-4.6", "Grok 4.6"],
      ["deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash", "lowCost"],
      ["moonshotai/kimi-k3", "Kimi K3"],
    ],
    baseUrl: "https://openrouter.ai/api/v1",
    extraHeaders: () => ({ ...(site() ? { "HTTP-Referer": site() } : {}), "X-Title": "EDITH" }),
    modelsUrl: "https://openrouter.ai/api/v1/models",
    modelsNeedKey: false,
    checkKey: openrouterCheckKey,
    transcribe: { kind: "chat-audio", pickModel: openrouterAudioModel },
    listModels: (rows) => rows
      .filter((r) =>
        (r.supported_parameters || []).includes("tools") &&
        (r.architecture?.output_modalities || ["text"]).includes("text") &&
        !/:(batch|online|extended)$/.test(r.id))
      .map((r) => ({ id: r.id, name: r.name || r.id }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    defaults: [/^google\/gemini-[\d.]+-flash$/, /^openai\/gpt-5\.\d+-luna$/, /^anthropic\/claude-sonnet-5$/],
  },
  deepseek: {
    label: "DeepSeek",
    note: "Needs a second key for voice",
    keyUrl: "platform.deepseek.com/api_keys",
    adapter: "openai",
    models: [
      ["deepseek-flash", "DeepSeek Flash", "fast", "recommended"],
      ["deepseek-v4-pro", "DeepSeek V4 Pro", "deeperReasoning"],
    ],
    baseUrl: "https://api.deepseek.com",
    echoReasoning: true,
    listModels: (rows) => rows.map((r) => ({ id: r.id, name: r.id })),
    defaults: [/^deepseek-flash$/, /^deepseek-chat$/],
  },
  // Anything that speaks the OpenAI API at an address the wearer gives: their own server,
  // a gateway like LiteLLM or vLLM, or a provider EDITH doesn't list yet. The address must
  // be public https, since EDITH's server is the one calling it, not the phone.
  mistral: {
    label: "Mistral",
    keyUrl: "console.mistral.ai/api-keys",
    adapter: "openai",
    models: [
      ["mistral-medium-latest", "Mistral Medium", "recommended"],
      ["mistral-small-latest", "Mistral Small", "faster"],
      ["mistral-large-latest", "Mistral Large"],
    ],
    baseUrl: "https://api.mistral.ai/v1",
    emptyAssistantContent: "",
    toolResultName: true,
    transcribe: { kind: "multipart", path: "/audio/transcriptions", models: ["voxtral-mini-latest"] },
    listModels: (rows) => rows
      .filter((r) =>
        r.capabilities?.completion_chat !== false &&
        r.capabilities?.function_calling !== false &&
        !r.deprecation &&
        !/(embed|ocr|moderation|voxtral|transcribe)/i.test(r.id))
      .map((r) => ({ id: r.id, name: r.id })),
    defaults: [/^mistral-medium-latest$/, /^mistral-small-latest$/, /^mistral-large-latest$/],
  },
  // Last in the list on purpose: the one for people who run their own AI.
  custom: {
    label: "Your own server",
    note: "Any OpenAI-compatible address",
    adapter: "openai",
    needsBase: true,
    keyOptional: true,
    models: [],
    baseUrl: "",
    listModels: (rows) => rows.map((r) => ({ id: r.id || r.name, name: r.id || r.name })).filter((m) => m.id),
    defaults: [/./],
  },
};

for (const [id, p] of Object.entries(PROVIDERS)) {
  p.id = id;
  p.voice = p.adapter === "gemini" || Boolean(p.transcribe);
  p.models = (p.models || []).map(([modelId, label, ...hints]) => ({ id: modelId, name: englishName(label, hints), label, hints }));
}

/** What the phone app shows in its provider and model pickers. */
export const publicCatalog = ({ ownServer = false } = {}) =>
  Object.values(PROVIDERS).filter((p) => ownServer || !p.needsBase).map(({ id, label, note, keyUrl, voice, models, needsBase, keyOptional }) => ({
    id,
    label,
    note: note || "",
    keyUrl,
    voice,
    models,
    defaultModel: models[0]?.id || "",
    ...(needsBase ? { needsBase: true } : {}),
    ...(keyOptional ? { keyOptional: true } : {}),
  }));

// Keys are printable and have no spaces; everything else is left to the provider to judge.
export const plausibleKey = (key) => /^[\x21-\x7e]{16,400}$/.test(key || "");

const KEY_PREFIXES = [
  ["anthropic", /^sk-ant-/],
  ["openrouter", /^sk-or-/],
  ["groq", /^gsk_/],
  ["xai", /^xai-/],
  ["gemini", /^(AIza|AQ\.)/],
];

/** The provider a key obviously belongs to, if it's a different one. */
export function keyBelongsElsewhere(providerId, key) {
  const match = KEY_PREFIXES.find(([, re]) => re.test(key));
  return match && match[0] !== providerId ? PROVIDERS[match[0]] : null;
}

/** An access descriptor for one provider and key. */
export const accessFor = (providerId, keys, model, baseUrl = "") => ({
  provider: providerId,
  keys,
  model: model || "",
  // Only for "custom": the OpenAI-compatible address the wearer gave.
  baseUrl,
  id: `${providerId}:${sha256(keys[0]).toString("hex").slice(0, 16)}`,
});

/** Validates a key and lists its models: { models, defaultModel }. */
export async function modelsFor(access) {
  const p = providerOf(access);
  if (p.adapter === "gemini") return geminiModels(access.keys[0]);
  if (p.adapter === "anthropic") return anthropicModels(access.keys[0]);
  return openaiModels(p, access.keys[0]);
}

/** The provider for an access, with the wearer's own address when they gave one. */
export const providerOf = (access) => {
  const p = PROVIDERS[access.provider];
  return access.baseUrl ? { ...p, baseUrl: String(access.baseUrl).replace(/\/+$/, "") } : p;
};

export const modelLabel = (access) => {
  const p = PROVIDERS[access.provider];
  return access.model && access.model !== "auto" ? `${access.model} (${p.label})` : p.label;
};

/** Starts a conversation with the access's provider. Fills in a default model if none was chosen. */
export async function startConversation(access, opts) {
  const p = providerOf(access);
  if (p.adapter === "gemini") return geminiConversation({ access, model: access.model, ...opts });
  const model = access.model || (await modelsFor(access)).defaultModel;
  if (!model) throw new ProviderError("model", `Pick a model for ${p.label} in EDITH's settings.`);
  if (p.adapter === "anthropic") return anthropicConversation({ key: access.keys[0], model, ...opts });
  return openaiConversation({ provider: p, key: access.keys[0], model, ...opts });
}

/** Turns speech into text, expecting the language with this code if one is given. */
export async function transcribe(access, audio, signal, language = "") {
  const p = providerOf(access);
  const languageName = LANGUAGES[language]?.name || "";
  if (p.adapter === "gemini") return geminiTranscribe({ access, audio, signal, languageName });
  if (!p.transcribe) throw new ProviderError("voice", `EDITH can't hear with ${p.label}.`);
  return openaiTranscribe({ provider: p, key: access.keys[0], audio, signal, language, languageName });
}

export { pickDefault };
