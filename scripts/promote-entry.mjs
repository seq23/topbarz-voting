#!/usr/bin/env node
// The only door from the contest entry onto the voting site (9 Oct 2026): an entry becomes a vote
// track here and nowhere else. Entries never reach the vote by themselves.
//   node scripts/promote-entry.mjs --env preview --id 12
//   node scripts/promote-entry.mjs --env production --all
//   flags: --id <entry number> | --all (every entry not yet promoted), --dry-run (print the
//          verdicts and do nothing)
// REFUSES, with a named reason (functions/_lib/entries.js promoteVerdict): the entry does not
// exist; the entrant, the file or any group member is Scooter Taylor (the loaders' rule);
// production with a "Test …" file or entrant; the entry did not agree to the official rules.
// With --id a refusal is a non-zero exit; with --all a refused entry is named and skipped, and the
// run fails only when nothing was promoted and something was refused (or there were no entries).
// Then, per entry: the R2 object is copied to tracks/<slug>-<hash>.<ext> (fetched to a work file,
// put with its content type), the duration read the way load-tracks.mjs reads it (ffprobe), and
// the vote track row upserted (source_name = "entry <n>: <file name>", label = the entrant's first
// name, "Jane R." for a second Jane, active = 1). The entry rows are never changed or deleted.
// Safe to run again: the same bytes are the same key, the slug and label never change.
// No email, phone or surname is printed or written anywhere but the label's initial.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { entryLabel, promoteVerdict } from "../functions/_lib/entries.js";
import { ROOT, d1, parseArgs, r2Get, r2Put, sqlText, stopOnError, targets } from "./lib/cf.mjs";
import { assignSlugs, slugify } from "./lib/names.mjs";

const run = promisify(execFile);
const TYPES = { wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", aif: "audio/aiff", aiff: "audio/aiff", flac: "audio/flac" };
const SITE = { production: "https://voting.topbarz.xyz", preview: "https://staging.topbarz-voting.pages.dev", local: "http://localhost:8788" };
export const entrySource = (entry) => `entry ${entry.id}: ${entry.file_name}`;

if (import.meta.url === `file://${process.argv[1]}`) {
  stopOnError();
  const args = parseArgs(process.argv.slice(2), { env: "value", id: "value", all: "flag", "dry-run": "flag" });
  if (!args.env) { console.error("STOPPED: say where the track goes: --env preview | production"); process.exit(2); }
  if (!args.all && !/^\d{1,9}$/.test(args.id ?? "")) { console.error("STOPPED: say which entry: --id <its number>, or --all"); process.exit(2); }
  if (args.all && args.id) { console.error("STOPPED: --id and --all are two ways to say which; use one"); process.exit(2); }
  const target = targets(args.env);

  const where = args.all ? "" : `WHERE e.id = ${Number(args.id)}`;
  const entries = await d1(target, `SELECT e.id, e.first_name, e.last_name, e.rules_agreed_at, u.file_name, u.content_type, u.media_key FROM entries e JOIN entry_uploads u ON u.id = e.upload_id ${where} ORDER BY e.id`);
  if (entries.length === 0) { console.error(args.all ? `STOPPED: ${target.db} has no entries; there is nothing to promote.` : `REFUSED: no entry has the number ${args.id}`); process.exit(1); }
  const memberRows = await d1(target, "SELECT entry_id, first_name, last_name FROM entry_members");

  let promoted = 0, refused = 0;
  const work = path.join(ROOT, ".work", args.env, "promote-entry");
  for (const entry of entries) {
    const members = memberRows.filter((m) => m.entry_id === entry.id);
    const verdict = promoteVerdict({ entry, members, env: args.env });
    console.log(`entry ${entry.id}: ${verdict.ok ? "ALLOWED" : "REFUSED"} (${verdict.reason}): ${verdict.message}`);
    if (!verdict.ok) { refused++; continue; }

    const fileName = entry.file_name;
    const ext = (/\.([A-Za-z0-9]{1,5})$/.exec(fileName)?.[1] ?? path.extname(entry.media_key).slice(1)).toLowerCase();
    const source = entrySource(entry);
    const existing = await d1(target, "SELECT slug, label, source_name, audio_key, sort, active FROM tracks");
    const prior = existing.find((t) => t.source_name === source);
    const label = entryLabel(entry);
    const [planned] = assignSlugs([{ sourceName: source, label, slugBase: slugify(label) || "track", last: entry.last_name }], existing);
    if (args["dry-run"]) {
      console.log(`  dry run: would ${prior ? "update" : "add"} ${planned.slug}  "${planned.label}"  ← entry ${entry.id} in ${target.db}; nothing written`);
      promoted++;
      continue;
    }

    const bytes = await r2Get(target, entry.media_key);
    if (!bytes) { console.error(`  STOPPED: ${target.bucket}/${entry.media_key} is not in the bucket; entry ${entry.id} points at nothing.`); refused++; continue; }
    const key = `tracks/${planned.slug}-${createHash("sha256").update(bytes).digest("hex").slice(0, 10)}.${ext}`;
    fs.mkdirSync(work, { recursive: true });
    const file = path.join(work, path.basename(key));
    fs.writeFileSync(file, bytes);
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
    const durationMs = Math.round(Number(stdout.trim()) * 1000) || null;
    const contentType = TYPES[ext] ?? entry.content_type ?? "application/octet-stream";
    if (prior?.audio_key === key) console.log(`  unchanged ${key} (the same bytes are already there)`);
    else await r2Put(target, key, file, contentType);

    const now = new Date().toISOString();
    const sort = prior ? prior.sort : existing.reduce((m, t) => Math.max(m, t.sort), 0) + 10;
    await d1(target, `INSERT INTO tracks (slug, label, source_name, audio_key, duration_ms, sort, active, created_at, updated_at)
      VALUES (${[planned.slug, planned.label, source, key, durationMs, sort, 1, now, now].map(sqlText).join(", ")})
      ON CONFLICT (source_name) DO UPDATE SET audio_key = excluded.audio_key, duration_ms = COALESCE(excluded.duration_ms, duration_ms), active = 1, updated_at = excluded.updated_at;`);
    console.log(`  ${prior ? "updated  " : "promoted "} ${planned.slug}  "${planned.label}"  ${durationMs ? (durationMs / 1000).toFixed(1) + " s" : ""}  → ${target.bucket}/${key}   ${SITE[args.env]}/#${planned.slug}`);
    promoted++;
  }
  const [{ active }] = await d1(target, "SELECT COUNT(*) AS active FROM tracks WHERE active = 1");
  console.log(`\n${args.env}: ${promoted} ${args["dry-run"] ? "would be promoted" : "promoted"}, ${refused} refused; ${active} active track(s) in ${target.db}.`);
  if (promoted === 0 && refused > 0) process.exit(1);
}
