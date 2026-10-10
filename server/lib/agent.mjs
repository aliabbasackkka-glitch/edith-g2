// EDITH 3 (beta): the glasses using your own PC, through EDITH's PC app.
//
// The PC app shows a 6-digit code; the wearer says it on the glasses ("link my PC, code
// 482 193") and from then on a question on the glasses can call tools the PC app carries
// out on that computer: finding and reading files, building things in EDITH's workspace
// folder, opening links, the clipboard, notes on screen and tasks it runs on a schedule.
// Nothing that changes the PC outside that folder, and no command, runs before the wearer
// taps the glasses to approve it.
//
// The PC app asks for work (a long poll) rather than being reached: nothing on the PC is
// opened to the internet. It proves who it is with a secret only its hash is kept of.
//
//   agent/pc/<pcId>           { secretHash, name, os, linkedTo, seen, code, codeAt }
//   agent/code/<code>         { pcId, at }              a link code, for 10 minutes
//   agent/link/<uk>           { pcId, name, at }        which PC a phone uses
//   agent/job/<pcId>/<jobId>  { tool, args, approved, at }
//   agent/run/<jobId>         { pcId, at }              picked up, waiting for its answer
//   agent/done/<jobId>        { result, at }

import crypto from "node:crypto";
import { isAnon, listJSON, readJSON, removeKey, writeJSON } from "./storage.mjs";

const CODE_MS = 10 * 60 * 1000;
/** A PC that hasn't asked for work in this long is treated as switched off. */
const OFFLINE_MS = 90 * 1000;
/** How long the PC app's request for work is held open, and how often it is checked. */
const POLL_MS = 20 * 1000;
const POLL_EVERY_MS = 450;
const MAX_RESULT_CHARS = 24_000;

const hash = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanId = (s) => String(s || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 48);
const cleanName = (s) => String(s || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40) || "PC";

/** The PC app's own record, if it is who it says it is. */
async function authPc(body) {
  const pcId = cleanId(body?.pcId);
  const secret = String(body?.secret || "");
  if (pcId.length < 16 || secret.length < 32) return null;
  const rec = await readJSON(`agent/pc/${pcId}`, null);
  if (!rec) return { pcId, rec: null, secret };
  if (!crypto.timingSafeEqual(Buffer.from(hash(secret)), Buffer.from(rec.secretHash))) return false;
  return { pcId, rec, secret };
}

/** The PC app says hello: registers it the first time, and gives it a code until it is linked. */
export async function pcHello(body) {
  const who = await authPc(body);
  if (who === false) return { status: 403, body: { error: "This PC's key doesn't match. Unlink it in EDITH's PC app and link again." } };
  if (!who) return { status: 400, body: { error: "Missing PC id or key." } };
  const now = Date.now();
  const rec = who.rec || { secretHash: hash(who.secret), linkedTo: null, created: now };
  rec.name = cleanName(body.name);
  rec.os = String(body.os || "").slice(0, 40);
  rec.seen = now;
  if (rec.linkedTo && !(await readJSON(`agent/link/${rec.linkedTo}`, null))) rec.linkedTo = null;
  if (!rec.linkedTo && (!rec.code || now - (rec.codeAt || 0) > CODE_MS - 60_000)) {
    if (rec.code) await removeKey(`agent/code/${rec.code}`);
    let code = "";
    for (let i = 0; i < 8 && !code; i++) {
      const tryCode = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
      if (!(await readJSON(`agent/code/${tryCode}`, null))) code = tryCode;
    }
    rec.code = code;
    rec.codeAt = now;
    await writeJSON(`agent/code/${code}`, { pcId: who.pcId, at: now });
  }
  await writeJSON(`agent/pc/${who.pcId}`, rec);
  return { status: 200, body: rec.linkedTo ? { linked: true } : { linked: false, code: rec.code, expiresIn: Math.max(0, CODE_MS - (now - rec.codeAt)) } };
}

/** The PC app unlinks itself (its "UNLINK" button). */
export async function pcForget(body) {
  const who = await authPc(body);
  if (!who || !who.rec) return { status: who === false ? 403 : 200, body: { ok: who !== false } };
  if (who.rec.linkedTo) await removeKey(`agent/link/${who.rec.linkedTo}`);
  if (who.rec.code) await removeKey(`agent/code/${who.rec.code}`);
  await removeKey(`agent/pc/${who.pcId}`);
  return { status: 200, body: { ok: true } };
}

/** The glasses say the code: this phone now uses that PC. */
export async function linkPc(uk, rawCode) {
  if (isAnon(uk)) return { error: "Linking a PC only works from EDITH's app on the glasses." };
  const code = String(rawCode ?? "").replace(/\D/g, "");
  if (code.length !== 6) return { error: "The code is the 6 digits EDITH's PC app shows. Ask the user to read it again." };
  const pending = await readJSON(`agent/code/${code}`, null);
  if (!pending || Date.now() - pending.at > CODE_MS) return { error: "That code isn't right or has expired. EDITH's PC app shows the current one." };
  const rec = await readJSON(`agent/pc/${pending.pcId}`, null);
  if (!rec) return { error: "That PC isn't set up any more. Open EDITH's PC app and try again." };
  const old = await readJSON(`agent/link/${uk}`, null);
  if (old && old.pcId !== pending.pcId) {
    const oldRec = await readJSON(`agent/pc/${old.pcId}`, null);
    if (oldRec) await writeJSON(`agent/pc/${old.pcId}`, { ...oldRec, linkedTo: null });
  }
  if (rec.linkedTo && rec.linkedTo !== uk) await removeKey(`agent/link/${rec.linkedTo}`);
  await writeJSON(`agent/pc/${pending.pcId}`, { ...rec, linkedTo: uk, code: "", codeAt: 0 });
  await writeJSON(`agent/link/${uk}`, { pcId: pending.pcId, name: rec.name, at: Date.now() });
  await removeKey(`agent/code/${code}`);
  return { ok: true, pc: rec.name };
}

export async function unlinkPc(uk) {
  const link = await readJSON(`agent/link/${uk}`, null);
  if (!link) return { ok: true, note: "No PC was linked." };
  const rec = await readJSON(`agent/pc/${link.pcId}`, null);
  if (rec) await writeJSON(`agent/pc/${link.pcId}`, { ...rec, linkedTo: null });
  await removeKey(`agent/link/${uk}`);
  return { ok: true, unlinked: link.name };
}

/** The PC this phone uses, or null. */
export async function linkedPc(uk) {
  if (isAnon(uk)) return null;
  return readJSON(`agent/link/${uk}`, null);
}

/**
 * Asks the linked PC to run one tool and waits for its answer. `approved` is only ever set
 * once the wearer tapped the glasses to approve exactly this.
 */
export async function callPc(uk, tool, args, { approved = false, waitMs = 30_000 } = {}) {
  const link = await linkedPc(uk);
  if (!link) return { error: "No PC is linked. In EDITH's PC app press LINK GLASSES, then say the code it shows." };
  const rec = await readJSON(`agent/pc/${link.pcId}`, null);
  if (!rec || rec.linkedTo !== uk) return { error: "That PC was unlinked. Link it again from EDITH's PC app." };
  if (Date.now() - (rec.seen || 0) > OFFLINE_MS) return { error: `${rec.name} isn't connected right now: EDITH's PC app has to be open on it.` };
  const jobId = crypto.randomBytes(12).toString("hex");
  await writeJSON(`agent/job/${link.pcId}/${jobId}`, { tool, args: args ?? {}, approved: Boolean(approved), at: Date.now() });
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await sleep(POLL_EVERY_MS);
    const done = await readJSON(`agent/done/${jobId}`, null);
    if (done) {
      await removeKey(`agent/done/${jobId}`);
      return done.result ?? { ok: true };
    }
  }
  // Still waiting to be picked up: take it back, so it doesn't run long after it was asked for.
  await removeKey(`agent/job/${link.pcId}/${jobId}`);
  return { error: `${rec.name} didn't answer in time. It may still be busy; ask again in a moment.` };
}

/**
 * The PC app asks for work: the oldest job, or nothing after a while. While it isn't linked
 * yet, the same wait is how it hears that the glasses said its code.
 */
export async function pcNext(body) {
  const who = await authPc(body);
  if (!who || !who.rec) return { status: who === false ? 403 : 404, body: { error: "Unknown PC. Link it again." } };
  const until = Date.now() + POLL_MS;
  let rec = who.rec;
  let checked = 0;
  let touched = 0;
  while (Date.now() < until) {
    if (Date.now() - checked > 3000) {
      rec = (await readJSON(`agent/pc/${who.pcId}`, null)) || rec;
      checked = Date.now();
      if (rec.linkedTo && Date.now() - touched > 30_000) {
        await writeJSON(`agent/pc/${who.pcId}`, { ...rec, seen: Date.now() });
        touched = Date.now();
      }
      // Just linked: say so straight away, so the PC app can show it.
      if (rec.linkedTo && !who.rec.linkedTo) return { status: 200, body: { linked: true, job: null } };
    }
    if (rec.linkedTo) {
      const jobs = await listJSON(`agent/job/${who.pcId}/`);
      if (jobs.length) {
        jobs.sort((x, y) => (x.value.at || 0) - (y.value.at || 0));
        const { key, value } = jobs[0];
        const jobId = key.split("/").pop();
        await removeKey(key);
        await writeJSON(`agent/run/${jobId}`, { pcId: who.pcId, at: Date.now() });
        return { status: 200, body: { linked: true, job: { id: jobId, tool: value.tool, args: value.args, approved: Boolean(value.approved) } } };
      }
    }
    await sleep(rec.linkedTo ? POLL_EVERY_MS : 1000);
  }
  return { status: 200, body: { linked: Boolean(rec.linkedTo), job: null } };
}

/** The PC app's answer to a job it picked up. */
export async function pcDone(body) {
  const who = await authPc(body);
  if (!who || !who.rec) return { status: 403, body: { error: "Unknown PC." } };
  const jobId = cleanId(body.jobId);
  const run = await readJSON(`agent/run/${jobId}`, null);
  if (!run || run.pcId !== who.pcId) return { status: 404, body: { error: "No such job." } };
  await removeKey(`agent/run/${jobId}`);
  let result = body.result && typeof body.result === "object" ? body.result : { ok: true };
  if (JSON.stringify(result).length > MAX_RESULT_CHARS) result = { ...result, text: String(result.text || result.output || "").slice(0, MAX_RESULT_CHARS - 500), truncated: true, output: undefined };
  await writeJSON(`agent/done/${jobId}`, { result, at: Date.now() });
  return { status: 200, body: { ok: true } };
}

/** What a PC tool did, as one line for the glasses after the wearer approved it. */
export function resultLine(result) {
  if (!result || typeof result !== "object") return "Done.";
  if (result.error) return `Couldn't: ${result.error}`;
  const out = String(result.output ?? result.text ?? "").trim();
  if (out) return out.length > 700 ? `${out.slice(0, 700)}…` : out;
  return result.note ? String(result.note) : "Done.";
}

/** How long an approve prompt stays open on the glasses, as for the smart home. */
const APPROVE_MS = 2 * 60 * 1000;

/**
 * Holds a PC job until the wearer taps the glasses to approve it. The token goes to the
 * phone with the answer, never into what the AI sees.
 */
export async function askToApprove(uk, flags, tool, args, what) {
  if (isAnon(uk)) return { error: "Approving needs EDITH's app on the glasses." };
  const token = crypto.randomBytes(18).toString("base64url");
  const shown = String(what || tool).replace(/\s+/g, " ").trim().slice(0, 200);
  await writeJSON(`confirm/${uk}/${token}`, { kind: "pc", tool, args, what: shown, at: Date.now() });
  flags.confirm = { what: shown, token, kind: "pc" };
  return {
    needs_approval: true,
    what: shown,
    note: "EDITH is showing an approve prompt on the glasses. Tell the user to tap to approve (double-tap cancels). It has not run yet; don't say it is done.",
  };
}

/**
 * The wearer tapped to approve: runs the held job on the PC, once. Returns null when the
 * token isn't a PC job (so the smart home can have it).
 */
export async function confirmPc(uk, token) {
  const id = String(token || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  if (!id || isAnon(uk)) return null;
  const pending = await readJSON(`confirm/${uk}/${id}`, null);
  if (!pending || pending.kind !== "pc") return null;
  await removeKey(`confirm/${uk}/${id}`);
  if (Date.now() - pending.at > APPROVE_MS) return { ok: false, error: "That approval expired. Ask again." };
  const result = await callPc(uk, pending.tool, pending.args, { approved: true, waitMs: 75_000 });
  return { ok: !result?.error, what: pending.what, said: resultLine(result), error: result?.error };
}
