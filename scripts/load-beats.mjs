#!/usr/bin/env node
// Load a folder of beats for the select page (/select). Beats are their own table (`beats`) and
// their own R2 folder (beats/): this never touches the vote. Safe to run again: a file already
// loaded is skipped, a beat's slug and name never change, nothing is ever deleted.
//   node scripts/load-beats.mjs --env preview                 (default folder: Drive "Beats")
//   node scripts/load-beats.mjs --env production
//   flags: --folder <dir>  --dry-run
// Stand-ins: a "Test …" folder or file loads as "Placeholder beat N" (never under its own name),
// into preview or local only. Refuses: any "Test …" folder or file into production; a folder that
// is missing or holds no audio (it stops and says so; it never exits 0 having done nothing).
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { DRIVE_DIR, ROOT, d1, parseArgs, stopOnError, r2Put, sha256File, sqlText, targets } from "./lib/cf.mjs";
import { assertLoadAllowed, isTestFolder, naturalSort, planBeats } from "./lib/names.mjs";

const run = promisify(execFile);
const AUDIO = new Set([".mp3", ".m4a", ".aac", ".wav", ".aif", ".aiff", ".flac", ".ogg"]);
// The same encoding the tracks get: 128 kbps constant-bitrate stereo MP3 (seeks cleanly by Range).
const ENCODE = ["-vn", "-map_metadata", "-1", "-ac", "2", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k"];

stopOnError();
const args = parseArgs(process.argv.slice(2), { env: "value", folder: "value", "dry-run": "flag" });
if (!args.env) { console.error("STOPPED: say where to load: --env local | preview | production"); process.exit(2); }
const target = targets(args.env);
const asked = path.resolve(args.folder ?? path.join(DRIVE_DIR, "Beats"));
if (!fs.existsSync(asked) || !fs.statSync(asked).isDirectory()) {
  console.error(`STOPPED: there is no beats folder at ${asked}. Nothing was loaded.${args.folder ? "" : " Add a \"Beats\" folder to the Drive package and run `npm run sync-drive`, or name a folder: --folder <dir>."}`);
  process.exit(2);
}
const folder = fs.realpathSync(asked);
const files = fs.readdirSync(folder).filter((f) => !f.startsWith(".") && AUDIO.has(path.extname(f).toLowerCase())).sort(naturalSort);
assertLoadAllowed(args.env, folder, files);
if (files.length === 0) {
  console.error(`STOPPED: nothing to load. ${folder} has no audio files.`);
  process.exit(2);
}

const existing = await d1(target, "SELECT slug, name, source_name, audio_key, sort, active, stand_in FROM beats");
const have = new Map(existing.map((b) => [b.source_name, b]));
const planned = planBeats(files, existing, { testFolder: isTestFolder(folder) });
// The last line of defence for the one hard rule (assertLoadAllowed is the first).
if (args.env === "production" && planned.some((p) => p.standIn)) throw new Error("REFUSED: a stand-in beat is a test file. Test files load into preview only, never production.");
const realHere = existing.some((b) => b.active && !b.stand_in) || planned.some((p) => !p.standIn);
const standInsHere = planned.filter((p) => p.standIn && p.isNew);
if (standInsHere.length && realHere) {
  console.error(`STOPPED: real beats are loaded (or in this folder), so no stand-in is added next to them: ${standInsHere.map((p) => p.file).join(", ")}`);
  process.exit(2);
}

let sort = existing.reduce((m, b) => Math.max(m, b.sort), 0);
const work = path.join(ROOT, ".work", args.env, "beats");
fs.mkdirSync(work, { recursive: true });
const now = new Date().toISOString();
const statements = [];

for (const p of planned) {
  const src = path.join(folder, p.file);
  const key = `beats/${p.slug}-${(await sha256File(src)).slice(0, 10)}.mp3`;
  const prior = have.get(p.sourceName);
  if (prior?.audio_key === key) { console.log(`unchanged ${p.slug}  "${p.name}"${prior.active ? "" : "  (INACTIVE: switched off, left off)"}`); continue; }
  if (args["dry-run"]) { console.log(`would load ${p.slug}  "${p.name}"  ← ${p.file}${p.standIn ? "  (stand-in)" : ""}`); continue; }
  const out = path.join(work, path.basename(key));
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", src, ...ENCODE, out]);
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]);
  const durationMs = Math.round(Number(stdout.trim()) * 1000) || null;
  await r2Put(target, key, out, "audio/mpeg");
  sort = prior ? sort : sort + 10;
  statements.push(
    `INSERT INTO beats (slug, name, source_name, audio_key, duration_ms, sort, active, stand_in, created_at, updated_at)
     VALUES (${[p.slug, p.name, p.sourceName, key, durationMs, prior ? prior.sort : sort, 1, p.standIn ? 1 : 0, now, now].map(sqlText).join(", ")})
     ON CONFLICT (source_name) DO UPDATE SET audio_key = excluded.audio_key, duration_ms = COALESCE(excluded.duration_ms, duration_ms), updated_at = excluded.updated_at;`,
  );
  console.log(`${prior ? "updated  " : "loaded   "} ${p.slug}  "${p.name}"  ${durationMs ? (durationMs / 1000).toFixed(1) + " s" : ""}${p.standIn ? "  (stand-in)" : ""}  → ${target.bucket}/${key}`);
}

if (args["dry-run"]) { console.log("dry run: nothing written"); process.exit(0); }
// Real beats have arrived: the stand-ins step aside (switched off, never deleted).
if (planned.some((p) => !p.standIn)) {
  statements.push(`UPDATE beats SET active = 0, updated_at = ${sqlText(now)} WHERE stand_in = 1 AND active = 1;`);
  const off = existing.filter((b) => b.stand_in && b.active);
  if (off.length) console.log(`switched off ${off.length} stand-in beat(s): the real beats take their place`);
}
statements.push("SELECT COUNT(*) AS active, COALESCE(SUM(stand_in), 0) AS stand_ins FROM beats WHERE active = 1;");
const [{ active, stand_ins: standIns }] = await d1(target, statements.join("\n"));
console.log(`\n${args.env}: ${active} active beat(s) in ${target.db}${standIns ? ` (${standIns} stand-in)` : ""}.`);
if (!active) { console.error("STOPPED: the database has no active beat after loading."); process.exit(1); }
