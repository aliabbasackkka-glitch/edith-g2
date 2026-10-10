/**
 * EDITH backend: every /api/* route, as one Request -> Response handler that runs
 * on Cloudflare Workers (worker/index.mjs) and Netlify Functions
 * (netlify/functions/api.mjs). Each host passes its storage to configureServer().
 *
 * Who pays for the AI: everyone brings their own key for the AI provider they pick
 * (Gemini, OpenAI, Claude, Grok, Groq, OpenRouter, DeepSeek, Mistral, or their own
 * OpenAI-compatible server), sent per request as X-AI-Provider / X-AI-Key / X-AI-Model
 * (and X-AI-Base for their own server) and, for voice, X-Voice-Provider / X-Voice-Key.
 * Keys are used for that request only and never stored or logged. EDITH 1.0.x sends a
 * Gemini key as X-Gemini-Key, which still works.
 *
 * Routes:  POST   /api/chat         { history, text | audio, localTime }
 *                                   JSON reply, or NDJSON events with Accept: application/x-ndjson
 *          GET    /api/providers    the AI providers the phone app can offer
 *          POST   /api/check-key    validates a key and lists its models
 *          GET    /api/models       lists the models for the provider in the headers
 *          GET    /api/memory       |  DELETE /api/memory
 *          GET    /api/history      |  DELETE /api/history
 *          POST   /api/device       { id }
 *          GET    /api/status       configuration health, never the keys themselves
 *          GET    /api/chats        saved chats, newest first
 *          POST   /api/chats/search { q }: the chats whose title or words match
 *          GET    /api/chats/<id>   |  DELETE /api/chats/<id>  |  DELETE /api/chats (every chat)
 *          POST   /api/transcribe   { audio } -> { text }: the words so far, shown while recording
 *          POST   /api/room         { audio, spoken, translateTo } -> subtitles of someone else talking
 *          POST   /api/calendar     { url } -> the iCal file at one of the wearer's calendar links
 *          GET    /api/glance       ?at=lat,lon -> the weather for the glasses dashboard
 *          POST   /api/confirm      { token, home }: carries out what the wearer tapped to confirm
 *   EDITH 3 (beta), the PC app as the glasses' agent (lib/agent.mjs):
 *          POST   /api/agent/hello  { pcId, secret, name, os } -> a code to link, or { linked }
 *          POST   /api/agent/next   { pcId, secret }  -> the next job for this PC (held ~20 s)
 *          POST   /api/agent/done   { pcId, secret, jobId, result }
 *          POST   /api/agent/forget { pcId, secret }  unlinks and forgets this PC
 *
 * EDITH 1.5.0 and later send a chatId (saved chats, lib/chats.mjs) and answer preferences
 * (style, instructions, specialist, translateTo; lib/prefs.mjs) with each question.
 * EDITH's website and PC app also send surface: "web" or "desktop", which words the system
 * prompt for a screen instead of the glasses (lib/persona.mjs); without it, it is the glasses.
 *
 * EDITH 1.6.0 and later also send what the phone has: X-Edith-Location (rounded coordinates,
 * used and not stored), the events it read from the wearer's calendar, their Home Assistant
 * address and token, and their own actions (webhooks). Those decide which tools are offered
 * (lib/tools.mjs toolsFor), and answers can come back with countdowns for the glasses or
 * something for the wearer to tap to confirm (lib/home.mjs).
 *
 * X-Edith-Language (en, de, fr, es, it, zh, ja, ko, ar) sets the language of answers,
 * speech recognition, news and Wikipedia; see lib/languages.mjs.
 *
 * Accounts (lib/accounts.mjs):
 *          GET    /api/account/config         whether sign-in is on, and the public Firebase settings
 *          POST   /api/account/link/start     a code to sign this phone in with
 *          GET    /api/account/link/check     ?code=  (the sign-in page)
 *          POST   /api/account/link/confirm   { code, idToken }  (the sign-in page)
 *          POST   /api/account/link/poll      { code, pollToken } -> the session, once signed in
 *          GET    /api/account                who is signed in, with their synced settings and keys
 *          POST   /api/account/profile        { profile, updatedAt }
 *          POST   /api/account/signout  |  POST /api/account/delete
 *
 * Connecting OpenRouter without an API key (lib/connect.mjs):
 *          POST   /api/connect/openrouter/start      a link to open in the phone's browser
 *          GET    /api/connect/openrouter/<id>       -> OpenRouter, to approve EDITH
 *          GET    /api/connect/openrouter/<id>/done  <- OpenRouter's code
 *          POST   /api/connect/openrouter/poll       { id, pollToken } -> the key, once
 *
 * Memory and history are scoped by the X-Device-Id header, or by the account when
 * X-Edith-Session is sent, and kept in the host's storage: D1 on Cloudflare, Netlify
 * Blobs on Netlify. An account's key (acct_...) is never accepted as a device id, and a
 * request without a device id shares no storage with anyone (lib/storage.mjs).
 *
 * Limits, per network (an IPv4 address, or an IPv6 /64):
 *   relays         /api/action, /api/calendar, /api/check-key: 30 per 10 minutes
 *   moderation     120 reviews an hour per network and per phone
 * Addresses someone else chose (calendars, Home Assistant, actions, links, their own AI
 * server) are fetched through lib/net.mjs: public https only, redirects checked hop by hop.
 */

import crypto from "node:crypto";
import {
  AccountError,
  accountConfig,
  accountSummary,
  accountsEnabled,
  checkLink,
  confirmLink,
  deleteAccount,
  endSession,
  pollLink,
  saveProfile,
  sessionFor,
  startLink,
} from "./lib/accounts.mjs";
import { appendToChat, cleanChatId, deleteAllChats, deleteChat, getChat, listChats, remember, searchChats, setChatTitle } from "./lib/chats.mjs";
import { connectCallback, connectRedirect, pollConnect, startConnect } from "./lib/connect.mjs";
import { cleanActions, cleanHome, confirmHome, publicHttps, runAction } from "./lib/home.mjs";
import { confirmPc, linkedPc, pcDone, pcForget, pcHello, pcNext } from "./lib/agent.mjs";
import { cityAt, readLocation } from "./lib/places.mjs";
import { ProviderError } from "./lib/http.mjs";
import { LANGUAGES, languageOf } from "./lib/languages.mjs";
import { moderationOn, pendingWarning, review, warningFor } from "./lib/moderation.mjs";
import { clearLists, getLists, saveList } from "./lib/lists.mjs";
import { UnsafeAddressError, publicFetch } from "./lib/net.mjs";
import { buildSystemPrompt } from "./lib/persona.mjs";
import { answerPrefs, cleanCalendarEvents, surfaceOf } from "./lib/prefs.mjs";
import {
  PROVIDERS,
  accessFor,
  keyBelongsElsewhere,
  modelLabel,
  modelsFor,
  openrouterFreeTier,
  plausibleKey,
  publicCatalog,
  startConversation,
  transcribe,
} from "./lib/providers/index.mjs";
import {
  allowRate,
  appendHistory,
  banOn,
  cleanDeviceId,
  clearHistory,
  clearMemories,
  clientNetwork,
  deviceKey,
  getHistory,
  getMemories,
  isBlocked,
  readJSON,
  storageKind,
  useStorage,
  writeJSON,
} from "./lib/storage.mjs";
import { runTool, toolsFor, weather } from "./lib/tools.mjs";
import { MAX_SPEAK_CHARS, hasVoices, speak } from "./lib/voices.mjs";

let host = "local";

/**
 * Called once by the host before it hands over requests.
 *   host            "cloudflare" or "netlify", shown by /api/status
 *   storage         where memories and history live (see lib/storage.mjs)
 *   clientIpHeader  the header the host sets to the caller's IP
 */
export function configureServer(options = {}) {
  host = options.host || host;
  useStorage(options.storage || null, { clientIpHeader: options.clientIpHeader });
}

const corsHeaders = () => ({
  "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, X-Device-Id, X-Edith-Session, X-Edith-Language, X-Edith-Location, X-Gemini-Key, X-AI-Provider, X-AI-Key, X-AI-Model, X-AI-Base, X-Edith-Can, X-Voice-Provider, X-Voice-Key",
  "Access-Control-Expose-Headers": "X-Edith-Session",
  "Access-Control-Max-Age": "86400",
});

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsHeaders(), ...headers },
  });

/** A session that was signed out or deleted elsewhere: the phone should sign out too. */
const sessionEnded = () =>
  json({ error: "This phone was signed out of its EDITH account.", kind: "session" }, 401, { "X-Edith-Session": "ended" });

// Finish well inside the strictest host limit (Netlify: 60 seconds), with a clear message instead of a cut-off.
const DEADLINE_MS = 50_000;
// A job on the wearer's PC can take several steps on the computer (EDITH 3).
const PC_DEADLINE_MS = 120_000;
// What the glasses heard, sent with a question about it: roughly an hour of talking (1.8.0).
const MAX_HEARD = 24_000;
const MAX_IMAGE_B64 = 1_800_000; // about 1.3 MB of JPEG: plenty for a 1024 px photo
const MAX_TURNS = 6;
const MAX_PC_TURNS = 12;
const HOUR_MS = 60 * 60 * 1000;

const NEEDS_KEY = { error: "EDITH needs an AI key. Add one in EDITH's settings on your phone.", needsKey: true, kind: "key" };

/* ── access ─────────────────────────────────────────────────────────────── */
function resolveAccess(req) {
  const h = (name) => (req.headers.get(name) || "").trim();

  let provider = h("x-ai-provider").toLowerCase();
  let key = h("x-ai-key");
  const model = h("x-ai-model").slice(0, 200);
  if (!provider && h("x-gemini-key")) {
    provider = "gemini"; // EDITH 1.0.x
    key = h("x-gemini-key");
  }

  // "Your own server": the OpenAI-compatible address the wearer gave, which EDITH's server
  // has to be able to reach, so it must be public https (never a LAN or localhost address).
  const base = PROVIDERS[provider]?.needsBase ? publicHttps(h("x-ai-base"))?.href || "" : "";
  const keyIsFine = plausibleKey(key) || (PROVIDERS[provider]?.keyOptional && !key);

  let chat = null;
  if (PROVIDERS[provider]?.needsBase) chat = base && keyIsFine ? accessFor(provider, [key], model, base) : null;
  else if (PROVIDERS[provider] && plausibleKey(key)) chat = accessFor(provider, [key], model);

  // Voice: the wearer's voice key if they gave one, otherwise the chat AI when it can hear.
  const voiceProvider = h("x-voice-provider").toLowerCase();
  const voiceKey = h("x-voice-key");
  let voice = null;
  if (PROVIDERS[voiceProvider]?.voice && plausibleKey(voiceKey)) voice = accessFor(voiceProvider, [voiceKey]);
  else if (chat && PROVIDERS[chat.provider].voice) voice = chat;

  return { chat, voice };
}

function errorPayload(err, access) {
  if (!(err instanceof ProviderError)) {
    console.error("chat failed:", err?.message || err);
    return { status: 500, payload: { error: "EDITH's server hit an error.", kind: "other" } };
  }
  switch (err.kind) {
    case "key":
      return { status: 401, payload: { error: `${err.message} Check it in EDITH's settings.`, kind: "key", needsKey: true } };
    case "quota":
      return { status: 502, payload: { error: err.message, kind: "quota" } };
    case "unclear":
      return { status: 422, payload: { error: "Didn't catch that.", kind: "unclear" } };
    case "voice":
      return {
        status: 400,
        payload: { error: `${err.message} Add a Groq, Gemini or OpenAI key for voice in EDITH's settings.`, kind: "voice", needsVoiceKey: true },
      };
    case "timeout":
      return { status: 504, payload: { error: "That took too long. Try again.", kind: "timeout" } };
    default:
      return { status: 502, payload: { error: err.message, kind: err.kind, provider: access?.chat?.provider } };
  }
}

/* ── chat ───────────────────────────────────────────────────────────────── */

/** The client's history as alternating user/assistant text, starting with the user and ending with EDITH. */
function normaliseHistory(raw) {
  const turns = [];
  for (const h of Array.isArray(raw) ? raw.slice(-20) : []) {
    const role = h?.role === "model" || h?.role === "assistant" ? "assistant" : "user";
    const text = (Array.isArray(h?.parts) ? h.parts.map((p) => p?.text || "").join(" ") : String(h?.content || "")).trim();
    if (!text) continue;
    const prev = turns[turns.length - 1];
    if (prev && prev.role === role) prev.text += `\n${text}`;
    else turns.push({ role, text: text.slice(0, 4000) });
  }
  while (turns.length && turns[0].role !== "user") turns.shift();
  while (turns.length && turns[turns.length - 1].role !== "assistant") turns.pop();
  return turns;
}

/**
 * What this phone brings to a question (EDITH 1.6.0 and later): where the wearer is, what
 * their phone read from their calendar, their smart home and their own actions. `can` decides
 * which tools are offered: saved chats can be recalled, older apps have none to search.
 */
function worldFrom(req, body, chatId, surface = "glasses") {
  const location = readLocation(req.headers.get("x-edith-location"));
  const calendar = cleanCalendarEvents(body.calendar);
  // Countdowns, alarms, lists, choices and home confirmations live on the glasses: the
  // website and the PC app have none of them, so their tools are never offered there.
  const glasses = surface === "glasses";
  const home = glasses ? cleanHome(body.home) : null;
  const actions = cleanActions(body.actions);
  const features = glasses && Array.isArray(body.can) ? body.can : [];
  return {
    location,
    calendar,
    home,
    actions,
    can: {
      recall: Boolean(chatId),
      location: Boolean(location),
      calendar: calendar.length > 0,
      timers: features.includes("timers"),
      // EDITH 1.7.0: alarms for a time of day, lists on the glasses, choices to tap.
      alarms: features.includes("alarms"),
      lists: features.includes("lists"),
      pick: features.includes("pick"),
      home: Boolean(home),
      actions: actions.length > 0,
    },
    surface,
  };
}

/** One answer from one provider: the model's turns and any tool calls in between. */

async function converse({ chat, body, uk, userText, image, memories, history, emit, signal, language, prefs, world }) {
  // What the glasses heard other people say, when the question is about that (1.8.0).
  // Capped: a long meeting is summarised from its most recent part, not refused.
  const heard = String(body.heard || "").trim().slice(-MAX_HEARD);
  const system = buildSystemPrompt({
    memories,
    localTime: body.localTime,
    modelLabel: modelLabel(chat),
    language,
    ...prefs,
    can: world.can,
    heard,
    surface: world.surface,
  });
  const convo = await startConversation(chat, { system, history, userText, image, tools: toolsFor(world.can), signal });

  const flags = { memoryChanged: false, timers: [], cancelTimers: false, confirm: null, list: null, pick: null };
  const toolsUsed = [];
  let reply = "";
  // A job on the PC takes several steps (write the page, then open it), so it gets more.
  const turns = world.can.pc ? MAX_PC_TURNS : MAX_TURNS;
  for (let turn = 0; turn < turns; turn++) {
    emit({ type: "status", stage: "thinking" });
    let streamedText = false;
    const out = await convo.next({
      onText: (delta) => {
        streamedText = true;
        emit({ type: "delta", text: delta });
      },
    });
    if (!out.toolCalls.length) {
      reply = out.text.trim();
      break;
    }
    if (streamedText) emit({ type: "reset" });
    emit({ type: "tool", names: out.toolCalls.map((c) => c.name) });
    const results = await Promise.all(out.toolCalls.map((c) => {
      toolsUsed.push(c.name);
      return runTool(c.name, c.args, {
        uk,
        flags,
        localTime: body.localTime,
        language,
        location: world.location,
        calendar: world.calendar,
        home: world.home,
        actions: world.actions,
      });
    }));
    convo.addToolResults(out.toolCalls, results);
  }
  return {
    reply: reply || "I'm not sure how to answer that.",
    model: convo.model,
    toolsUsed: [...new Set(toolsUsed)],
    memoryChanged: flags.memoryChanged,
    // For the phone: countdowns to run, and anything waiting for a tap on the glasses.
    ...(flags.timers.length ? { timers: flags.timers } : {}),
    ...(flags.cancelTimers ? { cancelTimers: true } : {}),
    ...(flags.confirm ? { confirm: flags.confirm } : {}),
    // A list to show and tick off, or a choice to tap, on the glasses (1.7.0).
    ...(flags.list ? { list: flags.list } : {}),
    ...(flags.pick ? { pick: flags.pick } : {}),
  };
}

/** Transcribes (if audio) and answers. */
async function runChat({ access, body, text, audio, image, uk, emit, signal, language, prefs, chatId, world }) {
  // Memories are read while the audio is being transcribed, not after: storage can be a
  // continent away from where the request lands, and every wait shows on the glasses.
  const memoriesRead = getMemories(uk);
  let spoken = "";
  if (audio) {
    emit({ type: "status", stage: "transcribing" });
    spoken = await transcribe(access.voice, audio, signal, language);
    if (!spoken) throw new ProviderError("unclear", "Didn't catch that.");
    emit({ type: "transcript", text: spoken });
  }
  const userText = [text, spoken].filter(Boolean).join(" ").trim();
  const memories = await memoriesRead;
  const history = normaliseHistory(body.history);

  const chat = access.chat;
  const answer = await converse({ chat, body, uk, userText, image, memories, history, emit, signal, language, prefs, world });
  // Saving the question and answer happens after the reply has gone (see handleChat):
  // the phone already has both, and sends the conversation along with the next question.
  const save = chatId
    ? () => appendToChat(uk, chatId, { userText, reply: answer.reply, specialist: prefs.specialist })
    : () => appendHistory(uk, [
        { role: "user", content: userText },
        { role: "model", content: answer.reply },
      ]).then(() => ({ needsTitle: false }));
  const prior = (Array.isArray(body.history) ? body.history : []).slice(-20);
  return {
    ...answer,
    userText,
    history: [...prior, { role: "user", parts: [{ text: userText }] }, { role: "model", parts: [{ text: answer.reply }] }],
    provider: chat.provider,
    chatId: chatId || undefined,
    save,
  };
}

const TITLE_TIMEOUT_MS = 15_000;

/** Names a chat in two to five words, in the wearer's language, with the AI that answered it. */
async function titleChat({ access, uk, chatId, language }) {
  const chat = await getChat(uk, chatId);
  if (!chat) return;
  const excerpt = chat.messages
    .slice(-12)
    .map((m) => `${m.role === "user" ? "User" : "EDITH"}: ${String(m.content).slice(0, 400)}`)
    .join("\n");
  const languageName = LANGUAGES[language]?.name;
  const system = "You name conversations for a list. Reply with only a title of two to five words" +
    (languageName ? ` in ${languageName}` : "") + ". No quotes, no emoji, no punctuation at the end.";
  try {
    const convo = await startConversation(access, { system, history: [], userText: excerpt, tools: [], signal: AbortSignal.timeout(TITLE_TIMEOUT_MS) });
    const out = await convo.next({ onText: () => {} });
    const title = String(out.text || "")
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean)
      ?.replace(/^["'“”«»\s]+|["'“”«».!?\s]+$/g, "");
    if (title) await setChatTitle(uk, chatId, title);
  } catch {
    // A title is a nicety: a chat the AI couldn't name still works without one.
  }
}

/** Runs a chat job and streams its events as NDJSON lines. */
function streamed(job, access, requestSignal, deadlineMs = DEADLINE_MS) {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  requestSignal?.addEventListener?.("abort", () => abort.abort(), { once: true });

  const body = new ReadableStream({
    async start(controller) {
      let open = true;
      const emit = (event) => {
        if (!open) return;
        try { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); } catch { open = false; }
      };
      // Pings keep proxies from closing a quiet connection during slow tool calls.
      const ping = setInterval(() => emit({ type: "ping" }), 5000);
      const deadline = setTimeout(() => abort.abort(), deadlineMs);
      try {
        emit({ type: "done", ...(await job(emit, abort.signal)) });
      } catch (err) {
        const failure = abort.signal.aborted && !(err instanceof ProviderError) ? new ProviderError("timeout", "") : err;
        emit({ type: "error", ...errorPayload(failure, access).payload });
      } finally {
        clearInterval(ping);
        clearTimeout(deadline);
        open = false;
        try { controller.close(); } catch {}
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders() },
  });
}

// Questions moderation judges per network and per phone each hour; beyond that they go unjudged.
const MODERATION_PER_HOUR = 120;

/**
 * Has moderation judge a question (with what was heard and the conversation so far), unless
 * this network or this phone has already had its share of judging this hour.
 */
async function reviewWithinBudget(req, uk, text, context) {
  if (uk === "anon") return null;
  const [byNetwork, byPhone] = await Promise.all([
    allowRate(`rate/moderation/net/${clientNetwork(req)}`, MODERATION_PER_HOUR, HOUR_MS),
    allowRate(`rate/moderation/phone/${uk}`, MODERATION_PER_HOUR, HOUR_MS),
  ]);
  if (!byNetwork || !byPhone) return null;
  return review(uk, text, context);
}

async function handleChat(req, body, uk, device, background) {
  // Both bans are looked up at once: each read can cross a continent.
  const [accountBan, deviceBan] = await Promise.all([banOn(uk), device !== uk ? banOn(device) : null]);
  const ban = accountBan || deviceBan;
  if (ban) {
    // Being told why is the whole point: a phone blocked for asking how to build a weapon
    // should read that, not a shrug (1.8.0).
    return json({ error: "This phone is banned from EDITH.", kind: "blocked", ...(ban.why ? { why: ban.why } : {}) }, 403);
  }

  const access = resolveAccess(req);
  const text = typeof body.text === "string" ? body.text.slice(0, 4000) : "";
  const audio = body.audio?.data ? { mime: String(body.audio.mime || "audio/wav"), data: String(body.audio.data) } : null;
  // A photo to ask about (1.7.0). The phone makes it small first; anything bigger is refused
  // rather than sent on to the provider.
  const image = body.image?.data ? { mime: String(body.image.mime || "image/jpeg"), data: String(body.image.data) } : null;
  if (image && (image.data.length > MAX_IMAGE_B64 || !/^image\/(jpeg|png|webp|heic|heif)$/.test(image.mime))) {
    return json({ error: "That photo is too big to send. Try another one.", kind: "other" }, 413);
  }

  if (!access.chat) return json(NEEDS_KEY, 401);
  if (!text && !audio) return json({ error: "Nothing to send.", kind: "other" }, 400);
  if (audio && !access.voice) {
    const { status, payload } = errorPayload(
      new ProviderError("voice", `EDITH can't hear with ${PROVIDERS[access.chat.provider].label}.`), access);
    return json(payload, status);
  }

  const language = languageOf(req);
  const prefs = answerPrefs(body);
  const chatId = cleanChatId(body.chatId);
  const world = worldFrom(req, body, chatId, surfaceOf(body));
  if (world.surface === "glasses") {
    // EDITH 3: the glasses can link the wearer's PC, and use it once linked.
    const pc = await linkedPc(uk).catch(() => null);
    world.can.pcLinkable = true;
    world.can.pc = pc ? pc.name || "PC" : false;
  }
  const job = async (emit, signal) => {
    // Flagged since they last asked something? They hear about it with this answer, once
    // (1.8.0). Read alongside the answer so it never holds the answer up.
    const warningRead = pendingWarning(uk).catch(() => null);
    const result = await runChat({ access, body, text, audio, image, uk, emit, signal, language, prefs, chatId, world });
    // Checked after the answer has gone, on its own key, so nobody waits for it and
    // nobody's own quota is spent judging them (1.8.0) - within a budget per network
    // and per phone, so nobody can run up the server's moderation bill either.
    if (moderationOn()) {
      background(reviewWithinBudget(req, uk, result.userText, { heard: body.heard, history: body.history }));
    }
    // Saved after the reply, then remembered and named in that order.
    const { save } = result;
    background(save().then(async ({ needsTitle }) => {
      if (!chatId) return;
      await remember(uk, chatId, result.userText, result.reply);
      if (needsTitle) await titleChat({ access: access.chat, uk, chatId, language });
    }));
    delete result.save;
    const warned = await warningRead;
    if (warned) {
      result.warning = warned;
      background(warningFor(uk)); // said now, so it's cleared
    }
    return result;
  };
  const deadlineMs = world.can.pc ? PC_DEADLINE_MS : DEADLINE_MS;
  if ((req.headers.get("accept") || "").includes("application/x-ndjson")) return streamed(job, access, req.signal, deadlineMs);

  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), deadlineMs);
  try {
    return json(await job(() => {}, abort.signal));
  } catch (err) {
    const { status, payload } = errorPayload(err, access);
    return json(payload, status);
  } finally {
    clearTimeout(deadline);
  }
}

/* ── saved chats and live words ─────────────────────────────────────────── */

async function handleChats(req, parts, uk, body) {
  if (uk === "anon") return json({ error: "Missing X-Device-Id.", kind: "other" }, 400);
  const [rawId] = parts;
  // Searched with POST, so the words searched for stay out of URLs and request logs.
  if (rawId === "search" && req.method === "POST") {
    const query = String(body.q || "").trim().slice(0, 100);
    return json({ chats: query ? await searchChats(uk, query) : await listChats(uk) });
  }
  if (!rawId) {
    if (req.method === "GET") return json({ chats: await listChats(uk) });
    if (req.method === "DELETE") {
      await deleteAllChats(uk);
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  }
  const id = cleanChatId(rawId);
  if (!id) return json({ error: "not found" }, 404);
  if (req.method === "GET") {
    const chat = await getChat(uk, id);
    if (!chat) return json({ error: "That chat doesn't exist.", kind: "not-found" }, 404);
    const { title, specialist, updated, messages } = chat;
    return json({ chat: { id, title, specialist, updated, messages: messages.map(({ role, content, at }) => ({ role, content, at })) } });
  }
  if (req.method === "DELETE") {
    await deleteChat(uk, id);
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}

/* ── calendar, glance and confirmations (EDITH 1.6.0) ───────────────────── */

// A calendar file can be long, so the phone reads the events out of it, not the server.
const MAX_ICS_CHARS = 4_000_000;
const ICS_TIMEOUT_MS = 15_000;
// The weather behind the glasses dashboard, per place and language.
const GLANCE_CACHE_MS = 15 * 60 * 1000;

/*
 * Routes that have EDITH's server call somewhere for the caller - a calendar link, a webhook,
 * a provider to check a key with - are an open door to anyone who finds them, so each
 * network gets a few dozen calls every ten minutes: plenty for a household of phones.
 */
const RELAY_PER_WINDOW = 30;
const RELAY_WINDOW_MS = 10 * 60 * 1000;
const allowRelay = (req, kind) => allowRate(`rate/${kind}/${clientNetwork(req)}`, RELAY_PER_WINDOW, RELAY_WINDOW_MS);

/** Fetches one of the wearer's calendar links (a secret iCal address) for their phone. */
async function handleCalendar(req, body, uk) {
  if (uk === "anon") return json({ error: "Missing X-Device-Id.", kind: "other" }, 400);
  const url = publicHttps(body.url);
  if (!url) return json({ error: "That isn't a calendar address EDITH can read.", kind: "other" }, 400);
  if (!(await allowRelay(req, "calendar")) || !(await allowRate(`ics/${uk}`, 60, 10 * 60 * 1000))) {
    return json({ error: "Too many calendar refreshes. Try again in a few minutes.", kind: "rate" }, 429);
  }
  let res;
  try {
    // A calendar link that redirects is only followed to an address EDITH would call itself.
    res = await publicFetch(url.href, {
      headers: { "User-Agent": "EDITH/1.6 (Even Realities G2 assistant)", Accept: "text/calendar, text/plain" },
      signal: AbortSignal.timeout(ICS_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof UnsafeAddressError) return json({ error: "That calendar link leads somewhere EDITH can't read.", kind: "other" }, 400);
    return json({ error: "Couldn't reach that calendar.", kind: "network" }, 502);
  }
  if (!res.ok) return json({ error: `That calendar answered ${res.status}.`, kind: "other" }, 502);
  const text = (await res.text()).slice(0, MAX_ICS_CHARS);
  if (!text.includes("BEGIN:VCALENDAR")) return json({ error: "That link isn't a calendar file.", kind: "other" }, 400);
  // Sent as plain text: the phone parses it, and JSON would only cost the Worker CPU.
  return new Response(text, {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders() },
  });
}

/** Runs one of the wearer's own actions (a webhook) when they tap it on the phone. */
async function handleAction(req, body, uk) {
  if (uk === "anon") return json({ ok: false, error: "Missing X-Device-Id.", kind: "other" }, 400);
  if (!(await allowRelay(req, "action"))) {
    return json({ ok: false, error: "Too many actions. Try again in a few minutes.", kind: "rate" }, 429);
  }
  return json(await runAction(body.actions, body.name));
}

/** The glasses dashboard: the weather where the wearer is, cached per place. */
async function handleGlance(req) {
  const location = readLocation(new URL(req.url).searchParams.get("at"));
  if (!location) return json({ error: "No location.", kind: "other" }, 400);
  const language = languageOf(req);
  const key = `glance/${location.lat.toFixed(2)},${location.lon.toFixed(2)}/${language}`;
  const cached = await readJSON(key, null);
  if (cached && Date.now() - cached.at < GLANCE_CACHE_MS) return json(cached.glance);
  const [city, w] = await Promise.all([cityAt(location, language), weather({ location, language }).catch(() => null)]);
  if (!w || w.error) return json({ city });
  const glance = { city: w.city || city, temp_c: w.temp_c, conditions: w.conditions, high_c: w.high_c, low_c: w.low_c };
  await writeJSON(key, { glance, at: Date.now() });
  return json(glance);
}

/** EDITH 3 (beta): EDITH's PC app links itself, asks for work and hands back what it did. */
async function handleAgent(req, step, body) {
  if (step === "hello") {
    if (!(await allowRate(`rate/agent/${clientNetwork(req)}`, 120, HOUR_MS))) return json({ error: "Too many tries. Wait a few minutes." }, 429);
    const out = await pcHello(body);
    return json(out.body, out.status);
  }
  const run = { next: pcNext, done: pcDone, forget: pcForget }[step];
  if (!run) return json({ error: "not found" }, 404);
  const out = await run(body);
  return json(out.body, out.status);
}

/** The wearer tapped the glasses to confirm something that unlocks or opens a way into their home. */
async function handleHomeConfirm(req, body, uk) {
  if (uk === "anon") return json({ error: "Missing X-Device-Id.", kind: "other" }, 400);
  // EDITH 3: an approved job for the wearer's PC, or else a smart-home confirmation.
  const pc = await confirmPc(uk, body.token);
  if (pc) return json(pc, pc.ok ? 200 : 400);
  const out = await confirmHome(cleanHome(body.home), uk, body.token);
  return json(out, out.ok ? 200 : 400);
}

// About 30 seconds of 16 kHz WAV, as base64.
const MAX_PARTIAL_AUDIO_B64 = 1_400_000;
// What the other person may be speaking, as the app's "They speak" setting lists it (src/prefs.ts).
const ROOM_LANGUAGES = new Set(["en", "es", "fr", "de", "it", "pt", "nl", "ru", "el", "tr", "pl", "id", "zh", "ja", "ko", "ar"]);
const PARTIAL_WINDOW_MS = 10 * 60 * 1000;
const PARTIALS_PER_WINDOW = 300;
const partialCounts = new Map(); // uk -> { since, count }, per server instance

function allowPartial(uk) {
  const now = Date.now();
  let rec = partialCounts.get(uk);
  if (!rec || now - rec.since > PARTIAL_WINDOW_MS) rec = { since: now, count: 0 };
  rec.count++;
  if (partialCounts.size > 5000) partialCounts.clear();
  partialCounts.set(uk, rec);
  return rec.count <= PARTIALS_PER_WINDOW;
}

/**
 * Listening to the room (1.8.0): one segment of what somebody else said, in words the
 * wearer can read, translated when they asked for that. Nothing is stored here either -
 * the audio is transcribed and dropped, and the transcript lives on their phone.
 */
async function handleRoom(req, body, uk) {
  const access = resolveAccess(req);
  if (!access.chat) return json(NEEDS_KEY, 401);
  if (!access.voice) {
    return json({ error: `EDITH can't hear with ${PROVIDERS[access.chat.provider].label}.`, kind: "voice", needsVoiceKey: true }, 400);
  }
  const audio = body.audio?.data ? { mime: String(body.audio.mime || "audio/wav"), data: String(body.audio.data) } : null;
  if (!audio || audio.data.length > MAX_PARTIAL_AUDIO_B64) return json({ error: "Send up to 30 seconds of audio.", kind: "other" }, 400);
  if (!allowPartial(uk)) return json({ error: "Too many live transcriptions. Try again in a few minutes.", kind: "rate" }, 429);

  // What they are speaking, when the wearer said; otherwise the voice AI works it out. Any of
  // the languages the app offers there (more than EDITH's own nine): speech-to-text takes the
  // standard two-letter code.
  const spoken = ROOM_LANGUAGES.has(body.spoken) ? String(body.spoken) : "";
  const into = LANGUAGES[body.translateTo] ? String(body.translateTo) : "";
  try {
    const heard = await transcribe(access.voice, audio, AbortSignal.timeout(20_000), spoken);
    const text = String(heard || "");
    if (!text.trim() || !into || into === spoken) return json({ text });
    return json({ text, translated: await translateLine(access.chat, text, into) });
  } catch (err) {
    const { status, payload } = errorPayload(err, access);
    return json(payload, status);
  }
}

/** One line of subtitle in the wearer's language. Kept tiny: it is on the critical path. */
async function translateLine(chat, text, into) {
  const language = LANGUAGES[into]?.name || into;
  const convo = await startConversation(chat, {
    system:
      `Translate the user's line into ${language}. Reply with the translation and nothing else: ` +
      "no quotes, no explanation, no note about what language it was. Keep names as they are. " +
      "If it is already in that language, repeat it unchanged.",
    history: [],
    userText: text,
    tools: [],
    signal: AbortSignal.timeout(15_000),
  });
  let out = "";
  const { text: reply } = await convo.next({ onText: (piece) => (out += piece) });
  return String(reply || out || "").trim().slice(0, 500);
}

/** The words so far while the wearer is still talking, with their voice AI. Nothing is stored. */
async function handleTranscribe(req, body, uk) {
  const access = resolveAccess(req);
  if (!access.chat) return json(NEEDS_KEY, 401);
  if (!access.voice) {
    return json({ error: `EDITH can't hear with ${PROVIDERS[access.chat.provider].label}.`, kind: "voice", needsVoiceKey: true }, 400);
  }
  const audio = body.audio?.data ? { mime: String(body.audio.mime || "audio/wav"), data: String(body.audio.data) } : null;
  if (!audio || audio.data.length > MAX_PARTIAL_AUDIO_B64) return json({ error: "Send up to 30 seconds of audio.", kind: "other" }, 400);
  if (!allowPartial(uk)) return json({ error: "Too many live transcriptions. Try again in a few minutes.", kind: "rate" }, 429);
  try {
    const text = await transcribe(access.voice, audio, AbortSignal.timeout(15_000), languageOf(req));
    return json({ text: String(text || "") });
  } catch (err) {
    const { status, payload } = errorPayload(err, access);
    return json(payload, status);
  }
}

/* ── voice: answers read aloud with the voices of the wearer's AI company (2.1) ── */
// Each answer is spoken a few sentences at a time, so this allows plenty per network.
const SPEAK_PER_WINDOW = 400;

async function handleSpeak(req, body) {
  const h = (name) => (req.headers.get(name) || "").trim();
  // Which of the phone's keys pays for the voice: the AI's own, or the separate voice key.
  const via = body?.via === "voice" ? "voice" : "chat";
  const providerId = (via === "voice" ? h("x-voice-provider") : h("x-ai-provider")).toLowerCase();
  const key = via === "voice" ? h("x-voice-key") : h("x-ai-key");
  if (!hasVoices(providerId)) return json({ error: "That AI has no voices of its own.", kind: "novoice" }, 400);
  if (!plausibleKey(key)) return json(NEEDS_KEY, 401);
  const text = String(body?.text || "").replace(/\s+/g, " ").trim().slice(0, MAX_SPEAK_CHARS);
  if (!text) return json({ error: "Nothing to say.", kind: "other" }, 400);
  if (!(await allowRate(`rate/speak/${clientNetwork(req)}`, SPEAK_PER_WINDOW, RELAY_WINDOW_MS))) {
    return json({ error: "Too much speaking at once. Try again in a few minutes.", kind: "rate" }, 429);
  }
  try {
    const wav = await speak(providerId, key, text, String(body?.voice || ""));
    return new Response(wav, { status: 200, headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store", ...corsHeaders() } });
  } catch (err) {
    const { status, payload } = errorPayload(err, null);
    return json(payload, status);
  }
}

/* ── keys and models ────────────────────────────────────────────────────── */
async function handleCheckKey(req) {
  const h = (name) => (req.headers.get(name) || "").trim();
  const providerId = (h("x-ai-provider") || (h("x-gemini-key") ? "gemini" : "")).toLowerCase();
  const key = h("x-ai-key") || h("x-gemini-key");
  const provider = PROVIDERS[providerId];
  // `code` lets the app word the problem in its own language; `error` is the English for older apps.
  if (!provider) return { ok: false, code: "provider", error: "Pick an AI provider first." };
  // The wearer's own server: the address is what is being checked, and a key is optional.
  const base = provider.needsBase ? publicHttps(h("x-ai-base"))?.href || "" : "";
  if (provider.needsBase && !base) {
    return { ok: false, code: "address", error: "Give the https address of your server, e.g. https://ai.example.com/v1" };
  }
  if (!plausibleKey(key) && !(provider.keyOptional && !key)) {
    return { ok: false, code: "format", error: `That doesn't look like a ${provider.label} API key.` };
  }
  const other = key ? keyBelongsElsewhere(providerId, key) : null;
  if (other) return { ok: false, code: "elsewhere", other: other.id, error: `That looks like a ${other.label} key. Choose ${other.label} instead.` };
  // Only a check that calls out is counted. The phone app sends no device id here, so this
  // is limited per network alone.
  if (!(await allowRelay(req, "check-key"))) {
    return { ok: false, code: "rate", error: "Too many key checks. Try again in a few minutes." };
  }
  try {
    const { models, defaultModel } = await modelsFor(accessFor(providerId, [key], "", base));
    if (providerId === "openrouter") {
      // An account without credits can only use free models: start on one that works.
      const free = await openrouterFreeTier(key, models).catch(() => ({ freeTier: false, defaultModel: "" }));
      if (free.freeTier) return { ok: true, models, defaultModel: free.defaultModel || defaultModel, voice: provider.voice, freeTier: true };
    }
    return { ok: true, models, defaultModel, voice: provider.voice };
  } catch (err) {
    if (err instanceof ProviderError && err.kind === "key") {
      return { ok: false, code: "rejected", error: `${provider.label} rejected this key. Copy it again from ${provider.keyUrl}.` };
    }
    if (err instanceof ProviderError && err.kind === "network") {
      // Their own server already names the address that didn't answer (1.7.4).
      const message = provider.needsBase ? err.message : `Couldn't reach ${provider.label} to check the key. Try again.`;
      return { ok: false, code: "network", error: message };
    }
    return { ok: false, code: "other", error: err instanceof ProviderError ? err.message : "Couldn't check the key. Try again." };
  }
}

async function handleModels(req) {
  const { chat } = resolveAccess(req);
  if (!chat) return json(NEEDS_KEY, 401);
  try {
    return json(await modelsFor(chat));
  } catch (err) {
    const { status, payload } = errorPayload(err, { chat });
    return json(payload, status);
  }
}

/* ── accounts ───────────────────────────────────────────────────────────── */

async function handleAccount(req, route, body, device) {
  const url = new URL(req.url);
  if (route === "config" && req.method === "GET") return json(accountConfig());
  if (!accountsEnabled()) return json({ error: "Accounts aren't set up on this server.", kind: "disabled" }, 503);

  try {
    if (route === "link/start" && req.method === "POST") {
      if (device === "anon") return json({ error: "Missing X-Device-Id.", kind: "other" }, 400);
      if (await isBlocked(device)) return json({ error: "This phone is banned from EDITH.", kind: "blocked" }, 403);
      if (!(await allowRate(`rate/link/${clientNetwork(req)}`, 30, HOUR_MS))) {
        return json({ error: "Too many sign-in attempts. Try again later.", kind: "rate" }, 429);
      }
      return json(await startLink(device, { origin: url.origin, language: languageOf(req) }));
    }
    if (route === "link/check" && req.method === "GET") return json(await checkLink(url.searchParams.get("code")));
    if (route === "link/confirm" && req.method === "POST") {
      if (!(await allowRate(`rate/confirm/${clientNetwork(req)}`, 30, HOUR_MS))) {
        return json({ ok: false, reason: "rate", error: "Too many sign-in attempts. Try again later." }, 429);
      }
      return json(await confirmLink(body.code, body.idToken));
    }
    if (route === "link/poll" && req.method === "POST") return json(await pollLink(body.code, body.pollToken, device));

    const session = await sessionFor(req);
    if (!session) return sessionEnded();
    if (route === "" && req.method === "GET") {
      const summary = await accountSummary(session);
      return summary ? json(summary) : sessionEnded();
    }
    if (route === "profile" && req.method === "POST") return json(await saveProfile(session, body));
    if (route === "signout" && req.method === "POST") return json(await endSession(session));
    if (route === "delete" && req.method === "POST") return json(await deleteAccount(session.acct));
    return json({ error: "not found" }, 404);
  } catch (err) {
    if (err instanceof AccountError) return json({ ok: false, reason: err.code, error: err.message }, err.code === "token" ? 401 : 400);
    throw err;
  }
}

/* ── connecting an AI account without a key (lib/connect.mjs) ───────────── */

async function handleConnect(req, parts, body, device) {
  const url = new URL(req.url);
  const [provider, step, extra] = parts;
  if (provider !== "openrouter") return json({ error: "not found" }, 404);
  if (step === "start" && req.method === "POST") {
    if (device === "anon") return json({ error: "Missing X-Device-Id.", kind: "other" }, 400);
    if (await isBlocked(device)) return json({ error: "This phone is banned from EDITH.", kind: "blocked" }, 403);
    if (!(await allowRate(`rate/connect/${clientNetwork(req)}`, 30, HOUR_MS))) {
      return json({ error: "Too many tries. Try again later.", kind: "rate" }, 429);
    }
    return json(await startConnect(device, { origin: url.origin, language: languageOf(req) }));
  }
  if (step === "poll" && req.method === "POST") return json(await pollConnect(body.id, body.pollToken));
  if (step && !extra && req.method === "GET") return connectRedirect(step, url.origin, url.searchParams.get("lang") || "");
  if (step && extra === "done" && req.method === "GET") return connectCallback(step, url.searchParams.get("code"), url.origin);
  return json({ error: "not found" }, 404);
}

/* ── router ─────────────────────────────────────────────────────────────── */

/** ctx is the host's request context; its waitUntil keeps background writes alive after the reply. */
export async function handle(req, ctx) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const route = parts.at(-1);
  const device = deviceKey(req);
  let uk = device;
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const background = (task) => {
    const settled = Promise.resolve(task).catch((e) => console.error("background task failed:", e?.message || e));
    ctx?.waitUntil?.(settled);
  };

  try {
    const accountAt = parts.indexOf("account");
    if (accountAt >= 0) return await handleAccount(req, parts.slice(accountAt + 1).join("/"), body, device);
    const connectAt = parts.indexOf("connect");
    if (connectAt >= 0) return await handleConnect(req, parts.slice(connectAt + 1), body, device);

    // A signed-in phone keeps its memories and chats under its account.
    const chatsAt = parts.indexOf("chats");
    if ((["chat", "memory", "history", "transcribe", "calendar", "confirm", "lists"].includes(route) || chatsAt >= 0) && req.headers.get("x-edith-session")) {
      const session = await sessionFor(req);
      if (!session) return sessionEnded();
      uk = session.acct;
    }

    if (chatsAt >= 0) return await handleChats(req, parts.slice(chatsAt + 1), uk, body);
    if (route === "transcribe" && req.method === "POST") return await handleTranscribe(req, body, uk);
    if (route === "room" && req.method === "POST") return await handleRoom(req, body, uk);
    if (route === "calendar" && req.method === "POST") return await handleCalendar(req, body, uk);
    if (route === "glance" && req.method === "GET") return await handleGlance(req);
    if (route === "confirm" && req.method === "POST") return await handleHomeConfirm(req, body, uk);
    if (route === "action" && req.method === "POST") return await handleAction(req, body, uk);
    if (route === "lists") {
      if (uk === "anon") return json({ error: "Missing X-Device-Id.", kind: "other" }, 400);
      if (req.method === "POST") return json({ list: await saveList(uk, body) });
      if (req.method === "DELETE") {
        await clearLists(uk);
        return json({ ok: true });
      }
      return json({ lists: await getLists(uk) });
    }
    const agentAt = parts.indexOf("agent");
    if (agentAt >= 0 && req.method === "POST") return await handleAgent(req, parts[agentAt + 1] || "", body);
    if (route === "chat" && req.method === "POST") return await handleChat(req, body, uk, device, background);
    if (route === "speak" && req.method === "POST") return await handleSpeak(req, body);
    if (route === "check-key" && req.method === "POST") {
      const checked = await handleCheckKey(req);
      return json(checked, checked.code === "rate" ? 429 : 200);
    }
    if (route === "models" && req.method === "GET") return await handleModels(req);
    if (route === "providers" && req.method === "GET") {
      // Apps that know how to ask for an address also see "your own server".
      const ownServer = (req.headers.get("x-edith-can") || "").includes("ownServer");
      return json({ providers: publicCatalog({ ownServer }) });
    }

    if (route === "memory") {
      if (req.method === "DELETE") {
        await clearMemories(uk);
        return json({ ok: true });
      }
      return json({ memories: await getMemories(uk) });
    }

    if (route === "history") {
      if (req.method === "DELETE") {
        await clearHistory(uk);
        return json({ ok: true });
      }
      const rows = await getHistory(uk);
      return json({ messages: rows.map(({ role, content }) => ({ role, content })) });
    }

    if (route === "device" && req.method === "POST") {
      // An account's key is never handed back as a device id: a fresh one is made instead.
      const key = cleanDeviceId(body.id) || `edith_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
      return json({ deviceKey: key, restored: false, banned: false });
    }

    if (route === "status") {
      return json({
        ok: true,
        host,
        moderation: moderationOn(),
        accounts: accountsEnabled(),
        storage: storageKind(),
        providers: Object.keys(PROVIDERS),
      });
    }

    return json({ error: "not found" }, 404);
  } catch (e) {
    console.error("request failed", route, e.message);
    return json({ error: "EDITH's server hit an error." }, 500);
  }
}
