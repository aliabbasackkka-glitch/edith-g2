// Providers that speak the OpenAI Chat Completions format: OpenAI, xAI, Groq,
// OpenRouter, DeepSeek and Mistral. Per-provider details live in the catalog
// (providers/index.mjs); this file only knows the wire format.

import {
  ProviderError,
  cleanTranscript,
  errorMessage,
  providerError,
  providerErrorFrom,
  readSse,
  request,
  transcribeInstruction,
  wavFile,
} from "../http.mjs";

/**
 * What to call this provider when something goes wrong. A server of the wearer's own
 * has no brand name, so it is known by its address (1.7.4).
 */
const nameOf = (provider) => {
  if (!provider.needsBase) return provider.label;
  try {
    return `your server at ${new URL(provider.baseUrl).host}`;
  } catch {
    return "your server";
  }
};

const authHeaders = (provider, key) => ({
  // A server of the wearer's own may want no key at all; sending an empty one upsets some.
  ...(key ? { Authorization: `Bearer ${key}` } : {}),
  ...(typeof provider.extraHeaders === "function" ? provider.extraHeaders() : provider.extraHeaders || {}),
});

const parseArgs = (raw) => {
  if (raw && typeof raw === "object") return raw;
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
};

/**
 * A conversation turn loop. next() streams one model turn, calling onText for
 * each piece of answer text, and returns { text, toolCalls }.
 */
export function openaiConversation({ provider, key, model, system, history, userText, image, tools, signal }) {
  const messages = [
    { role: "system", content: system },
    ...history.map((h) => ({ role: h.role === "assistant" ? "assistant" : "user", content: h.text })),
    // A photo taken on the phone travels with the question it belongs to (1.7.0).
    {
      role: "user",
      content: image
        ? [{ type: "text", text: userText }, { type: "image_url", image_url: { url: `data:${image.mime};base64,${image.data}` } }]
        : userText,
    },
  ];
  const toolDefs = tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  // Optional speed settings some models reject; dropped after the first refusal.
  let optional = provider.requestExtras?.(model) || {};
  let pendingAssistant = null;

  async function open() {
    for (;;) {
      const res = await request(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...authHeaders(provider, key) },
        body: JSON.stringify({ model, messages, ...(toolDefs.length ? { tools: toolDefs } : {}), stream: true, ...optional }),
        signal,
      }, nameOf(provider), provider.needsBase);
      if (res.ok) return res;
      const text = await res.text().catch(() => "");
      const rejectedOptional = Object.keys(optional).filter((k) => text.includes(k));
      if (res.status === 400 && rejectedOptional.length) {
        optional = Object.fromEntries(Object.entries(optional).filter(([k]) => !rejectedOptional.includes(k)));
        continue;
      }
      throw providerError(res.status, text, nameOf(provider), provider.needsBase);
    }
  }

  return {
    model,
    async next({ onText }) {
      const res = await open();
      let text = "";
      let reasoning = "";
      const slots = [];
      for await (const { data } of readSse(res)) {
        if (data === "[DONE]") break;
        let chunk;
        try { chunk = JSON.parse(data); } catch { continue; }
        if (chunk.error) throw new ProviderError("other", `${nameOf(provider)}: ${errorMessage(JSON.stringify(chunk))}`);
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (!delta) continue;
        if (typeof delta.content === "string" && delta.content) {
          text += delta.content;
          onText(delta.content);
        }
        if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
        for (const tc of delta.tool_calls || []) {
          const slot = (slots[tc.index ?? slots.length] ||= { id: "", name: "", arguments: "" });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name ||= tc.function.name;
          const args = tc.function?.arguments;
          if (args) slot.arguments += typeof args === "string" ? args : JSON.stringify(args);
        }
        if (choice.finish_reason === "content_filter" && !text && !slots.length) {
          throw new ProviderError("refused", `${nameOf(provider)} declined to answer that.`);
        }
      }

      const calls = slots.filter((s) => s && s.name).map((s, n) => ({ ...s, id: s.id || `call${n + 1}` }));
      pendingAssistant = calls.length
        ? {
            role: "assistant",
            content: text || (provider.emptyAssistantContent ?? null),
            tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments || "{}" } })),
            ...(provider.echoReasoning && reasoning ? { reasoning_content: reasoning } : {}),
          }
        : null;
      return { text, toolCalls: calls.map((c) => ({ id: c.id, name: c.name, args: parseArgs(c.arguments) })) };
    },
    addToolResults(calls, results) {
      if (pendingAssistant) messages.push(pendingAssistant);
      pendingAssistant = null;
      calls.forEach((c, i) => {
        messages.push({
          role: "tool",
          tool_call_id: c.id,
          content: JSON.stringify(results[i]),
          ...(provider.toolResultName ? { name: c.name } : {}),
        });
      });
    },
  };
}

/**
 * Transcribes a WAV clip with the provider's speech-to-text service. language is an
 * ISO-639-1 code ("ja") and languageName its name ("Japanese"), both optional.
 */
export async function openaiTranscribe({ provider, key, audio, signal, language = "", languageName = "" }) {
  const stt = provider.transcribe;
  if (stt.kind === "multipart") {
    for (const model of stt.models) {
      const form = new FormData();
      if (model) form.append("model", model);
      if (language && stt.language !== false) form.append("language", language);
      form.append("file", wavFile(audio.data)); // xAI requires the file to be the last field
      const res = await request(`${provider.baseUrl}${stt.path}`, {
        method: "POST",
        headers: authHeaders(provider, key),
        body: form,
        signal,
      }, nameOf(provider), provider.needsBase);
      if (res.ok) return cleanTranscript((await res.json()).text);
      const err = await providerErrorFrom(res, nameOf(provider), provider.needsBase);
      if (err.kind === "model" && model !== stt.models.at(-1)) continue;
      throw err;
    }
  }
  if (stt.kind === "chat-audio") {
    const model = await stt.pickModel(signal);
    const res = await request(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(provider, key) },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: transcribeInstruction(languageName) },
          { role: "user", content: [{ type: "input_audio", input_audio: { data: audio.data, format: "wav" } }] },
        ],
      }),
      signal,
    }, nameOf(provider), provider.needsBase);
    if (!res.ok) throw await providerErrorFrom(res, nameOf(provider), provider.needsBase);
    const d = await res.json();
    return cleanTranscript(d.choices?.[0]?.message?.content);
  }
  throw new ProviderError("voice", `EDITH can't hear with ${nameOf(provider)}.`);
}

/** Validates a key and lists the chat models it can use. */
export async function openaiModels(provider, key) {
  if (provider.checkKey) await provider.checkKey(key);
  const res = await request(provider.modelsUrl || `${provider.baseUrl}/models`, {
    headers: provider.modelsNeedKey === false ? {} : authHeaders(provider, key),
    signal: AbortSignal.timeout(8000),
  }, nameOf(provider), provider.needsBase);
  if (!res.ok) throw await providerErrorFrom(res, nameOf(provider), provider.needsBase);
  const body = await res.json();
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  const models = provider.listModels(rows);
  return { models, defaultModel: pickDefault(models, provider.defaults) };
}

/** The newest model matching the first preference that matches anything, else the first listed. */
export function pickDefault(models, preferences = []) {
  for (const re of preferences) {
    const hits = models.filter((m) => re.test(m.id));
    if (hits.length) return hits.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))[0].id;
  }
  return models[0]?.id || "";
}
