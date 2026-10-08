// Anthropic Claude through the official SDK, with the user's own key.

import Anthropic from "@anthropic-ai/sdk";
import { ProviderError } from "../http.mjs";

const LABEL = "Anthropic";

// Models that accept output_config.effort. Low effort keeps glasses answers quick.
const EFFORT_MODELS = /^claude-(opus-(4-[5-9]|5)|sonnet-(4-6|5)|fable-5|mythos-5)/;
// Models that support server-side refusal fallbacks ("default" routing).
const FALLBACK_MODELS = /^claude-(opus-5|fable-5-1)$/;

const clientFor = (key) => new Anthropic({ apiKey: key, maxRetries: 1, timeout: 45_000 });

function toProviderError(err) {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new ProviderError("timeout", "Stopped before the answer finished.");
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError("key", "Anthropic rejected this API key.", err.status);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new ProviderError("quota", "Anthropic says this key is out of quota or credits for now.", err.status);
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new ProviderError("model", "Anthropic can't use that model with this key.", err.status);
  }
  if (err instanceof Anthropic.InternalServerError) {
    return new ProviderError("overloaded", "Anthropic is busy right now. Try again in a moment.", err.status);
  }
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError("network", "Couldn't reach Anthropic.");
  if (err instanceof Anthropic.APIError) {
    return new ProviderError("other", `Anthropic error ${err.status}: ${err.message}`.slice(0, 300), err.status);
  }
  return new ProviderError("other", `Anthropic error: ${err?.message || err}`);
}

/**
 * After a mid-output fallback, blocks before the last fallback marker that only
 * the declining model understands must not be echoed back.
 */
function echoable(content) {
  const boundary = content.map((b) => b.type).lastIndexOf("fallback");
  if (boundary < 0) return content;
  const dropBefore = new Set(["thinking", "redacted_thinking", "tool_use", "server_tool_use"]);
  return content.filter((b, i) => b.type !== "fallback" && (i > boundary || !dropBefore.has(b.type)));
}

/**
 * A conversation turn loop. next() streams one model turn, calling onText for
 * each piece of answer text, and returns { text, toolCalls }.
 */
export function anthropicConversation({ key, model, system, history, userText, image, tools, signal }) {
  const client = clientFor(key);
  const messages = [
    ...history.map((h) => ({ role: h.role === "assistant" ? "assistant" : "user", content: h.text })),
    // A photo taken on the phone travels with the question it belongs to (1.7.0).
    {
      role: "user",
      content: image
        ? [{ type: "image", source: { type: "base64", media_type: image.mime, data: image.data } }, { type: "text", text: userText }]
        : userText,
    },
  ];
  const toolDefs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  let lastContent = null;

  return {
    model,
    async next({ onText }) {
      const params = {
        model,
        max_tokens: 16000,
        system,
        ...(toolDefs.length ? { tools: toolDefs } : {}),
        messages,
        ...(EFFORT_MODELS.test(model) ? { output_config: { effort: "low" } } : {}),
      };
      try {
        const stream = FALLBACK_MODELS.test(model)
          ? client.beta.messages.stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }, { signal })
          : client.messages.stream(params, { signal });
        stream.on("text", (delta) => onText(delta));
        const message = await stream.finalMessage();

        const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
        if (message.stop_reason === "refusal") {
          if (!text) throw new ProviderError("refused", "Claude declined to answer that.");
          return { text, toolCalls: [] };
        }
        const calls = message.content
          .filter((b) => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, args: b.input || {} }));
        lastContent = calls.length ? echoable(message.content) : null;
        return { text, toolCalls: calls };
      } catch (err) {
        throw toProviderError(err);
      }
    },
    addToolResults(calls, results) {
      if (lastContent) messages.push({ role: "assistant", content: lastContent });
      lastContent = null;
      messages.push({
        role: "user",
        content: calls.map((c, i) => ({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(results[i]) })),
      });
    },
  };
}

/** Validates a key and lists the Claude models it can use. */
export async function anthropicModels(key) {
  try {
    const page = await clientFor(key).models.list({ limit: 100 });
    const models = page.data.map((m) => ({ id: m.id, name: m.display_name || m.id }));
    const defaultModel = models.find((m) => m.id === "claude-sonnet-5")?.id || models[0]?.id || "";
    return { models, defaultModel };
  } catch (err) {
    throw toProviderError(err);
  }
}
