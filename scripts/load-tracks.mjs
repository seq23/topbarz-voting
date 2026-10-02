#!/usr/bin/env node
// Load a folder of "First Last.mp3" into the vote. Safe to run again: a file already loaded is
// skipped, a track's slug and label never change, nothing is ever deleted.
//   node scripts/load-tracks.mjs --env preview                (default folder: Drive "Test tracks")
//   node scripts/load-tracks.mjs --env production             (default folder: Drive "Tracks (First Last)")
//   flags: --folder <dir>  --dry-run  --relabel (reset labels to the file's first name)
// Refuses: any "Test …" folder or file into production; any file named for Scooter Taylor, always.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { DRIVE_DIR, ROOT, d1, parseArgs, stopOnError, r2Put, sha256File, sqlText, targets } from "./lib/cf.mjs";
import { assertLoadAllowed, assignSlugs, naturalSort, parseTrackFile } from "./lib/names.mjs";

const run = promisify(execFile);
const AUDIO = new Set([".mp3", ".m4a", ".aac", ".wav", ".aif", ".aiff", ".flac", ".ogg"]);
// Phone-friendly: 128 kbps constant-bitrate stereo MP3 (about 1 MB a minute; seeks cleanly by Range).
const ENCODE = ["-vn", "-map_metadata", "-1", "-ac", "2", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k"];

stopOnError();
const args = parseArgs(process.argv.slice(2), { env: "value", folder: "value", "dry-run": "flag", relabel: "flag" });
if (!args.env) { console.error("STOPPED: say where to load: --env local | preview | production"); process.exit(2); }
const target = targets(args.env);
const folder = fs.realpathSync(path.resolve(args.folder ?? path.join(DRIVE_DIR, args.env === "production" ? "Tracks (First Last)" : "Test tracks")));
const files = fs.readdirSync(folder).filter((f) => !f.startsWith(".") && AUDIO.has(path.extname(f).toLowerCase())).sort(naturalSort);
assertLoadAllowed(args.env, folder, files);

const parsedAll = files.map((f) => ({ file: f, ...parseTrackFile(f) }));
for (const p of parsedAll.filter((p) => p.excluded)) console.log(`EXCLUDED  ${p.file}  (Scooter Taylor's track is never in the vote)`);
const parsed = parsedAll.filter((p) => !p.excluded);
if (parsed.length === 0) {
  console.error(`STOPPED: nothing to load. ${folder} has ${files.length} audio file(s)${files.length ? ", all excluded" : ""}.`);
  process.exit(2);
}

const existing = await d1(target, "SELECT slug, label, source_name, audio_key, sort, active FROM tracks");
const have = new Map(existing.map((t) => [t.source_name, t]));
const planned = assignSlugs(parsed, existing);
let sort = existing.reduce((m, t) => Math.max(m, t.sort), 0);
const work = path.join(ROOT, ".work", args.env, "tracks");
fs.mkdirSync(work, { recursive: true });
const now = new Date().toISOString();
const statements = [];

for (const p of planned) {
  const src = path.join(folder, p.file);
  const key = `tracks/${p.slug}-${(await sha256File(src)).slice(0, 10)}.mp3`;
  const prior = have.get(p.sourceName);
  if (prior?.audio_key === key && !args.relabel) { console.log(`unchanged ${p.slug}  "${prior.label}"${prior.active ? "" : "  (INACTIVE: switched off by hand, left off)"}`); continue; }
  const label = args.relabel ? parseTrackFile(p.file).label : p.label;
  if (args["dry-run"]) { console.log(`would load ${p.slug}  "${label}"  ← ${p.file}`); continue; }
  let durationMs = null;
  if (prior?.audio_key !== key) {
    const out = path.join(work, path.basename(key));
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", src, ...ENCODE, out]);
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]);
    durationMs = Math.round(Number(stdout.trim()) * 1000) || null;
    await r2Put(target, key, out, "audio/mpeg");
  }
  sort = prior ? sort : sort + 10;
  statements.push(
    `INSERT INTO tracks (slug, label, source_name, audio_key, duration_ms, sort, active, created_at, updated_at)
     VALUES (${[p.slug, label, p.sourceName, key, durationMs, prior ? prior.sort : sort, 1, now, now].map(sqlText).join(", ")})
     ON CONFLICT (source_name) DO UPDATE SET audio_key = excluded.audio_key, duration_ms = COALESCE(excluded.duration_ms, duration_ms), updated_at = excluded.updated_at${args.relabel ? ", label = excluded.label" : ""};`,
  );
  console.log(`${prior ? "updated  " : "loaded   "} ${p.slug}  "${label}"  ${durationMs ? (durationMs / 1000).toFixed(1) + " s" : ""}  → ${target.bucket}/${key}`);
}

// Belt and braces for the one hard rule: whatever put it there, a Scooter Taylor row is switched off.
statements.push("UPDATE tracks SET active = 0 WHERE active = 1 AND (replace(replace(lower(source_name), ' ', ''), '-', '') LIKE '%scootertaylor%' OR lower(trim(source_name)) = 'scooter');");
statements.push("SELECT COUNT(*) AS active FROM tracks WHERE active = 1;");
if (args["dry-run"]) { console.log("dry run: nothing written"); process.exit(0); }
const [{ active }] = await d1(target, statements.join("\n"));
const gone = existing.filter((t) => t.active && !parsedAll.some((p) => p.sourceName === t.source_name));
for (const t of gone) console.log(`NOTE      "${t.source_name}" is in the vote but not in this folder (left as is; switch off: RUNBOOK.md)`);
console.log(`\n${args.env}: ${active} active track(s) in ${target.db}.`);
if (!active) { console.error("STOPPED: the database has no active track after loading."); process.exit(1); }
