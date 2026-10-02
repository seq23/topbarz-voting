#!/usr/bin/env node
// The final tally and the contact list, as two CSVs in exports/<env>-<time>/ (git-ignored: voter
// data never enters the repo).
//   node scripts/export.mjs --env production
// tally.csv:    rank, track, slug, likes, comments, tie_break_order, first_reached_at, last_reached_at
// contacts.csv: name, email, city, marketing_opt_in, first_interaction_at, flagged, flag_reason
// Likes from flagged voters and hidden comments are not counted. One row per voter (email is unique).
import fs from "node:fs";
import path from "node:path";
import { computeTally } from "../functions/_lib/tally.js";
import { ROOT, d1, parseArgs, stopOnError, targets } from "./lib/cf.mjs";
import { toCsv } from "./lib/csv.mjs";

export function tallyCsv(rows) {
  return toCsv(
    ["rank", "track", "slug", "likes", "comments", "tie_break_order", "first_reached_at", "last_reached_at"],
    rows.map((r) => [r.rank, r.label, r.slug, r.likes, r.comments, r.tie_break_order, r.first_reached_at ?? "", r.last_reached_at ?? ""]),
  );
}
export function contactsCsv(voters) {
  const yn = (v) => (v ? "yes" : "no");
  return toCsv(
    ["name", "email", "city", "marketing_opt_in", "first_interaction_at", "flagged", "flag_reason"],
    voters.map((v) => [v.name, v.email, v.city, yn(v.marketing_opt_in), v.created_at, yn(v.flagged), v.flag_reason ?? ""]),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  stopOnError();
  const args = parseArgs(process.argv.slice(2), { env: "value" });
  if (!args.env) { console.error("STOPPED: say which data: --env local | preview | production"); process.exit(2); }
  const target = targets(args.env);
  const tracks = await d1(target, "SELECT id, slug, label FROM tracks WHERE active = 1");
  const events = await d1(target, "SELECT id, track_id, action, created_at FROM like_events WHERE voter_id NOT IN (SELECT id FROM voters WHERE flagged = 1) ORDER BY id");
  const commentRows = await d1(target, "SELECT track_id, COUNT(*) AS n FROM comments WHERE hidden = 0 GROUP BY track_id");
  const voters = await d1(target, "SELECT name, email, city, marketing_opt_in, created_at, flagged, flag_reason FROM voters ORDER BY created_at, id");
  if (tracks.length === 0) { console.error(`STOPPED: ${target.db} has no active tracks; there is nothing to tally.`); process.exit(1); }

  const tally = computeTally(tracks, events, Object.fromEntries(commentRows.map((r) => [r.track_id, r.n])));
  const dir = path.join(ROOT, "exports", `${args.env}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "tally.csv"), tallyCsv(tally));
  fs.writeFileSync(path.join(dir, "contacts.csv"), contactsCsv(voters), { mode: 0o600 });
  const top = tally[0];
  const tied = tally.filter((r) => r.likes === top.likes).length;
  console.log(`${args.env}: ${tally.length} track(s), ${events.length} like event(s), ${voters.length} voter(s) (${voters.filter((v) => v.flagged).length} flagged).`);
  console.log(`Leader: ${top.label} with ${top.likes} like(s)${tied > 1 ? ` — ${tied} tracks tied; order is by the PROPOSED tie-break (first to reach the count)` : ""}.`);
  console.log(`Written: ${dir}/tally.csv and contacts.csv`);
}
