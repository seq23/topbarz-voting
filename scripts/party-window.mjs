#!/usr/bin/env node
// The holiday round's voting window on PREVIEW (staging and every PR preview), through the
// `settings` rows preview already honours (ALLOW_END_OVERRIDE; RUNBOOK "Prove the voting window").
// Production's window is a code change in functions/_lib/config.js, through a PR, once Scooter
// sends the event date: this script refuses production.
//   node scripts/party-window.mjs --env preview --starts 2026-11-16T00:00:00Z --ends 2026-12-31T07:59:00Z
//   node scripts/party-window.mjs --env preview --starts 2026-11-16T00:00:00Z --no-end   (open, no end: nothing closes,
//                                                         nothing counts down; Scooter, 18 Nov 2026: the cutoff is not set yet)
//   node scripts/party-window.mjs --env preview --clear     (back to the constants)
import { d1, parseArgs, sqlText, stopOnError, targets } from "./lib/cf.mjs";

stopOnError();
const args = parseArgs(process.argv.slice(2), { env: "value", starts: "value", ends: "value", clear: "flag", "no-end": "flag" });
if (args.env !== "preview" && args.env !== "local") { console.error("REFUSED: the window is set here for preview (or local) only. Production's window is VOTING_STARTS_AT / VOTING_ENDS_AT in functions/_lib/config.js, changed through a PR."); process.exit(2); }
const target = targets(args.env);
if (args.clear) {
  await d1(target, "DELETE FROM settings WHERE key IN ('voting_starts_at', 'voting_ends_at');");
  console.log(`cleared the window override in ${target.db}: the constants in config.js decide again.`);
  process.exit(0);
}
if (args["no-end"]) {
  const from = Date.parse(args.starts ?? "");
  if (!Number.isFinite(from)) { console.error("STOPPED: give --starts as an ISO time (UTC) with --no-end."); process.exit(2); }
  const rows = await d1(target, [
    `INSERT OR REPLACE INTO settings (key, value) VALUES ('voting_starts_at', ${sqlText(new Date(from).toISOString())});`,
    "DELETE FROM settings WHERE key = 'voting_ends_at';",
    "SELECT key, value FROM settings WHERE key IN ('voting_starts_at', 'voting_ends_at') ORDER BY key;",
  ].join("\n"));
  if (rows.length !== 1 || rows[0].key !== "voting_starts_at") { console.error(`STOPPED: the window did not save in ${target.db}.`); process.exit(1); }
  console.log(`${target.db}: voting starts ${rows[0].value}, no end set (PARTY_VOTING_ENDS_AT decides: null = nothing closes). /api/state shows it within about 5 seconds.`);
  process.exit(0);
}
const starts = Date.parse(args.starts ?? "");
const ends = Date.parse(args.ends ?? "");
if (!Number.isFinite(starts) || !Number.isFinite(ends) || ends <= starts) { console.error("STOPPED: give --starts and --ends as ISO times (UTC), the end after the start."); process.exit(2); }
const rows = await d1(target, [
  `INSERT OR REPLACE INTO settings (key, value) VALUES ('voting_starts_at', ${sqlText(new Date(starts).toISOString())});`,
  `INSERT OR REPLACE INTO settings (key, value) VALUES ('voting_ends_at', ${sqlText(new Date(ends).toISOString())});`,
  "SELECT key, value FROM settings WHERE key IN ('voting_starts_at', 'voting_ends_at') ORDER BY key;",
].join("\n"));
if (rows.length !== 2) { console.error(`STOPPED: the window did not save in ${target.db}.`); process.exit(1); }
console.log(`${target.db}: voting ${rows.map((r) => `${r.key.replace("voting_", "").replace("_at", "")} ${r.value}`).join(", ")}. /api/state shows it within about 5 seconds.`);
