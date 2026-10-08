/**
 * EDITH's server on Netlify Functions, an alternative to Cloudflare Workers: every
 * /api/* call arrives here (see netlify.toml). The routes themselves live in
 * server/app.mjs and are shared with Cloudflare.
 *
 * Storage is Netlify Blobs.
 */

import { getStore } from "@netlify/blobs";
import { configureServer, handle } from "../../server/app.mjs";

function blobStorage() {
  let store = null;
  const blobs = () => (store ??= getStore({ name: "edith", consistency: "strong" }));
  return {
    kind: "blobs",
    get: (key) => blobs().get(key, { type: "json" }),
    set: (key, value) => blobs().setJSON(key, value),
    delete: (key) => blobs().delete(key),
    async list(prefix) {
      const { blobs: found } = await blobs().list({ prefix });
      const rows = await Promise.all(found.map(async ({ key }) => ({ key, value: await blobs().get(key, { type: "json" }) })));
      return rows.filter((row) => row.value !== null);
    },
  };
}

configureServer({
  host: "netlify",
  storage: blobStorage(),
  clientIpHeader: "x-nf-client-connection-ip",
});

export default (req, context) => handle(req, context);
