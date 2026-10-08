/**
 * EDITH's server on Cloudflare Workers. /api/* goes to the shared routes in
 * server/app.mjs; everything else (the web app and privacy.html) is served from
 * the built dist/ folder.
 *
 * Storage is a D1 database (binding DB). Optional secrets, each turning on a feature:
 *   FIREBASE_WEB_CONFIG, ACCOUNT_SECRET, FIREBASE_SERVICE_ACCOUNT, ACCOUNT_PROVIDERS
 *                       accounts                                 (npm run set-up-accounts)
 *   MODERATION_PROVIDER, MODERATION_KEY, MODERATION_MODEL
 *                       moderation                               (npm run set-moderation-key)
 *
 * /__/auth/* is Firebase's sign-in helper, passed through from <project>.firebaseapp.com
 * so the sign-in page at /signin and the helper share EDITH's address. Browsers that
 * block third-party cookies (Safari, and Chrome in time) need that for sign-in to work.
 */

import { configureServer, handle } from "../server/app.mjs";

/** JSON values in one key/value table, created on first use. */
function d1Storage(db) {
  let ready = null;
  const table = () =>
    (ready ??= db
      .prepare("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)")
      .run()
      .catch((err) => {
        ready = null;
        throw err;
      }));
  return {
    kind: "d1",
    async get(key) {
      await table();
      const row = await db.prepare("SELECT value FROM kv WHERE key = ?1").bind(key).first();
      return row ? JSON.parse(row.value) : null;
    },
    async set(key, value) {
      await table();
      await db
        .prepare(
          "INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        )
        .bind(key, JSON.stringify(value), Date.now())
        .run();
    },
    async delete(key) {
      await table();
      await db.prepare("DELETE FROM kv WHERE key = ?1").bind(key).run();
    },
    async list(prefix) {
      await table();
      // Keys from prefix up to (not including) the prefix with its last character bumped.
      const end = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
      const { results } = await db.prepare("SELECT key, value FROM kv WHERE key >= ?1 AND key < ?2").bind(prefix, end).all();
      return results.map((row) => ({ key: row.key, value: JSON.parse(row.value) }));
    },
  };
}

let configured = false;

function configure(env) {
  // The shared code reads settings from process.env, as on Node.
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string" && process.env[name] === undefined) process.env[name] = value;
  }
  configureServer({
    host: "cloudflare",
    storage: env.DB ? d1Storage(env.DB) : null,
    clientIpHeader: "cf-connecting-ip",
  });
  configured = true;
}

function firebaseAuthHelper(request, env) {
  let projectId = "";
  try {
    projectId = JSON.parse(env.FIREBASE_WEB_CONFIG || "{}").projectId || "";
  } catch {
    // not set up
  }
  if (!/^[a-z0-9-]{4,40}$/.test(projectId)) return new Response("Not found", { status: 404 });
  const { pathname, search } = new URL(request.url);
  return fetch(`https://${projectId}.firebaseapp.com${pathname}${search}`, {
    method: request.method,
    headers: request.headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  });
}

export default {
  async fetch(request, env, ctx) {
    if (!configured) configure(env);
    const { pathname } = new URL(request.url);
    if (pathname === "/api" || pathname.startsWith("/api/")) return handle(request, ctx);
    if (pathname.startsWith("/__/auth/") || pathname.startsWith("/__/firebase/")) return firebaseAuthHelper(request, env);
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
  },
};
