#!/usr/bin/env node
// The only door from the booth onto the voting site (the client's rule, 4 Oct 2026): a booth
// track becomes a vote track here and nowhere else, and only when every person attached to it has
// opted in. Share is anyone's call; the vote is everyone's consent.
//   node scripts/promote-booth.mjs --env preview --code 2468
//   node scripts/promote-booth.mjs --env production --code 2468 --label "Jane"
//   flags: --dry-run (print the verdict and do nothing)
// REFUSES, with a named reason and a non-zero exit (functions/_lib/booth.js promoteVerdict):
//   the code does not exist; the file is Scooter Taylor's (the loaders' rule, by file name);
//   production with a "Test …" file; nobody attached; anyone attached has not opted in.
// Then: the booth's R2 object is copied to tracks/<slug>-<hash>.<ext> (fetched to a work file,
// put with its content type), the duration read the way load-tracks.mjs reads it (ffprobe), and
// the vote track row upserted (source_name = the booth file's name, label = --label or the name
// without its extension, active = 1). The booth row is never changed or deleted. Safe to run
// again: the same bytes are the same key, the slug never changes, a label given once is kept.
// Only vote_opt_in is read from booth_people: no email leaves the table here.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { promoteVerdict } from "../functions/_lib/booth.js";
import { ROOT, d1, parseArgs, r2Get, r2Put, sqlText, stopOnError, targets } from "./lib/cf.mjs";
import { assignSlugs, slugify } from "./lib/names.mjs";

const run = promisify(execFile);
const TYPES = { wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", aif: "audio/aiff", aiff: "audio/aiff", flac: "audio/flac" };
const SITE = { production: "https://voting.topbarz.xyz", preview: "https://staging.topbarz-voting.pages.dev", local: "http://localhost:8788" };

stopOnError();
const args = parseArgs(process.argv.slice(2), { env: "value", code: "value", label: "value", "dry-run": "flag" });
if (!args.env) { console.error("STOPPED: say where the track goes: --env preview | production"); process.exit(2); }
if (!/^\d{4}$/.test(args.code ?? "")) { console.error("STOPPED: say which booth track: --code <its 4 digits>"); process.exit(2); }
const target = targets(args.env);

// The verdict first, from the booth row and its people's opt-ins (never their emails).
const [track] = await d1(target, `SELECT id, code, file_name, content_type, media_key FROM booth_tracks WHERE code = ${sqlText(args.code)}`);
const people = track ? await d1(target, `SELECT vote_opt_in FROM booth_people WHERE track_id = ${Number(track.id)}`) : [];
const verdict = promoteVerdict({ track, people, env: args.env });
console.log(`${verdict.ok ? "ALLOWED" : "REFUSED"} (${verdict.reason}): ${verdict.message}`);
if (!verdict.ok) { console.error(`REFUSED: ${verdict.message}`); process.exit(1); }

// What the vote track will be: its slug (kept if this file was promoted before), label and key.
const fileName = track.file_name;
const ext = (/\.([A-Za-z0-9]{1,5})$/.exec(fileName)?.[1] ?? path.extname(track.media_key).slice(1)).toLowerCase();
const baseName = fileName.replace(/\.[^.]+$/, "").trim() || fileName;
const existing = await d1(target, "SELECT slug, label, source_name, audio_key, sort, active FROM tracks");
const prior = existing.find((t) => t.source_name === fileName);
const label = (args.label ?? prior?.label ?? baseName).trim() || baseName;
const [planned] = assignSlugs([{ sourceName: fileName, label, slugBase: slugify(label) || "track", last: "" }], existing);
const link = `${SITE[args.env]}/#${planned.slug}`;
if (args["dry-run"]) {
  console.log(`dry run: would ${prior ? "update" : "add"} ${planned.slug}  "${label}"  ← booth ${track.code} "${fileName}" in ${target.db}; nothing written`);
  process.exit(0);
}

// The audio: the booth's object, fetched whole to a work file, keyed by its content hash under
// tracks/, put with its content type, and read for its duration as load-tracks.mjs does.
const bytes = await r2Get(target, track.media_key);
if (!bytes) { console.error(`STOPPED: ${target.bucket}/${track.media_key} is not in the bucket; the booth row points at nothing.`); process.exit(1); }
const key = `tracks/${planned.slug}-${createHash("sha256").update(bytes).digest("hex").slice(0, 10)}.${ext}`;
const work = path.join(ROOT, ".work", args.env, "promote");
fs.mkdirSync(work, { recursive: true });
const file = path.join(work, path.basename(key));
fs.writeFileSync(file, bytes);
const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
const durationMs = Math.round(Number(stdout.trim()) * 1000) || null;
const contentType = TYPES[ext] ?? track.content_type ?? "application/octet-stream";
if (prior?.audio_key === key) console.log(`unchanged ${key} (the same bytes are already there)`);
else await r2Put(target, key, file, contentType);

// The vote track row: new, or the same source_name again (the slug stays; the label is what was
// decided above; the audio and duration follow the bytes; active again whatever it was).
const now = new Date().toISOString();
const sort = prior ? prior.sort : existing.reduce((m, t) => Math.max(m, t.sort), 0) + 10;
const [{ active }] = await d1(target, [
  `INSERT INTO tracks (slug, label, source_name, audio_key, duration_ms, sort, active, created_at, updated_at)
   VALUES (${[planned.slug, label, fileName, key, durationMs, sort, 1, now, now].map(sqlText).join(", ")})
   ON CONFLICT (source_name) DO UPDATE SET label = excluded.label, audio_key = excluded.audio_key, duration_ms = COALESCE(excluded.duration_ms, duration_ms), active = 1, updated_at = excluded.updated_at;`,
  "SELECT COUNT(*) AS active FROM tracks WHERE active = 1;",
].join("\n"));
console.log(`${prior ? "updated  " : "promoted "} ${planned.slug}  "${label}"  ${durationMs ? (durationMs / 1000).toFixed(1) + " s" : ""}  → ${target.bucket}/${key}`);
console.log(`\n${args.env}: ${active} active track(s) in ${target.db}. The deep link: ${link}`);
