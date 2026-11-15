// Fixed-window counters in D1. `limitStatements` returns statements to put in a batch with the
// rest of the request's reads (one round trip); `overLimit` reads their results.
import { LIMITS } from "./config.js";
import { HttpError } from "./http.js";

export function limitStatement(db, key, { window }, now = Date.now()) {
  const start = Math.floor(now / 1000 / window) * window;
  return db
    .prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1) ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1 RETURNING count")
    .bind(key, start);
}

export function assertUnderLimit(result, { max, window }, what) {
  const count = result?.results?.[0]?.count ?? 0;
  if (count > max) {
    throw new HttpError(429, "rate_limited", `Too many ${what} from here. Give it a minute and try again.`, { retry_after_seconds: window });
  }
}

// A row is dead only once EVERY window it could belong to has ended. The longest window in LIMITS
// (the site-wide day counter, 86400 s) is the bound: until 9 Oct 2026 the cutoff was two hours, so
// any prune after 02:00 UTC deleted the live day row and the 300-a-day cap started over (CI saw it
// as "the 301st upload got 200"). tests/ratelimit.test.mjs pins it.
export const LONGEST_WINDOW_S = Math.max(...Object.values(LIMITS).map((l) => l.window));
export function pruneCutoff(now = Date.now()) {
  return Math.floor(now / 1000) - LONGEST_WINDOW_S;
}

// Old windows are dead weight; clear them now and then (about 1 request in 50). `roll` is
// injectable so a test can force the prune.
export function maybePrune(context, now = Date.now(), roll = Math.random()) {
  if (roll > 0.02) return;
  context.waitUntil?.(context.env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?1").bind(pruneCutoff(now)).run().catch(() => {}));
}
