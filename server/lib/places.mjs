// Where the wearer is, when they turn on "Use my location": the town their coordinates are
// in, and places near them. The phone rounds coordinates to about 100 m before sending them
// as X-Edith-Location, and they are never stored with a question.
//
// Both lookups use OpenStreetMap's Nominatim, which asks for an identifying User-Agent and
// light use, so the town for a set of coordinates is cached for a month.

import { readJSON, writeJSON } from "./storage.mjs";

const TIMEOUT_MS = 6000;
const USER_AGENT = "EDITH/1.6 (Even Realities G2 assistant)";
const NOMINATIM = "https://nominatim.openstreetmap.org";
const CITY_CACHE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_RADIUS_M = 2000;
const MAX_RADIUS_M = 20000;

/** The "lat,lon" of the X-Edith-Location header as numbers, or null when it isn't usable. */
export function readLocation(raw) {
  const [lat, lon] = String(raw || "").split(",").map((part) => Number(part.trim()));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  return { lat: Math.round(lat * 1000) / 1000, lon: Math.round(lon * 1000) / 1000 };
}

const askJson = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

/** Metres between two points. */
export function metresBetween(a, b) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** The town or city at these coordinates, in the wearer's language. Cached for a month. */
export async function cityAt(loc, language = "en") {
  const key = `geo/${loc.lat.toFixed(2)},${loc.lon.toFixed(2)}/${language}`;
  const cached = await readJSON(key, null);
  if (cached && Date.now() - cached.at < CITY_CACHE_MS) return cached.city;
  try {
    const d = await askJson(
      `${NOMINATIM}/reverse?lat=${loc.lat}&lon=${loc.lon}&format=jsonv2&zoom=12&accept-language=${encodeURIComponent(language || "en")}`,
    );
    const a = d.address || {};
    const town = a.city || a.town || a.village || a.municipality || a.county || a.state || "";
    const city = [town, a.country].filter(Boolean).join(", ");
    if (!city) return "";
    await writeJSON(key, { city, at: Date.now() });
    return city;
  } catch {
    return "";
  }
}

/** One sweep of the map around the wearer, out to `radius` metres. */
async function search(loc, query, language, radius, limit) {
  // A box roughly `radius` around the wearer: 1 degree of latitude is about 111 km.
  const dLat = radius / 111_000;
  const dLon = radius / (111_000 * Math.max(0.2, Math.cos((loc.lat * Math.PI) / 180)));
  const viewbox = [loc.lon - dLon, loc.lat + dLat, loc.lon + dLon, loc.lat - dLat].map((n) => n.toFixed(5)).join(",");
  const found = await askJson(
    `${NOMINATIM}/search?q=${encodeURIComponent(query)}&format=jsonv2&limit=20&bounded=1&viewbox=${viewbox}` +
    `&accept-language=${encodeURIComponent(language || "en")}`,
  );
  return (Array.isArray(found) ? found : [])
    .map((p) => ({
      name: p.name || String(p.display_name || "").split(",")[0],
      kind: String(p.type || "").replace(/_/g, " "),
      where: String(p.display_name || "").split(",").slice(1, 3).join(",").trim(),
      metres_away: metresBetween(loc, { lat: Number(p.lat), lon: Number(p.lon) }),
    }))
    .filter((p) => p.name && p.metres_away <= radius)
    .sort((a, b) => a.metres_away - b.metres_away)
    .slice(0, limit);
}

/**
 * Places near the wearer matching what they asked for, nearest first. `km` is how far to
 * look, up to 25; when nothing turns up nearby EDITH widens the net once by itself rather
 * than making them ask again (a tester hit the old fixed 2 km wall).
 */
export async function nearbyPlaces(loc, what, language = "en", { km = 0, limit = 5 } = {}) {
  const query = String(what || "").trim().slice(0, 80);
  if (!query) return { error: "Say what to look for, like a café or a pharmacy." };
  const wanted = Number(km) > 0 ? Math.min(MAX_RADIUS_M, Math.max(500, Math.round(Number(km) * 1000))) : DEFAULT_RADIUS_M;
  try {
    const near = await search(loc, query, language, wanted, limit);
    if (near.length) return { found: near.length, within_km: round1(wanted / 1000), places: near };
    if (wanted >= MAX_RADIUS_M) return { found: 0, note: `Nothing like "${query}" within ${round1(wanted / 1000)} km, which is as far as this can look.` };

    const wider = Math.min(MAX_RADIUS_M, wanted * 5);
    const far = await search(loc, query, language, wider, limit);
    return far.length
      ? { found: far.length, within_km: round1(wider / 1000), widened: true, note: `Nothing within ${round1(wanted / 1000)} km, so this looked out to ${round1(wider / 1000)} km.`, places: far }
      : { found: 0, note: `Nothing like "${query}" within ${round1(wider / 1000)} km.` };
  } catch {
    return { error: "Couldn't search for places right now." };
  }
}

const round1 = (n) => Math.round(n * 10) / 10;
