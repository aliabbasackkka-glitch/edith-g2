// The wearer's answer preferences, sent by EDITH 1.5.0 and later with each question and
// kept in an account's synced profile: answer length, the glasses reading pace, their own
// instructions, the specialist EDITH acts as, and the glasses menu.
//
// EDITH 1.6.0 adds what the phone brings to a question (the calendar it read, the smart home
// and the actions it holds) and more synced settings: location, the glasses dashboard,
// hands-free follow-ups, specialists the wearer wrote, calendar links and routines.

export const STYLES = ["short", "normal", "detailed"];
export const PACES = ["instant", "fast", "relaxed"];
export const SPECIALISTS = ["general", "translator", "coach", "chef", "tutor", "custom"];
export const MENU_ITEMS = ["newChat", "briefing", "type", "lists", "chats", "history", "second", "switchAi", "specialist", "repeat", "discreet", "send", "subtitles", "translate"];
export const DEFAULT_MENU = ["newChat", "briefing", "type", "history", "switchAi"];
export const RING_ACTIONS = ["same", "repeat", "history", "briefing", "type", "lists"];
export const TALK_STARTS = ["tapOrHold", "holdOnly"];

/** The profile fields EDITH 1.5.0 and 1.6.0 added. Older apps save profiles without them. */
export const PREF_FIELDS = [
  "theme", "style", "pace", "liveWords", "instructions", "specialist", "translateTo", "menu", "quick",
  "location", "dashboard", "followUp", "custom", "calendars", "home", "actions", "routines",
  // 1.7.0
  "openListening", "ring", "talk", "discreet",
  // 1.7.4
  "guessing",
  // 1.8.0
  "roomLanguage",
];

// Languages the translator can translate into: ones the G2's font can show (Arabic is
// shown in English letters on the glasses).
export const TRANSLATE_TARGETS = {
  en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian", pt: "Portuguese", nl: "Dutch",
  ru: "Russian", el: "Greek", tr: "Turkish", pl: "Polish", id: "Indonesian", zh: "Chinese", ja: "Japanese",
  ko: "Korean", ar: "Arabic",
};

export const MAX_INSTRUCTIONS = 500;
export const MAX_QUICK = 5;
export const MAX_CUSTOM = 3;
export const MAX_CALENDARS = 3;
export const MAX_ACTIONS = 10;
export const MAX_ROUTINES = 3;
export const MAX_ROUTINE_STEPS = 4;
export const MAX_EVENTS = 60;

const plain = (text, max) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** The wearer's own instructions: plain text, no control characters, at most 500 characters. */
export const cleanInstructions = (text) =>
  String(text || "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ").trim().slice(0, MAX_INSTRUCTIONS);

export const cleanQuick = (list) =>
  (Array.isArray(list) ? list : [])
    .map((q) => plain(q, 120))
    .filter(Boolean)
    .slice(0, MAX_QUICK);

/** One specialist the wearer wrote themselves: a name and what it should do. */
export const cleanCustomOne = (raw) => {
  const name = plain(raw?.name, 24);
  const instructions = cleanInstructions(raw?.instructions);
  return name && instructions ? { name, instructions } : null;
};

export const cleanCustomList = (list) =>
  (Array.isArray(list) ? list : []).map(cleanCustomOne).filter(Boolean).slice(0, MAX_CUSTOM);

/**
 * An address as the app keeps it. The scheme may be missing, because the examples in the
 * app's fields no longer show one; publicHttps() fills it in before anything is called.
 */
const ADDRESS = /^(https:\/\/)?[^\s/]+\.[^\s]+$/i;

/** The wearer's calendar links (secret iCal addresses), as kept in their profile. */
export const cleanCalendars = (list) =>
  (Array.isArray(list) ? list : [])
    .map((c) => ({ name: plain(c?.name, 24), url: String(c?.url || "").trim().slice(0, 500) }))
    .filter((c) => ADDRESS.test(c.url))
    .slice(0, MAX_CALENDARS);

/** Their own actions (webhooks), as kept in their profile. */
export const cleanActionList = (list) =>
  (Array.isArray(list) ? list : [])
    .map((a) => ({
      name: plain(a?.name, 40),
      url: String(a?.url || "").trim().slice(0, 500),
      method: String(a?.method || "POST").toUpperCase() === "GET" ? "GET" : "POST",
    }))
    .filter((a) => a.name && ADDRESS.test(a.url))
    .slice(0, MAX_ACTIONS);

/** Routines: a name, then things to ask EDITH or actions to run, in order. */
export const cleanRoutines = (list) =>
  (Array.isArray(list) ? list : [])
    .map((r) => ({
      name: plain(r?.name, 24),
      steps: (Array.isArray(r?.steps) ? r.steps : [])
        .map((s) => (s?.action ? { action: plain(s.action, 40) } : { say: plain(s?.say, 120) }))
        .filter((s) => s.action || s.say)
        .slice(0, MAX_ROUTINE_STEPS),
    }))
    .filter((r) => r.name && r.steps.length)
    .slice(0, MAX_ROUTINES);

/** Home Assistant as kept in the profile (checked again in home.mjs before it is called). */
export const cleanHomeSettings = (raw) => ({
  url: String(raw?.url || "").trim().slice(0, 300),
  token: String(raw?.token || "").trim().slice(0, 2000),
});

/** The specialist a profile is set to: a built-in one, or custom:0 to custom:2. */
export const cleanSpecialistChoice = (value) =>
  SPECIALISTS.includes(value) && value !== "custom" ? value : /^custom:[0-2]$/.test(String(value)) ? String(value) : "general";

/** What the phone read from the wearer's calendar, sent with a question and never stored. */
export const cleanCalendarEvents = (list) =>
  (Array.isArray(list) ? list : [])
    .map((e) => ({
      when: plain(e?.when, 60),
      title: plain(e?.title, 100),
      where: plain(e?.where, 80),
      day: Math.max(0, Math.min(14, Math.round(Number(e?.day) || 0))),
    }))
    .filter((e) => e.when && e.title)
    .slice(0, MAX_EVENTS);

/** The answer preferences from a chat request, with defaults for anything missing (older apps). */
export function answerPrefs(body) {
  return {
    style: STYLES.includes(body?.style) ? body.style : "normal",
    instructions: cleanInstructions(body?.instructions),
    specialist: SPECIALISTS.includes(body?.specialist) ? body.specialist : "general",
    translateTo: TRANSLATE_TARGETS[body?.translateTo] ? body.translateTo : "",
    custom: cleanCustomOne(body?.custom),
  };
}
