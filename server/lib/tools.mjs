// Tools every AI provider can call: memory, lookups, weather, news, the daily briefing,
// and (EDITH 1.5.0 and later) recall of past chats, and (1.6.0 and later) the wearer's
// calendar, places near them, timers on the glasses, reading a web page, and their smart
// home. Definitions use plain JSON Schema; each provider adapter converts them to its own
// format. Only the tools a phone can actually use are offered, see toolsFor().

import { recall } from "./chats.mjs";
import { homeControl, homeStatus, runAction } from "./home.mjs";
import { changeList, cleanName, findList, getLists, saveList } from "./lists.mjs";
import { LANGUAGES } from "./languages.mjs";
import { UnsafeAddressError, publicFetch, publicHttps } from "./net.mjs";
import { cityAt, nearbyPlaces } from "./places.mjs";
import { saveMemory } from "./storage.mjs";

const DEFS = {
  save_memory: {
    description:
      "Silently store a fact about the user. Call whenever they reveal identity, preferences, style, projects, relationships, habits or anything worth remembering. Never announce it.",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", description: "identity | preferences | style | projects | relationships | habits | notes" },
        key: { type: "string", description: "short snake_case label, e.g. favourite_food" },
        value: { type: "string", description: "the fact itself" },
      },
      required: ["category", "key", "value"],
    },
  },
  web_search: {
    description: "Search the web for current information.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  wikipedia: {
    description: "Look up a topic on Wikipedia. Good for people, places, concepts.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  weather_report: {
    description: "Current weather, conditions and today's range. Leave the city out for where the user is now.",
    parameters: { type: "object", properties: { city: { type: "string", description: "Optional city; omit for where they are." } } },
  },
  news_headlines: {
    description: "Latest news headlines, optionally about a topic.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Optional topic, e.g. technology, football, Dubai. Leave empty for top world news." },
      },
    },
  },
  recall_conversations: {
    description:
      "Search the user's past conversations with you: what they said and what you answered, earlier today, last week or months ago. Call it when they refer to something from before that isn't in this chat, e.g. 'what did I tell you about my trip' or 'last week you said'.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The words to look for." },
        months_back: { type: "number", description: "How many months back to look, 1 to 12. Default 3." },
      },
      required: ["query"],
    },
  },
  daily_briefing: {
    description:
      "The user's daily briefing: the weather, their calendar for today and the top headlines. Call it when they ask to be briefed, e.g. 'brief me' or 'what's happening today'.",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "Optional city; omit for where they are, or use the one from memory." } },
    },
  },
  nearby_places: {
    description:
      "Places near the user right now, nearest first: cafés, pharmacies, supermarkets, anything they name. Looks 2 km out by default and widens by itself when nothing is close; set within_km when they ask for further away.",
    parameters: {
      type: "object",
      properties: {
        what: { type: "string", description: "What to look for, e.g. coffee, pharmacy, petrol station." },
        within_km: { type: "number", description: "How far to look, in kilometres, 0.5 to 25. Leave out for the usual 2 km." },
      },
      required: ["what"],
    },
  },
  calendar_events: {
    description: "What is in the user's calendar. Their phone sends it with the question; nothing is stored.",
    parameters: {
      type: "object",
      properties: { range: { type: "string", description: "today | tomorrow | week | next. Default next." } },
    },
  },
  read_link: {
    description: "Read a web page the user gives you, to summarise it or answer questions about it.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  set_timer: {
    description: "Start a countdown on the glasses, for cooking or anything timed. It runs while EDITH is open.",
    parameters: {
      type: "object",
      properties: {
        minutes: { type: "number", description: "How long, in minutes (0.5 to 180)." },
        label: { type: "string", description: "Optional short name, e.g. pasta." },
      },
      required: ["minutes"],
    },
  },
  cancel_timers: {
    description: "Stop the countdowns running on the glasses.",
    parameters: { type: "object", properties: {} },
  },
  home_status: {
    description: "What the user's smart home has and what state each thing is in. Search with `query` to narrow it down.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Optional words to look for, e.g. kitchen, lamp." } },
    },
  },
  home_control: {
    description:
      "Switch something in the user's smart home. Anything that unlocks or opens a way into the home comes back as a confirmation the user taps on the glasses, which EDITH is already showing.",
    parameters: {
      type: "object",
      properties: {
        device: { type: "string", description: "The device's name or entity id, as listed by home_status." },
        action: { type: "string", description: "on | off | toggle | open | close | stop | lock | unlock | set" },
        value: { type: "number", description: "For set: brightness or fan percent, temperature, or volume." },
      },
      required: ["device", "action"],
    },
  },
  run_action: {
    description: "Run one of the user's own actions (a webhook they set up on the phone), by name.",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  set_alarm: {
    description:
      "Set an alarm for a time of day on the glasses, e.g. \"wake me at 7\" or \"remind me at 5:45pm\". It goes off while EDITH is open. For anything in minutes from now, use set_timer instead. You cannot add events to their calendar, so offer this when they ask to be reminded.",
    parameters: {
      type: "object",
      properties: {
        time: { type: "string", description: "The time of day on a 24-hour clock, e.g. 07:00 or 17:45." },
        label: { type: "string", description: "Optional short name, e.g. pick up the kids." },
      },
      required: ["time"],
    },
  },
  my_lists: {
    description: "The names of the user's lists and how much is left on each.",
    parameters: { type: "object", properties: {} },
  },
  show_list: {
    description:
      "Show one of the user's lists on their glasses, and change it at the same time. Creates the list if it is new. Use it whenever they talk about a shopping list, packing list or things to do.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The list's name, e.g. shopping." },
        items: { type: "array", items: { type: "string" }, description: "Replaces everything on the list." },
        add: { type: "array", items: { type: "string" }, description: "Items to add." },
        remove: { type: "array", items: { type: "string" }, description: "Items to take off." },
        tick: { type: "array", items: { type: "string" }, description: "Items they have done." },
        untick: { type: "array", items: { type: "string" }, description: "Items to mark as not done after all." },
      },
      required: ["name"],
    },
  },
  ask_to_pick: {
    description:
      "Put a short list of choices on the glasses for the user to pick from with a tap, e.g. which café to walk to. Their choice comes back as their next message. Only for a real choice, never as a menu of things you could do.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "What they are choosing, in a few words." },
        options: { type: "array", items: { type: "string" }, description: "Two to eight choices, each in a few words." },
      },
      required: ["question", "options"],
    },
  },
};

const ALWAYS = ["save_memory", "web_search", "wikipedia", "weather_report", "news_headlines", "daily_briefing", "read_link"];

/**
 * The tools to offer for this question. `can` says what the phone and the wearer's setup
 * support: saved chats, location, a calendar, timers, a smart home, their own actions.
 */
export function toolsFor(can = {}) {
  const names = [...ALWAYS];
  if (can.recall) names.push("recall_conversations");
  if (can.location) names.push("nearby_places");
  if (can.calendar) names.push("calendar_events");
  if (can.timers) names.push("set_timer", "cancel_timers");
  if (can.alarms) names.push("set_alarm");
  if (can.lists) names.push("my_lists", "show_list");
  if (can.pick) names.push("ask_to_pick");
  if (can.home) names.push("home_status", "home_control");
  if (can.actions) names.push("run_action");
  return names.map((name) => ({ name, ...DEFS[name] }));
}

/** A time of day as "HH:MM" on a 24-hour clock, or "" when it isn't one. */
function clockTime(raw) {
  const said = String(raw ?? "").trim().toLowerCase();
  const parts = said.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!parts) return "";
  let hour = Number(parts[1]);
  const minute = Number(parts[2] ?? 0);
  if (parts[3] === "pm" && hour < 12) hour += 12;
  if (parts[3] === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return "";
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** How long until that time of day, from the clock the phone sent. Tomorrow if it has passed. */
function msUntil(at, localTime) {
  const now = String(localTime || "").match(/(\d{1,2}):(\d{2})/);
  if (!now) return 60 * 60_000;
  const minutesNow = Number(now[1]) * 60 + Number(now[2]);
  const [hour, minute] = at.split(":").map(Number);
  const wait = (hour * 60 + minute - minutesNow + 24 * 60) % (24 * 60);
  return Math.max(60_000, wait * 60_000);
}

const TIMEOUT_MS = 6000;
const PAGE_TIMEOUT_MS = 10_000;
const USER_AGENT = "EDITH/1.6 (Even Realities G2 assistant)";
// Enough for an article, and small enough to stay well inside a Worker's CPU budget.
const MAX_PAGE_CHARS = 250_000;
const MAX_PAGE_TEXT = 8000;
const MAX_TIMER_MINUTES = 180;

const getJson = (url) =>
  fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

// WMO weather interpretation codes used by Open-Meteo.
const CONDITIONS = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "rain showers", 81: "rain showers", 82: "violent rain showers", 85: "snow showers", 86: "heavy snow showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with heavy hail",
};

/** The forecast for a point, as the tools and the glasses dashboard report it. */
async function forecast(latitude, longitude, city) {
  const w = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
    `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1`
  );
  return {
    city,
    conditions: CONDITIONS[w.current.weather_code] ?? "unknown",
    temp_c: w.current.temperature_2m,
    humidity: w.current.relative_humidity_2m,
    wind_kmh: w.current.wind_speed_10m,
    high_c: w.daily.temperature_2m_max[0],
    low_c: w.daily.temperature_2m_min[0],
    rain_chance: w.daily.precipitation_probability_max?.[0],
  };
}

/** The weather for a named city, or for where the wearer is when no city is given. */
export async function weather({ city, location, language = "" }) {
  if (!city) {
    if (!location) return { error: "No city given." };
    return forecast(location.lat, location.lon, (await cityAt(location, language)) || "where you are");
  }
  const g = await getJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=${language || "en"}`,
  );
  const loc = g.results && g.results[0];
  if (!loc) return { error: `Could not find ${city}.` };
  return forecast(loc.latitude, loc.longitude, `${loc.name}, ${loc.country}`);
}

const decodeEntities = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** Headlines about a topic, or the top stories, in the user's language (English: BBC world news). */
async function headlines(topic, count = 5, language = "") {
  const t = String(topic || "").trim().slice(0, 100);
  const edition = (LANGUAGES[language] || LANGUAGES.en).news;
  const local = language && language !== "en";
  const url = t
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(t)}&${edition}`
    : local
      ? `https://news.google.com/rss?${edition}`
      : "https://feeds.bbci.co.uk/news/world/rss.xml";
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return { error: "News is unavailable right now." };
  const xml = await res.text();
  const titles = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/g)]
    .map((m) => decodeEntities((m[0].match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "").trim())
    .filter(Boolean)
    .slice(0, count);
  return titles.length
    ? { source: t || local ? "Google News" : "BBC News", topic: t || "top stories", headlines: titles }
    : { error: "No headlines found." };
}

const settle = (promise) => promise.catch((e) => ({ error: String(e.message || e) }));

/** A Wikipedia summary, from the user's language's Wikipedia first and English's if it has nothing. */
async function wikipedia(query, language = "") {
  const wikis = [...new Set([language || "en", "en"])];
  for (const wiki of wikis) {
    const r = await fetch(`https://${wiki}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) continue;
    const d = await r.json();
    return { title: d.title, summary: d.extract };
  }
  return { error: "Not found on Wikipedia." };
}

/**
 * A web page as plain text, for summarising. Only public https pages: an http link is read
 * over https, and every redirect is checked again (net.mjs), so a link can never point the
 * server at itself, the home network or a cloud metadata address.
 */
async function readLink(raw) {
  const typed = String(raw || "").trim();
  let url;
  try {
    url = new URL(typed);
  } catch {
    return { error: "That doesn't look like a link." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { error: "Only web links can be read." };
  url = publicHttps(url.href.replace(/^http:/i, "https:"));
  if (!url) return { error: "EDITH can only read public web pages." };
  let res;
  try {
    res = await publicFetch(url.href, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,text/plain;q=0.9" },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    }, { upgradeHttp: true });
  } catch (err) {
    if (err instanceof UnsafeAddressError) return { error: "That link leads somewhere EDITH can't read." };
    return { error: "Couldn't open that page." };
  }
  if (!res.ok) return { error: `That page answered ${res.status}.` };
  const type = res.headers.get("content-type") || "";
  if (!/text\/html|text\/plain|application\/xhtml/.test(type)) return { error: "That link isn't a web page." };
  const html = (await res.text()).slice(0, MAX_PAGE_CHARS);
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").trim().slice(0, 200);
  const text = decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]*/g, "\n")
    .replace(/\n{2,}/g, "\n\n")
    .trim()
    .slice(0, MAX_PAGE_TEXT);
  return text ? { title, url: url.href, text } : { error: "That page had no text to read." };
}

/** What's in the calendar the phone sent, for the range asked about. */
function calendarEvents(events, range = "next") {
  const list = Array.isArray(events) ? events : [];
  if (!list.length) return { found: 0, note: "Nothing in the calendar for the next two weeks." };
  const wanted = String(range || "next").toLowerCase();
  const days = wanted === "today" ? 0 : wanted === "tomorrow" ? 1 : wanted === "week" ? 7 : null;
  const picked = days === null
    ? list.slice(0, 3)
    : list.filter((e) => (wanted === "tomorrow" ? e.day === 1 : e.day <= days));
  if (!picked.length) {
    return { found: 0, note: wanted === "today" ? "Nothing in the calendar today." : `Nothing in the calendar ${wanted === "tomorrow" ? "tomorrow" : "this week"}.` };
  }
  return {
    found: picked.length,
    events: picked.slice(0, 20).map((e) => ({ when: e.when, what: e.title, ...(e.where ? { where: e.where } : {}) })),
  };
}

/**
 * Runs a tool call. ctx: { uk, flags, localTime, language, location, calendar, home, actions }.
 * Never throws.
 */
export async function runTool(name, args, ctx) {
  try {
    switch (name) {
      case "save_memory":
        await saveMemory(ctx.uk, args.category, args.key, args.value);
        ctx.flags.memoryChanged = true;
        return { ok: true };
      case "web_search": {
        const d = await getJson(`https://api.duckduckgo.com/?q=${encodeURIComponent(args.query)}&format=json&no_html=1`);
        const bits = [];
        if (d.AbstractText) bits.push(d.AbstractText);
        (d.RelatedTopics || []).slice(0, 5).forEach((t) => t.Text && bits.push(t.Text));
        return { results: bits.length ? bits : ["No direct answer found."] };
      }
      case "wikipedia":
        return await wikipedia(args.query, ctx.language);
      case "weather_report":
        return await weather({ city: args.city, location: ctx.location, language: ctx.language });
      case "news_headlines":
        return await headlines(args.topic, 5, ctx.language);
      case "recall_conversations":
        return await recall(ctx.uk, args.query, args.months_back);
      case "nearby_places":
        return ctx.location
          ? await nearbyPlaces(ctx.location, args.what, ctx.language, { km: args.within_km })
          : { error: "EDITH doesn't have the user's location. They can turn it on in EDITH's settings." };
      case "calendar_events":
        return calendarEvents(ctx.calendar, args.range);
      case "read_link":
        return await readLink(args.url);
      case "set_timer": {
        const minutes = Number(args.minutes);
        if (!Number.isFinite(minutes) || minutes <= 0) return { error: "Say how many minutes." };
        const capped = Math.min(MAX_TIMER_MINUTES, Math.max(0.5, minutes));
        const label = String(args.label || "").replace(/\s+/g, " ").trim().slice(0, 30);
        ctx.flags.timers.push({ ms: Math.round(capped * 60_000), label });
        return { ok: true, minutes: capped, label, note: "The glasses are showing the countdown." };
      }
      case "cancel_timers":
        ctx.flags.cancelTimers = true;
        return { ok: true };
      case "set_alarm": {
        const at = clockTime(args.time);
        if (!at) return { error: "Give the time as HH:MM on a 24-hour clock." };
        const label = String(args.label || "").replace(/\s+/g, " ").trim().slice(0, 30);
        // The phone works out how long that is from its own clock; ms is only a fallback.
        ctx.flags.timers.push({ ms: msUntil(at, ctx.localTime), label, at });
        return { ok: true, at, label, note: "The glasses will show the alarm while EDITH is open." };
      }
      case "my_lists": {
        const lists = await getLists(ctx.uk);
        return lists.length
          ? { lists: lists.map((list) => ({ name: list.name, items: list.items.length, left: list.items.length - list.done.length })) }
          : { lists: [], note: "They have no lists yet. show_list makes one." };
      }
      case "show_list": {
        const name = cleanName(args.name);
        if (!name) return { error: "Say which list." };
        const lists = await getLists(ctx.uk);
        const before = findList(lists, name) ?? { name, items: [], done: [], updated: Date.now() };
        const after = changeList(before, args);
        const saved = await saveList(ctx.uk, after);
        if (!saved) return { error: "That list couldn't be saved." };
        ctx.flags.list = { name: saved.name, items: saved.items, done: saved.done };
        return {
          name: saved.name,
          items: saved.items.map((item, i) => ({ item, done: saved.done.includes(i) })),
          note: saved.items.length ? "The list is on their glasses; a tap ticks things off." : "The list is empty now.",
        };
      }
      case "ask_to_pick": {
        const options = (Array.isArray(args.options) ? args.options : [])
          .map((option) => String(option ?? "").replace(/\s+/g, " ").trim().slice(0, 60))
          .filter(Boolean)
          .slice(0, 8);
        if (options.length < 2) return { error: "Give at least two things to choose between." };
        ctx.flags.pick = { question: String(args.question || "").replace(/\s+/g, " ").trim().slice(0, 120), options };
        return { ok: true, note: "They are choosing on their glasses; their choice arrives as their next message." };
      }
      case "home_status":
        return await homeStatus(ctx.home, args.query);
      case "home_control":
        return await homeControl(ctx.home, ctx.uk, args, ctx.flags);
      case "run_action":
        return await runAction(ctx.actions, args.name);
      case "daily_briefing": {
        const [w, news] = await Promise.all([
          args.city || ctx.location ? settle(weather({ city: args.city, location: ctx.location, language: ctx.language })) : { error: "No city given." },
          settle(headlines("", 4, ctx.language)),
        ]);
        const today = calendarEvents(ctx.calendar, "today");
        return {
          local_time: ctx.localTime || new Date().toUTCString(),
          weather: w,
          ...(ctx.calendar?.length ? { calendar: today } : {}),
          news,
        };
      }
      default:
        return { error: `Unknown tool ${name}` };
    }
  } catch (e) {
    return { error: String(e.message || e) };
  }
}
