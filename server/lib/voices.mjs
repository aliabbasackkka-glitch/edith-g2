/**
 * EDITH's voice: answers read aloud by the voices of the AI company the wearer already
 * has a key for (EDITH 2.1). OpenAI, Google Gemini and Groq sell speech as well as
 * answers, so their key can do both; the others (Claude, DeepSeek, OpenRouter, Grok,
 * Mistral) have no voices here, and the apps fall back to a free voice instead.
 *
 * POST /api/speak { text, voice, via } -> audio/wav. `via` says which of the phone's keys
 * pays for it: "chat" (X-AI-Provider / X-AI-Key) or "voice" (X-Voice-Provider / X-Voice-Key).
 * The text is the answer EDITH just gave; it goes to that company to be spoken, and nothing
 * is kept.
 */

import { ProviderError, providerErrorFrom, request } from "./http.mjs";

/** The longest text one request may ask to have spoken; the apps send an answer a few sentences at a time. */
export const MAX_SPEAK_CHARS = 600;

// [id, name, note]. The note is how the company describes the voice.
const OPENAI_VOICES = [
  ["marin", "Marin", "Natural and warm (best)"],
  ["cedar", "Cedar", "Natural and deep (best)"],
  ["coral", "Coral", "Bright"],
  ["sage", "Sage", "Calm"],
  ["nova", "Nova", "Friendly"],
  ["shimmer", "Shimmer", "Soft"],
  ["alloy", "Alloy", "Balanced"],
  ["ash", "Ash", "Clear"],
  ["ballad", "Ballad", "Expressive"],
  ["echo", "Echo", "Smooth"],
  ["fable", "Fable", "Storyteller"],
  ["onyx", "Onyx", "Deep"],
  ["verse", "Verse", "Lively"],
];

const GEMINI_VOICES = [
  ["Kore", "Firm"], ["Aoede", "Breezy"], ["Charon", "Informative"], ["Puck", "Upbeat"], ["Zephyr", "Bright"],
  ["Fenrir", "Excitable"], ["Leda", "Youthful"], ["Orus", "Firm"], ["Callirrhoe", "Easy-going"], ["Autonoe", "Bright"],
  ["Enceladus", "Breathy"], ["Iapetus", "Clear"], ["Umbriel", "Easy-going"], ["Algieba", "Smooth"], ["Despina", "Smooth"],
  ["Erinome", "Clear"], ["Algenib", "Gravelly"], ["Rasalgethi", "Informative"], ["Laomedeia", "Upbeat"], ["Achernar", "Soft"],
  ["Alnilam", "Firm"], ["Schedar", "Even"], ["Gacrux", "Mature"], ["Pulcherrima", "Forward"], ["Achird", "Friendly"],
  ["Zubenelgenubi", "Casual"], ["Vindemiatrix", "Gentle"], ["Sadachbia", "Lively"], ["Sadaltager", "Knowledgeable"], ["Sulafat", "Warm"],
].map(([id, note]) => [id, id, note]);

// Groq's Orpheus voices: English, and Saudi Arabic (EDITH picks the model from the voice).
const GROQ_ENGLISH = [
  ["hannah", "Hannah", "Female"], ["diana", "Diana", "Female"], ["autumn", "Autumn", "Female"],
  ["troy", "Troy", "Male"], ["austin", "Austin", "Male"], ["daniel", "Daniel", "Male"],
];
const GROQ_ARABIC = [
  ["noura", "Noura", "Female · Arabic"], ["lulwa", "Lulwa", "Female · Arabic"], ["aisha", "Aisha", "Female · Arabic"],
  ["fahad", "Fahad", "Male · Arabic"], ["sultan", "Sultan", "Male · Arabic"], ["abdullah", "Abdullah", "Male · Arabic"],
];

const TTS = {
  openai: { label: "OpenAI", voices: OPENAI_VOICES, defaultVoice: "marin" },
  gemini: { label: "Google Gemini", voices: GEMINI_VOICES, defaultVoice: "Kore" },
  groq: { label: "Groq", voices: [...GROQ_ENGLISH, ...GROQ_ARABIC], defaultVoice: "hannah" },
};

/** Whether a company can read answers aloud with its own voices. */
export const hasVoices = (providerId) => Boolean(TTS[providerId]);

/** The voices a company offers, for the apps' voice picker: [{ id, name, note }], or [] for none. */
export function voicesOf(providerId) {
  const tts = TTS[providerId];
  return tts ? tts.voices.map(([id, name, note]) => ({ id, name, note })) : [];
}

export const defaultVoiceOf = (providerId) => TTS[providerId]?.defaultVoice || "";

/* ── audio plumbing ─────────────────────────────────────────────────────── */

/** A WAV file around 16-bit mono PCM. */
export function wavFromPcm(pcm, rate = 24000) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, Buffer.from(pcm)]);
}

/** The PCM samples and sample rate inside a WAV file. */
export function pcmFromWav(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let rate = 24000;
  let p = 12;
  while (p + 8 <= buf.length) {
    const id = String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]);
    let size = view.getUint32(p + 4, true);
    if (id === "fmt ") rate = view.getUint32(p + 12, true);
    if (id === "data") {
      if (size === 0xffffffff || p + 8 + size > buf.length) size = buf.length - p - 8;
      return { pcm: buf.subarray(p + 8, p + 8 + size), rate };
    }
    p += 8 + size + (size & 1);
  }
  return { pcm: buf.subarray(44), rate };
}

/** Text cut into pieces of at most max characters, at sentence or word breaks. */
export function pieces(text, max) {
  const out = [];
  let rest = String(text).trim();
  while (rest.length > max) {
    let cut = Math.max(rest.lastIndexOf(". ", max), rest.lastIndexOf("? ", max), rest.lastIndexOf("! ", max), rest.lastIndexOf(", ", max));
    if (cut < max * 0.4) cut = rest.lastIndexOf(" ", max);
    if (cut < 20) cut = max - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

const timeout = () => AbortSignal.timeout(30_000);

async function openaiSpeak(key, text, voice) {
  const res = await request("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice, input: text, response_format: "wav" }),
    signal: timeout(),
  }, "OpenAI");
  if (!res.ok) throw await providerErrorFrom(res, "OpenAI");
  return Buffer.from(await res.arrayBuffer());
}

// Newest first; a model this key can't use (or that has gone) steps to the next.
const GEMINI_TTS_MODELS = ["gemini-3.8-flash-tts", "gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts"];

async function geminiSpeak(key, text, voice) {
  let last = null;
  for (const model of GEMINI_TTS_MODELS) {
    const res = await request(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }),
      signal: timeout(),
    }, "Google Gemini");
    if (!res.ok) {
      last = await providerErrorFrom(res, "Google Gemini");
      if (last.kind === "model" || last.kind === "overloaded" || (last.kind === "other" && last.status === 400)) continue;
      throw last;
    }
    const data = await res.json().catch(() => null);
    const part = data?.candidates?.[0]?.content?.parts?.find((p) => p?.inlineData?.data);
    if (!part) {
      last = new ProviderError("other", "Google Gemini sent no audio.");
      continue;
    }
    const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType || "")?.[1]) || 24000;
    const audio = Buffer.from(part.inlineData.data, "base64");
    // Usually raw 16-bit PCM; wrapped unless it is a WAV file already.
    return audio.subarray(0, 4).toString() === "RIFF" ? audio : wavFromPcm(audio, rate);
  }
  throw last || new ProviderError("other", "Google Gemini couldn't speak.");
}

async function groqSpeak(key, text, voice) {
  const arabic = GROQ_ARABIC.some(([id]) => id === voice);
  const model = arabic ? "canopylabs/orpheus-arabic-saudi" : "canopylabs/orpheus-v1-english";
  // Orpheus takes at most 200 characters at a time: speak in pieces and join the audio.
  const parts = [];
  let rate = 24000;
  for (const piece of pieces(text, 190)) {
    const res = await request("https://api.groq.com/openai/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, voice, input: piece, response_format: "wav" }),
      signal: timeout(),
    }, "Groq");
    if (!res.ok) throw await providerErrorFrom(res, "Groq");
    const got = pcmFromWav(new Uint8Array(await res.arrayBuffer()));
    rate = got.rate;
    parts.push(Buffer.from(got.pcm));
  }
  return wavFromPcm(Buffer.concat(parts), rate);
}

const SPEAKERS = { openai: openaiSpeak, gemini: geminiSpeak, groq: groqSpeak };

/**
 * Speaks text with one company's voice and key. Returns a WAV file as a Buffer, or throws a
 * ProviderError ("key", "quota", "model", ...), which the route turns into a message.
 */
export async function speak(providerId, key, text, voice) {
  const tts = TTS[providerId];
  if (!tts) throw new ProviderError("other", "That AI has no voices of its own.");
  const chosen = tts.voices.some(([id]) => id === voice) ? voice : tts.defaultVoice;
  return SPEAKERS[providerId](key, text, chosen);
}
