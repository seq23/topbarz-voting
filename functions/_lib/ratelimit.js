// Fixed-window counters in D1. `limitStatements` returns statements to put in a batch with the
// rest of the request's reads (one round trip); `overLimit` reads their results.
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

// Old windows are dead weight; clear them now and then (about 1 request in 50).
export function maybePrune(context, now = Date.now()) {
  if (Math.random() > 0.02) return;
  const cutoff = Math.floor(now / 1000) - 2 * 3600;
  context.waitUntil?.(context.env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?1").bind(cutoff).run().catch(() => {}));
}
