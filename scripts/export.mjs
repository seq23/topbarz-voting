#!/usr/bin/env node
// The final tally and the contact list, as two CSVs in exports/<env>-<time>/ (git-ignored: voter
// data never enters the repo).
//   node scripts/export.mjs --env production
// tally.csv:    rank, track, slug, likes, likes_verified, comments, tie_break_order, first_reached_at, last_reached_at
// contacts.csv: name, email, city, marketing_opt_in, first_interaction_at, flagged, flag_reason, verified
// Likes from flagged voters and hidden comments are not counted. One row per voter (email is unique).
// `likes` counts every voter who is not flagged (what the page shows, and what the rank uses);
// `likes_verified` is the part of it from voters who entered an email code. `verified` is "yes",
// or "no (<why>)": before_verification, pending (sent a code, never let in), mail_budget,
// mail_error, verification_off.
import fs from "node:fs";
import path from "node:path";
import { computeTally } from "../functions/_lib/tally.js";
import { ROOT, d1, parseArgs, stopOnError, targets } from "./lib/cf.mjs";
import { toCsv } from "./lib/csv.mjs";

export function tallyCsv(rows) {
  return toCsv(
    ["rank", "track", "slug", "likes", "likes_verified", "comments", "tie_break_order", "first_reached_at", "last_reached_at"],
    rows.map((r) => [r.rank, r.label, r.slug, r.likes, r.likes_verified, r.comments, r.tie_break_order, r.first_reached_at ?? "", r.last_reached_at ?? ""]),
  );
}
// "yes", or "no (<why>)". A row that says neither is a bug in the data, so it is named, not hidden.
export function verifiedCell(v) {
  return v.verified ? "yes" : `no (${v.unverified_reason || "unknown"})`;
}
export function contactsCsv(voters) {
  const yn = (v) => (v ? "yes" : "no");
  return toCsv(
    ["name", "email", "city", "marketing_opt_in", "first_interaction_at", "flagged", "flag_reason", "verified"],
    voters.map((v) => [v.name, v.email, v.city, yn(v.marketing_opt_in), v.created_at, yn(v.flagged), v.flag_reason ?? "", verifiedCell(v)]),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  stopOnError();
  const args = parseArgs(process.argv.slice(2), { env: "value" });
  if (!args.env) { console.error("STOPPED: say which data: --env local | preview | production"); process.exit(2); }
  const target = targets(args.env);
  const tracks = await d1(target, "SELECT id, slug, label FROM tracks WHERE active = 1");
  const events = await d1(target, "SELECT e.id, e.track_id, e.action, e.created_at, v.verified FROM like_events e JOIN voters v ON v.id = e.voter_id WHERE v.flagged = 0 ORDER BY e.id");
  const commentRows = await d1(target, "SELECT track_id, COUNT(*) AS n FROM comments WHERE hidden = 0 GROUP BY track_id");
  const voters = await d1(target, "SELECT name, email, city, marketing_opt_in, created_at, flagged, flag_reason, verified, unverified_reason FROM voters ORDER BY created_at, id");
  if (tracks.length === 0) { console.error(`STOPPED: ${target.db} has no active tracks; there is nothing to tally.`); process.exit(1); }

  const tally = computeTally(tracks, events, Object.fromEntries(commentRows.map((r) => [r.track_id, r.n])));
  const dir = path.join(ROOT, "exports", `${args.env}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "tally.csv"), tallyCsv(tally));
  fs.writeFileSync(path.join(dir, "contacts.csv"), contactsCsv(voters), { mode: 0o600 });
  const top = tally[0];
  const tied = tally.filter((r) => r.likes === top.likes).length;
  console.log(`${args.env}: ${tally.length} track(s), ${events.length} like event(s), ${voters.length} voter(s) (${voters.filter((v) => v.flagged).length} flagged, ${voters.filter((v) => v.verified).length} verified by email code).`);
  console.log(`Leader: ${top.label} with ${top.likes} like(s)${tied > 1 ? ` — ${tied} tracks tied; order is by the PROPOSED tie-break (first to reach the count)` : ""}.`);
  console.log(`Written: ${dir}/tally.csv and contacts.csv`);
}
