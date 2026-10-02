// GET /api/state — the one thing every open page polls (about every 7 s).
// Tracks with like and comment counts, the voting end time, `closed`, the photo manifest, and the
// named states of the gate and the GIF picker.
//
// Never per-visitor: it is cached for STATE_CACHE_SECONDS in this isolate and at the edge (Cache
// API), so a couple of thousand pollers cost D1 one read every few seconds, not one each.
// A voter's own likes come from GET /api/me.
import { STATE_CACHE_SECONDS } from "../_lib/config.js";
import { json, route } from "../_lib/http.js";
import { buildState } from "../_lib/state.js";

let memo = null; // { at, body, env } — public data only

function respond(body, source) {
  return json(JSON.parse(body), 200, {
    "cache-control": `public, max-age=${STATE_CACHE_SECONDS}`,
    "x-state-cache": source,
  });
}

export const onRequest = route({
  async GET(context) {
    const { request, env } = context;
    const now = Date.now();
    if (memo && memo.env === env && now - memo.at < STATE_CACHE_SECONDS * 1000) return respond(memo.body, "memory");

    const edge = globalThis.caches?.default;
    const cacheKey = new Request(new URL("/api/state", request.url).toString(), { method: "GET" });
    if (edge) {
      const hit = await edge.match(cacheKey);
      if (hit) {
        const body = await hit.text();
        return respond(body, "edge");
      }
    }

    const body = JSON.stringify(await buildState(env, now));
    memo = { at: now, body, env };
    if (edge) {
      const stored = new Response(body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": `public, max-age=${STATE_CACHE_SECONDS}` } });
      context.waitUntil?.(edge.put(cacheKey, stored).catch(() => {}));
    }
    return respond(body, "miss");
  },
});

// Tests build a fresh database per case; this drops the isolate memo between them.
export function _resetStateMemo() { memo = null; }
