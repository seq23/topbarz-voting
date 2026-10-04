#!/usr/bin/env node
// The booth's log, as one CSV in exports/ (git-ignored): every track an engineer uploaded, newest
// first, with its code and how often it was opened.
//   node scripts/booth-log.mjs --env production
// booth-log.csv: code, file_name, size, uploaded_at (ISO), opened, public (1 = made public by
// the rapper), art (1 = artwork added). Never a key and never a share id.
// Reads the booth_tracks table only: nothing of the vote (no voter, no like, no comment) is here.
import fs from "node:fs";
import path from "node:path";
import { ROOT, d1, parseArgs, stopOnError, targets } from "./lib/cf.mjs";
import { toCsv } from "./lib/csv.mjs";

export const BOOTH_LOG_SQL = "SELECT code, file_name, size, uploaded_at, opened, public, art_key IS NOT NULL AS art FROM booth_tracks ORDER BY uploaded_at DESC, id DESC";

export function boothLogCsv(rows) {
  return toCsv(
    ["code", "file_name", "size", "uploaded_at", "opened", "public", "art"],
    rows.map((r) => [r.code, r.file_name, r.size ?? "", new Date(r.uploaded_at).toISOString(), r.opened, r.public ? 1 : 0, r.art ? 1 : 0]),
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
  const opened = rows.filter((r) => r.opened > 0).length;
  const shared = rows.filter((r) => r.public).length;
  console.log(`${args.env}: ${rows.length} booth track(s), ${opened} opened at least once, ${shared} public, newest ${new Date(rows[0].uploaded_at).toISOString()}.`);
  console.log(`Written: ${file}`);
}
