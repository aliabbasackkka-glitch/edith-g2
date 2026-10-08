// Smart home and custom actions (EDITH 1.6.0 and later).
//
//   Home Assistant: the wearer puts in their own address and a long-lived access token on
//   the phone. Both come with each question and are never stored or logged here; the server
//   calls Home Assistant's REST API with them.
//   Actions: webhooks the wearer sets up (IFTTT, Zapier, Home Assistant automations...).
//
// Anything that unlocks or opens the way into a home (locks, garage and entrance covers,
// alarms) is never done by the AI alone: it becomes a confirmation the wearer taps on the
// glasses, kept in storage for two minutes under confirm/<uk>/<token>.

import crypto from "node:crypto";
import { publicFetch, publicHttps } from "./net.mjs";
import { readJSON, removeKey, writeJSON } from "./storage.mjs";

// Which addresses the server may call is decided in net.mjs; exported from here as before.
export { publicHttps };

const TIMEOUT_MS = 8000;
const MAX_ENTITIES = 120;
const MAX_ACTIONS = 10;
const CONFIRM_MS = 2 * 60 * 1000;

/** Things EDITH can switch, and how each kind is told to do something. */
const SERVICES = {
  light: { on: "turn_on", off: "turn_off", toggle: "toggle", set: "turn_on" },
  switch: { on: "turn_on", off: "turn_off", toggle: "toggle" },
  input_boolean: { on: "turn_on", off: "turn_off", toggle: "toggle" },
  fan: { on: "turn_on", off: "turn_off", toggle: "toggle", set: "set_percentage" },
  humidifier: { on: "turn_on", off: "turn_off", toggle: "toggle" },
  cover: { open: "open_cover", close: "close_cover", stop: "stop_cover", on: "open_cover", off: "close_cover" },
  lock: { lock: "lock", unlock: "unlock", off: "lock", on: "unlock" },
  climate: { on: "turn_on", off: "turn_off", set: "set_temperature" },
  water_heater: { on: "turn_on", off: "turn_off", set: "set_temperature" },
  media_player: { on: "media_play", off: "media_pause", toggle: "media_play_pause", set: "volume_set" },
  vacuum: { on: "start", off: "return_to_base" },
  scene: { on: "turn_on" },
  script: { on: "turn_on" },
  button: { on: "press" },
};

export const HOME_DOMAINS = Object.keys(SERVICES);

/** Whether a request would open the way into someone's home, so the wearer must tap to confirm. */
export function needsTap(entityId, service, attributes = {}) {
  const domain = String(entityId).split(".")[0];
  if (domain === "lock") return service === "unlock" || service === "open";
  if (domain === "alarm_control_panel") return true;
  if (domain === "cover") {
    const kind = String(attributes.device_class || "");
    return ["garage", "door", "gate"].includes(kind) && service === "open_cover";
  }
  return false;
}

/** The Home Assistant details sent with a question, or null when there are none to use. */
export function cleanHome(raw) {
  const url = publicHttps(raw?.url);
  const token = String(raw?.token || "").trim();
  if (!url || !token || token.length > 2000) return null;
  return { base: url.origin + url.pathname.replace(/\/+$/, ""), token };
}

/** The wearer's own actions (webhooks), as sent with a question. */
export function cleanActions(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((a) => ({
      name: String(a?.name || "").replace(/\s+/g, " ").trim().slice(0, 40),
      url: publicHttps(a?.url)?.href || "",
      method: String(a?.method || "POST").toUpperCase() === "GET" ? "GET" : "POST",
    }))
    .filter((a) => a.name && a.url)
    .slice(0, MAX_ACTIONS);
}

async function homeFetch(home, path, init = {}) {
  // Redirects are checked hop by hop, and the token never follows one to another host.
  const res = await publicFetch(`${home.base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${home.token}`, "Content-Type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) throw new Error("Home Assistant didn't accept the access token.");
  if (!res.ok) throw new Error(`Home Assistant said ${res.status}.`);
  return res.json();
}

const friendly = (entity) => String(entity.attributes?.friendly_name || entity.entity_id.split(".")[1].replace(/_/g, " "));

/** What the home has, newest state first for anything matching `query`. */
export async function homeStatus(home, query = "") {
  if (!home) return { error: "No smart home is connected. Add Home Assistant in EDITH's settings on the phone." };
  let states;
  try {
    states = await homeFetch(home, "/api/states");
  } catch (err) {
    return { error: String(err.message || err) };
  }
  const words = String(query || "").toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const all = (Array.isArray(states) ? states : [])
    .filter((e) => HOME_DOMAINS.includes(String(e.entity_id).split(".")[0]))
    .map((e) => ({
      entity: e.entity_id,
      name: friendly(e),
      state: e.state,
      area: e.attributes?.area || "",
      kind: e.attributes?.device_class || "",
    }));
  const matching = words.length ? all.filter((e) => words.some((w) => `${e.name} ${e.entity}`.toLowerCase().includes(w))) : [];
  const shown = (matching.length ? matching : all).slice(0, MAX_ENTITIES);
  return { count: shown.length, of: all.length, devices: shown };
}

/** Finds the entity the wearer means, by id or by name. */
async function findEntity(home, wanted) {
  const asked = String(wanted || "").trim().toLowerCase();
  if (!asked) return { error: "Say which device." };
  let states;
  try {
    states = await homeFetch(home, "/api/states");
  } catch (err) {
    return { error: String(err.message || err) };
  }
  const usable = (Array.isArray(states) ? states : []).filter((e) => HOME_DOMAINS.includes(String(e.entity_id).split(".")[0]));
  const byId = usable.find((e) => e.entity_id.toLowerCase() === asked);
  if (byId) return { entity: byId };
  const byName = usable.find((e) => friendly(e).toLowerCase() === asked)
    || usable.find((e) => friendly(e).toLowerCase().includes(asked))
    || usable.find((e) => e.entity_id.toLowerCase().includes(asked.replace(/\s+/g, "_")));
  return byName ? { entity: byName } : { error: `No device called "${wanted}".` };
}

/**
 * Switches something in the home. Anything that unlocks or opens a way in comes back as a
 * confirmation for the wearer to tap, rather than being done here.
 */
export async function homeControl(home, uk, { device, action, value }, flags = {}) {
  if (!home) return { error: "No smart home is connected. Add Home Assistant in EDITH's settings on the phone." };
  const found = await findEntity(home, device);
  if (found.error) return found;
  const entity = found.entity;
  const domain = entity.entity_id.split(".")[0];
  const wanted = String(action || "").toLowerCase();
  const service = SERVICES[domain]?.[wanted];
  if (!service) return { error: `Can't "${action}" a ${domain}.` };

  const data = { entity_id: entity.entity_id };
  const number = Number(value);
  if (Number.isFinite(number)) {
    if (domain === "light") data.brightness_pct = Math.max(0, Math.min(100, number));
    else if (domain === "fan") data.percentage = Math.max(0, Math.min(100, number));
    else if (domain === "climate" || domain === "water_heater") data.temperature = number;
    else if (domain === "media_player") data.volume_level = Math.max(0, Math.min(1, number > 1 ? number / 100 : number));
  }
  const name = friendly(entity);
  if (needsTap(entity.entity_id, service, entity.attributes)) {
    // A request without a phone id has nowhere of its own to keep the confirmation.
    if (!uk || uk === "anon") return { error: "This needs a tap on the glasses to confirm, which only works from EDITH's app." };
    const token = crypto.randomBytes(18).toString("base64url");
    const what = `${wanted === "unlock" ? "Unlock" : wanted === "open" ? "Open" : "Switch"} ${name}`;
    await writeJSON(`confirm/${uk}/${token}`, { domain, service, data, what, at: Date.now() });
    // The token goes to the phone with the answer, never into what the AI sees.
    flags.confirm = { what, token };
    return { needs_confirmation: true, what, note: "Tell the user to tap the glasses to confirm; EDITH is already showing the prompt." };
  }
  try {
    await homeFetch(home, `/api/services/${domain}/${service}`, { method: "POST", body: JSON.stringify(data) });
  } catch (err) {
    return { error: String(err.message || err) };
  }
  return { ok: true, device: name, did: wanted };
}

/** Carries out a confirmation the wearer tapped, once. */
export async function confirmHome(home, uk, token) {
  const id = String(token || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  if (!id || !uk || uk === "anon") return { ok: false, error: "Nothing to confirm." };
  const pending = await readJSON(`confirm/${uk}/${id}`, null);
  await removeKey(`confirm/${uk}/${id}`);
  if (!pending || Date.now() - pending.at > CONFIRM_MS) return { ok: false, error: "That confirmation expired." };
  if (!home) return { ok: false, error: "No smart home is connected." };
  try {
    await homeFetch(home, `/api/services/${pending.domain}/${pending.service}`, { method: "POST", body: JSON.stringify(pending.data) });
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
  return { ok: true, what: pending.what };
}

/** Runs one of the wearer's own actions (a webhook). */
export async function runAction(actions, wanted) {
  const list = cleanActions(actions);
  if (!list.length) return { error: "No actions are set up. Add one in EDITH's settings on the phone." };
  const asked = String(wanted || "").trim().toLowerCase();
  const action = list.find((a) => a.name.toLowerCase() === asked)
    || list.find((a) => a.name.toLowerCase().includes(asked))
    || list.find((a) => asked.includes(a.name.toLowerCase()));
  if (!action) return { error: `No action called "${wanted}". There is: ${list.map((a) => a.name).join(", ")}.` };
  try {
    // A webhook that redirects is only followed to an address EDITH would call itself.
    const res = await publicFetch(action.url, {
      method: action.method,
      headers: { "User-Agent": "EDITH/1.6 (Even Realities G2 assistant)" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { error: `"${action.name}" answered ${res.status}.` };
    const said = (await res.text().catch(() => "")).trim().slice(0, 200);
    return { ok: true, action: action.name, ...(said ? { answered: said } : {}) };
  } catch {
    return { error: `Couldn't reach "${action.name}".` };
  }
}
