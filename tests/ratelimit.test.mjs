// The counters' cleanup never deletes a window that is still running.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS } from "../functions/_lib/config.js";
import { LONGEST_WINDOW_S, maybePrune, pruneCutoff } from "../functions/_lib/ratelimit.js";
import { makeEnv } from "./helpers.mjs";

const DAY = LIMITS.boothUploadsPerDay.window;

test("the prune cutoff is the longest window in LIMITS (the day counter), never a shorter fixed number", () => {
  assert.equal(LONGEST_WINDOW_S, DAY);
  assert.equal(DAY, 86400);
  const now = Date.UTC(2026, 9, 9, 22, 20, 0);
  assert.equal(pruneCutoff(now), Math.floor(now / 1000) - DAY);
});

test("a forced prune at 22:20 UTC keeps today's live day row and removes a window that has ended", async () => {
  const fresh = await makeEnv();
  try {
    const now = Date.UTC(2026, 9, 9, 22, 20, 0);
    const dayStart = Math.floor(now / 1000 / DAY) * DAY; // 00:00 UTC today, 22 h 20 m ago
    const deadHour = Math.floor(now / 1000 / 3600) * 3600 - 2 * DAY; // an hour window from two days ago
    await fresh.env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES ('booth-uploads-day', ?1, 299), ('ip:dead', ?2, 7)").bind(dayStart, deadHour).run();
    const pending = [];
    maybePrune({ env: fresh.env, waitUntil: (p) => pending.push(p) }, now, 0);
    assert.equal(pending.length, 1, "a roll of 0 forces the prune");
    await Promise.all(pending);
    const rows = (await fresh.env.DB.prepare("SELECT key, count FROM rate_limits ORDER BY key").all()).results;
    assert.deepEqual(rows, [{ key: "booth-uploads-day", count: 299 }], "the live day row survives; the dead hour row is gone");
    const skipped = [];
    maybePrune({ env: fresh.env, waitUntil: (p) => skipped.push(p) }, now, 0.5);
    assert.equal(skipped.length, 0, "a roll above 0.02 does nothing");
  } finally { await fresh.dispose(); }
});
