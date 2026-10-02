#!/usr/bin/env node
// Resize a folder of photos for the web, upload them, and write the manifest /api/state serves.
// Safe to run again: a photo already uploaded is skipped; the manifest is rewritten to match the
// folder exactly. No photos = an empty manifest (the page hides the slider).
//   node scripts/load-photos.mjs --env preview        (default folder: Drive "Test photos")
//   node scripts/load-photos.mjs --env production     (default folder: Drive "Gallery photos")
//   flags: --folder <dir>  --dry-run
// Refuses any "Test …" folder or file into production.
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { PHOTO_MANIFEST_KEY } from "../functions/_lib/state.js";
import { DRIVE_DIR, ROOT, parseArgs, stopOnError, pool, r2Get, r2Put, sha256File, targets } from "./lib/cf.mjs";
import { assertLoadAllowed, naturalSort } from "./lib/names.mjs";

const IMAGES = new Set([".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"]);
// Long edge in px. The originals are 4000x6000 and ~8 MB; these come out near 250 KB and 60 KB.
const SIZES = { full: { edge: 1600, quality: 78 }, thumb: { edge: 640, quality: 72 } };

stopOnError();
const args = parseArgs(process.argv.slice(2), { env: "value", folder: "value", "dry-run": "flag" });
if (!args.env) { console.error("STOPPED: say where to load: --env local | preview | production"); process.exit(2); }
const target = targets(args.env);
const folder = fs.realpathSync(path.resolve(args.folder ?? path.join(DRIVE_DIR, args.env === "production" ? "Gallery photos" : "Test photos")));
const files = fs.readdirSync(folder).filter((f) => !f.startsWith(".") && IMAGES.has(path.extname(f).toLowerCase())).sort(naturalSort);
assertLoadAllowed(args.env, folder, files);

const previous = JSON.parse((await r2Get(target, PHOTO_MANIFEST_KEY))?.toString("utf8") ?? '{"photos":[]}');
const uploaded = new Set((previous.photos ?? []).flatMap((p) => [p.url, p.thumb_url]));
const work = path.join(ROOT, ".work", args.env, "photos");
fs.mkdirSync(work, { recursive: true });

// The local store takes one writer at a time; the real bucket takes several.
const photos = await pool(files, args.env === "local" ? 1 : 4, async (file, i) => {
  const src = path.join(folder, file);
  const sha = (await sha256File(src)).slice(0, 12);
  const entry = { alt: `Top Barz at CultureCon, photo ${i + 1}` };
  for (const [kind, { edge, quality }] of Object.entries(SIZES)) {
    const key = `photos/${sha}-${edge}.jpg`;
    const out = path.join(work, path.basename(key));
    // .rotate() applies the camera's orientation; metadata (GPS, serial numbers) is dropped.
    const info = await sharp(src).rotate().resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true }).jpeg({ quality, mozjpeg: true }).toFile(out);
    const url = `/media/${key}`;
    if (!args["dry-run"] && !uploaded.has(url)) await r2Put(target, key, out, "image/jpeg");
    Object.assign(entry, kind === "full" ? { url, width: info.width, height: info.height } : { thumb_url: url, thumb_width: info.width, thumb_height: info.height });
  }
  console.log(`${uploaded.has(entry.url) ? "unchanged" : args["dry-run"] ? "would load" : "loaded   "} ${file} → ${entry.width}x${entry.height}`);
  return { url: entry.url, width: entry.width, height: entry.height, thumb_url: entry.thumb_url, thumb_width: entry.thumb_width, thumb_height: entry.thumb_height, alt: entry.alt };
});

if (args["dry-run"]) { console.log("dry run: nothing written"); process.exit(0); }
const manifestFile = path.join(work, "photos.json");
fs.writeFileSync(manifestFile, JSON.stringify({ generated_at: new Date().toISOString(), photos }, null, 1));
await r2Put(target, PHOTO_MANIFEST_KEY, manifestFile, "application/json");
const check = JSON.parse((await r2Get(target, PHOTO_MANIFEST_KEY)).toString("utf8"));
if (check.photos.length !== photos.length) { console.error("STOPPED: the manifest read back does not match what was written."); process.exit(1); }
console.log(`\n${args.env}: manifest written with ${photos.length} photo(s) in ${target.bucket}.${photos.length ? "" : " The page hides the slider."}`);
