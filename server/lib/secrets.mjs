// Hashing and comparing secrets: sign-in and OpenRouter poll tokens, account and
// network ids. Nothing secret is ever stored as itself, only as its hash.

import crypto from "node:crypto";

export const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest();

/** Compares two secrets in constant time, so the comparison can't be timed. */
export const sameSecret = (a, b) => Boolean(a && b) && crypto.timingSafeEqual(sha256(a), sha256(b));
