// Addresses EDITH's server calls on someone's behalf, and the networks its callers come from.
//
//   publicHttps()  only a public https host: never a LAN, loopback, link-local, carrier-NAT,
//                  benchmarking, multicast or reserved address, and never an IP literal for
//                  IPv6 (which covers IPv4-mapped addresses such as [::ffff:127.0.0.1]).
//   publicFetch()  fetch() for an address someone else chose. Redirects are never followed
//                  blindly: each Location is checked with publicHttps() again, at most three
//                  hops, and credentials never travel to a different host.
//   networkOf()    the caller's network for rate limits: an IPv4 address, or the /64 an IPv6
//                  address sits in (one household or phone usually owns a whole /64).
//
// A host name that resolves to a private address can't be caught here: Workers can't look
// names up, and can't reach private addresses either.

/** An IPv4 address in dotted-quad form (what a URL parser leaves) as four numbers, or null. */
export function ipv4Parts(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(host || ""));
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/** An IPv6 address as eight 16-bit numbers, or null. Takes "::", brackets, a zone and a trailing IPv4. */
export function ipv6Parts(raw) {
  let s = String(raw || "").trim().toLowerCase();
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    s = s.slice(1, end === -1 ? undefined : end);
  }
  s = s.replace(/%.*$/, "");
  if (!s.includes(":") || !/^[0-9a-f:.]+$/.test(s)) return null;
  let tail = [];
  const dotted = /(^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted) {
    const p = ipv4Parts(dotted[2]);
    if (!p) return null;
    tail = [p[0] * 256 + p[1], p[2] * 256 + p[3]];
    s = s.slice(0, s.length - dotted[2].length);
    if (s.endsWith(":") && !s.endsWith("::")) s = s.slice(0, -1);
  }
  if (s.includes(".")) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (part) => (part ? part.split(":") : []);
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  if ([...head, ...rest].some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const known = head.length + rest.length + tail.length;
  if (halves.length === 2 ? known > 7 : known !== 8) return null;
  const hex = (g) => parseInt(g, 16);
  return [...head.map(hex), ...(halves.length === 2 ? Array(8 - known).fill(0) : []), ...rest.map(hex), ...tail];
}

/* Not on the public internet (RFC 6890 and friends), as [a, b, c, d, prefix length]. */
const NOT_PUBLIC_V4 = [
  [0, 0, 0, 0, 8], // "this network"
  [10, 0, 0, 0, 8], // private
  [100, 64, 0, 0, 10], // carrier-grade NAT
  [127, 0, 0, 0, 8], // loopback
  [169, 254, 0, 0, 16], // link-local, cloud metadata
  [172, 16, 0, 0, 12], // private
  [192, 0, 0, 0, 24], // IETF protocol assignments
  [192, 0, 2, 0, 24], // documentation
  [192, 88, 99, 0, 24], // 6to4 relay
  [192, 168, 0, 0, 16], // private
  [198, 18, 0, 0, 15], // benchmarking
  [198, 51, 100, 0, 24], // documentation
  [203, 0, 113, 0, 24], // documentation
  [224, 0, 0, 0, 4], // multicast
  [240, 0, 0, 0, 4], // reserved, and 255.255.255.255
];

const asNumber = ([a, b, c, d]) => ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;

/** Whether an IPv4 address (four numbers) is somewhere on the public internet. */
export function isPublicIPv4(parts) {
  const ip = asNumber(parts);
  return !NOT_PUBLIC_V4.some(([a, b, c, d, bits]) => ip >>> (32 - bits) === asNumber([a, b, c, d]) >>> (32 - bits));
}

/**
 * Only addresses EDITH's server can safely call: a public https host. An address without
 * a scheme gets https, because the examples in the app's fields no longer show one - a
 * package may only carry addresses its manifest allows (1.7.4).
 */
export function publicHttps(raw) {
  const typed = String(raw || "").trim();
  if (!typed || typed.length > 2048) return null;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(typed) ? typed : `https://${typed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  // "localhost." is localhost: a trailing dot only says the name is complete.
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  // IPv6 literals, IPv4-mapped ones among them, are never called.
  if (!host || host.includes(":") || host.includes("[")) return null;
  const v4 = ipv4Parts(host);
  if (v4) return isPublicIPv4(v4) ? url : null;
  // A URL parser turns every numeric form of IPv4 into dotted quads; anything else all digits is not a host.
  if (/^[\d.]+$/.test(host)) return null;
  // One-label names only mean something on a local network.
  if (!host.includes(".")) return null;
  if (host === "localhost" || /\.(localhost|local|internal|home\.arpa)$/.test(host)) return null;
  return url;
}

export class UnsafeAddressError extends Error {}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const CREDENTIALS = ["authorization", "cookie", "proxy-authorization"];

const plainHeaders = (headers) =>
  headers instanceof Headers ? Object.fromEntries(headers.entries()) : { ...(headers || {}) };
const withoutHeaders = (headers, names) =>
  Object.fromEntries(Object.entries(plainHeaders(headers)).filter(([name]) => !names.includes(name.toLowerCase())));

/** "http://..." as "https://...", for links a person pasted (read_link): EDITH only reads over https. */
const upgraded = (raw) => String(raw || "").trim().replace(/^http:\/\//i, "https://");

/**
 * fetch() for an address someone else chose. It must be public https, and so must every
 * address it redirects to: each Location is checked again, for at most three hops. A 303,
 * or a 301/302 answering a POST, continues as a GET without the body, as browsers do.
 * Authorization and cookies never follow a redirect to another host.
 * upgradeHttp: an http address (first or redirected to) is tried over https instead.
 * Throws UnsafeAddressError for an address that may not be called.
 */
export async function publicFetch(raw, init = {}, { upgradeHttp = false } = {}) {
  const check = (address) => publicHttps(upgradeHttp ? upgraded(address) : address);
  let url = check(raw);
  if (!url) throw new UnsafeAddressError("That isn't a public https address.");
  let method = String(init.method || "GET").toUpperCase();
  let body = init.body;
  let headers = init.headers;
  for (let hop = 0; ; hop++) {
    const res = await fetch(url.href, { ...init, method, body, headers, redirect: "manual" });
    const location = REDIRECTS.has(res.status) ? res.headers.get("location") : null;
    if (!location) return res;
    res.body?.cancel?.().catch?.(() => {});
    if (hop >= MAX_REDIRECTS) throw new UnsafeAddressError("That address redirected too many times.");
    let next = null;
    try {
      next = check(new URL(location, url).href);
    } catch {
      next = null;
    }
    if (!next) throw new UnsafeAddressError("That address redirected somewhere EDITH won't go.");
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
      headers = withoutHeaders(headers, ["content-type", "content-length"]);
    }
    if (next.origin !== url.origin) headers = withoutHeaders(headers, CREDENTIALS);
    url = next;
  }
}

/**
 * The network a caller's IP address belongs to, for rate limits: the IPv4 address itself
 * (an IPv4-mapped IPv6 address counts as its IPv4), or the /64 of an IPv6 address, since
 * one subscriber usually holds a whole /64 and could otherwise count as billions of callers.
 */
export function networkOf(raw) {
  const ip = String(raw || "").split(",")[0].trim();
  const v4 = ipv4Parts(ip.replace(/:\d+$/, ""));
  if (v4) return v4.join(".");
  const v6 = ipv6Parts(ip);
  if (v6) {
    if (v6.slice(0, 5).every((g) => g === 0) && v6[5] === 0xffff) {
      return [v6[6] >> 8, v6[6] & 255, v6[7] >> 8, v6[7] & 255].join(".");
    }
    return `${v6.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
  }
  return ip.toLowerCase();
}
