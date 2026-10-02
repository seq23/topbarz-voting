// GET /api/beats — the beats the select page (/select) plays and lets a visitor pick from, in
// display order. Read-only: the pick itself is kept on the visitor's device and never sent here.
// Does not look at the voting window, so the select page works the same after voting closes.
// Public and never per-visitor, so it is cached for a few seconds in this isolate.
import { BEATS_CACHE_SECONDS, buildBeats } from "../_lib/beats.js";
import { json, route } from "../_lib/http.js";

let memo = null; // { at, body, env } — public data only

const respond = (body, source) => json(JSON.parse(body), 200, {
  "cache-control": `public, max-age=${BEATS_CACHE_SECONDS}`,
  "x-beats-cache": source,
});

export const onRequest = route({
  async GET({ env }) {
    const now = Date.now();
    if (memo && memo.env === env && now - memo.at < BEATS_CACHE_SECONDS * 1000) return respond(memo.body, "memory");
    const body = JSON.stringify(await buildBeats(env));
    memo = { at: now, body, env };
    return respond(body, "miss");
  },
});

// Tests build a fresh database per case; this drops the isolate memo between them.
export function _resetBeatsMemo() { memo = null; }
