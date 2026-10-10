#!/usr/bin/env node
// The final tally and the contact list, as two CSVs in exports/<env>-<time>/ (git-ignored: voter
// data never enters the repo).
//   node scripts/export.mjs --env production
// tally.csv:    rank, track, slug, likes, likes_verified, comments, tie_break_order, first_reached_at, last_reached_at
// contacts.csv: name, email, city, marketing_opt_in, first_interaction_at, flagged, flag_reason, verified
// entries.csv:  entry, first_name, last_name, city, email, phone, instagram, track_title, in_group, rules_agreed_at, track_file, entered_at
// entry-members.csv: entry, first_name, last_name, email (the other people in a group recording)
// (9 Oct 2026, the contest entry at /entry; the tally is skipped while there are no tracks, the entries are not)
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

export function entriesCsv(rows) {
  return toCsv(
    ["entry", "first_name", "last_name", "city", "email", "phone", "instagram", "track_title", "in_group", "rules_agreed_at", "track_file", "entered_at"],
    rows.map((r) => [r.id, r.first_name, r.last_name, r.city, r.email, r.phone, r.instagram, r.track_title, r.in_group ? "yes" : "no", new Date(r.rules_agreed_at).toISOString(), r.file_name, new Date(r.created_at).toISOString()]),
  );
}
export function entryMembersCsv(rows) {
  return toCsv(["entry", "first_name", "last_name", "email"], rows.map((r) => [r.entry_id, r.first_name, r.last_name, r.email]));
}
export const ENTRIES_SQL = "SELECT e.id, e.first_name, e.last_name, e.city, e.email, e.phone, e.instagram, e.track_title, e.in_group, e.rules_agreed_at, e.created_at, u.file_name FROM entries e JOIN entry_uploads u ON u.id = e.upload_id ORDER BY e.id";
export const ENTRY_MEMBERS_SQL = "SELECT entry_id, first_name, last_name, email FROM entry_members ORDER BY entry_id, id";

if (import.meta.url === `file://${process.argv[1]}`) {
  stopOnError();
  const args = parseArgs(process.argv.slice(2), { env: "value" });
  if (!args.env) { console.error("STOPPED: say which data: --env local | preview | production"); process.exit(2); }
  const target = targets(args.env);
  const tracks = await d1(target, "SELECT id, slug, label FROM tracks WHERE active = 1");
  const events = await d1(target, "SELECT e.id, e.track_id, e.action, e.created_at, v.verified FROM like_events e JOIN voters v ON v.id = e.voter_id WHERE v.flagged = 0 ORDER BY e.id");
  const commentRows = await d1(target, "SELECT track_id, COUNT(*) AS n FROM comments WHERE hidden = 0 GROUP BY track_id");
  const voters = await d1(target, "SELECT name, email, city, marketing_opt_in, created_at, flagged, flag_reason, verified, unverified_reason FROM voters ORDER BY created_at, id");
  const entries = await d1(target, ENTRIES_SQL);
  if (tracks.length === 0 && entries.length === 0) { console.error(`STOPPED: ${target.db} has no active tracks and no entries; there is nothing to export.`); process.exit(1); }

  const dir = path.join(ROOT, "exports", `${args.env}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(dir, { recursive: true });
  if (entries.length > 0) {
    fs.writeFileSync(path.join(dir, "entries.csv"), entriesCsv(entries), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "entry-members.csv"), entryMembersCsv(await d1(target, ENTRY_MEMBERS_SQL)), { mode: 0o600 });
    console.log(`${args.env}: ${entries.length} contest entr${entries.length === 1 ? "y" : "ies"}.`);
  }
  if (tracks.length === 0) {
    console.log(`No active tracks in ${target.db}: the tally is skipped; the entries are written.`);
    console.log(`Written: ${dir}/entries.csv and entry-members.csv`);
    process.exit(0);
  }
  const tally = computeTally(tracks, events, Object.fromEntries(commentRows.map((r) => [r.track_id, r.n])));
  fs.writeFileSync(path.join(dir, "tally.csv"), tallyCsv(tally));
  fs.writeFileSync(path.join(dir, "contacts.csv"), contactsCsv(voters), { mode: 0o600 });
  const top = tally[0];
  const tied = tally.filter((r) => r.likes === top.likes).length;
  console.log(`${args.env}: ${tally.length} track(s), ${events.length} like event(s), ${voters.length} voter(s) (${voters.filter((v) => v.flagged).length} flagged, ${voters.filter((v) => v.verified).length} verified by email code).`);
  console.log(`Leader: ${top.label} with ${top.likes} like(s)${tied > 1 ? ` — ${tied} tracks tied; order is by the PROPOSED tie-break (first to reach the count)` : ""}.`);
  console.log(`Written: ${dir}/tally.csv and contacts.csv${entries.length > 0 ? ", entries.csv and entry-members.csv" : ""}`);
}
