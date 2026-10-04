#!/usr/bin/env node
// The booth's log, as two CSVs in exports/ (git-ignored): every track an engineer uploaded, newest
// first, with its code and how often it was opened; and every person attached to each (4 Oct 2026).
//   node scripts/booth-log.mjs --env production
// booth-log.csv: code, file_name, size, uploaded_at (ISO), opened, public (1 = made public from
// /track), art (1 = artwork added), people (how many entered the code with their email),
// everyone_in (1 = every one of them opted in to the public vote). Never a key and never a share id.
// booth-people.csv: code, file_name, email, attached_at (ISO), vote_opt_in, opted_at (ISO or
// empty): the one place outside the table where an email is written; it stays in exports/.
// Reads booth_tracks and booth_people only: nothing of the vote (no voter, no like, no comment) is here.
import fs from "node:fs";
import path from "node:path";
import { allIn } from "../functions/_lib/booth.js";
import { ROOT, d1, parseArgs, stopOnError, targets } from "./lib/cf.mjs";
import { toCsv } from "./lib/csv.mjs";

export const BOOTH_LOG_SQL = "SELECT t.code, t.file_name, t.size, t.uploaded_at, t.opened, t.public, t.art_key IS NOT NULL AS art, COUNT(p.id) AS people, COALESCE(SUM(p.vote_opt_in), 0) AS opted FROM booth_tracks t LEFT JOIN booth_people p ON p.track_id = t.id GROUP BY t.id ORDER BY t.uploaded_at DESC, t.id DESC";
export const BOOTH_PEOPLE_SQL = "SELECT t.code, t.file_name, p.email, p.attached_at, p.vote_opt_in, p.opted_at FROM booth_people p JOIN booth_tracks t ON t.id = p.track_id ORDER BY t.uploaded_at DESC, t.id DESC, p.attached_at ASC, p.id ASC";

export function boothLogCsv(rows) {
  return toCsv(
    ["code", "file_name", "size", "uploaded_at", "opened", "public", "art", "people", "everyone_in"],
    rows.map((r) => [r.code, r.file_name, r.size ?? "", new Date(r.uploaded_at).toISOString(), r.opened, r.public ? 1 : 0, r.art ? 1 : 0, r.people ?? 0, allIn(r.people, r.opted) ? 1 : 0]),
  );
}
export function boothPeopleCsv(rows) {
  return toCsv(
    ["code", "file_name", "email", "attached_at", "vote_opt_in", "opted_at"],
    rows.map((r) => [r.code, r.file_name, r.email, new Date(r.attached_at).toISOString(), r.vote_opt_in ? 1 : 0, r.opted_at ? new Date(r.opted_at).toISOString() : ""]),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  stopOnError();
  const args = parseArgs(process.argv.slice(2), { env: "value" });
  if (!args.env) { console.error("STOPPED: say which data: --env local | preview | production"); process.exit(2); }
  const target = targets(args.env);
  const rows = await d1(target, BOOTH_LOG_SQL);
  if (rows.length === 0) { console.error(`STOPPED: ${target.db} has no booth tracks; there is nothing to log.`); process.exit(1); }
  const dir = path.join(ROOT, "exports");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "booth-log.csv");
  fs.writeFileSync(file, boothLogCsv(rows));
  const people = await d1(target, BOOTH_PEOPLE_SQL);
  const peopleFile = path.join(dir, "booth-people.csv");
  fs.writeFileSync(peopleFile, boothPeopleCsv(people));
  const opened = rows.filter((r) => r.opened > 0).length;
  const shared = rows.filter((r) => r.public).length;
  const ready = rows.filter((r) => allIn(r.people, r.opted)).length;
  console.log(`${args.env}: ${rows.length} booth track(s), ${opened} opened at least once, ${shared} public, ${people.length} people attached, ${ready} with everyone in for the vote, newest ${new Date(rows[0].uploaded_at).toISOString()}.`);
  console.log(`Written: ${file}`);
  console.log(`Written: ${peopleFile} (emails: keep it in exports/)`);
}
