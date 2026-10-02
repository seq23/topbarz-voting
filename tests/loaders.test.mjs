// The loaders' rules (no network): track naming, the Scooter Taylor exclusion, the test-folder
// refusal, separate preview/production data, the tie-break, the CSVs, and that voter data and
// secrets stay out of the repo.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { computeTally } from "../functions/_lib/tally.js";
import { targets } from "../scripts/lib/cf.mjs";
import { csvCell } from "../scripts/lib/csv.mjs";
import { contactsCsv, tallyCsv } from "../scripts/export.mjs";
import { assertLoadAllowed, assignSlugs, isScooterTaylor, isTestName, parseTrackFile } from "../scripts/lib/names.mjs";
import { ROOT } from "./helpers.mjs";

test("a file named First Last becomes a track labelled and slugged by the first name", () => {
  assert.deepEqual(parseTrackFile("Jane Doe.mp3"), { sourceName: "Jane Doe", label: "Jane", slugBase: "jane", last: "Doe", excluded: false });
  assert.equal(parseTrackFile("José  Álvarez Ruiz.m4a").slugBase, "jose");
  assert.equal(parseTrackFile("José  Álvarez Ruiz.m4a").label, "José");
  assert.deepEqual(parseTrackFile("Test - Brian.mp3"), { sourceName: "Test - Brian", label: "Brian", slugBase: "brian", last: "", excluded: false });
  const duo = parseTrackFile("Test - Carlos & Damien.mp3");
  assert.equal(duo.label, "Carlos & Damien");
  assert.equal(duo.slugBase, "carlos-damien");
  assert.equal(parseTrackFile("Test - Chelos x Madame Prez x Cam.mp3").label, "Chelos x Madame Prez x Cam");
});

test("Scooter Taylor's track is excluded however the file is named", () => {
  for (const name of ["Scooter Taylor.mp3", "scooter taylor.MP3", "Taylor, Scooter.mp3", "Scooter_Taylor (final).wav", "ScooterTaylor.mp3", "@scootertaylor.mp3", "Scooter.mp3", "Test - Scooter Taylor.mp3", "Scooter  T. Taylor.mp3"]) {
    assert.equal(isScooterTaylor(name.replace(/\.[^.]+$/, "")), true, name);
    assert.equal(parseTrackFile(name).excluded, true, name);
  }
  for (const name of ["Jane Doe.mp3", "Taylor Swift.mp3", "Sequoia Taylor.mp3", "Scott Taylor.mp3", "Scooter Braun.mp3"]) {
    assert.equal(parseTrackFile(name).excluded, false, name);
  }
});

test("the loader itself stops on a folder holding only his file, and loads nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbz-real-"));
  fs.writeFileSync(path.join(dir, "Scooter Taylor.mp3"), "not audio");
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/load-tracks.mjs"), "--env", "local", "--folder", dir, "--dry-run"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stdout, /EXCLUDED\s+Scooter Taylor\.mp3/);
  assert.match(r.stderr, /nothing to load/);
});

test("test folders and test files are refused for production, and allowed for preview and local", () => {
  const testFolder = path.join(os.homedir(), "topbarz-source", "drive", "Test tracks");
  assert.throws(() => assertLoadAllowed("production", testFolder, ["Brian.mp3"]), /REFUSED.*test folder/);
  assert.throws(() => assertLoadAllowed("production", "/x/Test photos", ["a.jpg"]), /REFUSED/);
  assert.throws(() => assertLoadAllowed("production", "/x/test/inner", ["a.jpg"]), /REFUSED/);
  assert.throws(() => assertLoadAllowed("production", "/x/Tracks (First Last)", ["Jane Doe.mp3", "Test - Brian.mp3"]), /REFUSED.*test file/);
  assert.throws(() => assertLoadAllowed("production", "/x/Gallery photos", ["Test photo 1.jpg"]), /REFUSED/);
  assert.doesNotThrow(() => assertLoadAllowed("production", "/x/Tracks (First Last)", ["Jane Doe.mp3", "Tess Testa.mp3"]));
  assert.doesNotThrow(() => assertLoadAllowed("preview", testFolder, ["Test - Brian.mp3"]));
  assert.doesNotThrow(() => assertLoadAllowed("local", testFolder, ["Test - Brian.mp3"]));
  assert.equal(isTestName("Testimony Jones"), false);
  assert.equal(isTestName("Contest winners"), false);
});

test("both loaders refuse a Test folder for production before touching anything (even via a symlink)", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tbz-load-"));
  const testDir = path.join(base, "Test tracks");
  fs.mkdirSync(testDir);
  fs.writeFileSync(path.join(testDir, "Brian.mp3"), "x");
  fs.writeFileSync(path.join(testDir, "Photo.jpg"), "x");
  const disguised = path.join(base, "Real tracks");
  fs.symlinkSync(testDir, disguised);
  for (const script of ["load-tracks.mjs", "load-photos.mjs"]) {
    for (const folder of [testDir, disguised]) {
      const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", script), "--env", "production", "--folder", folder], { encoding: "utf8" });
      assert.notEqual(r.status, 0, `${script} ${folder}`);
      assert.match(r.stderr, /REFUSED: "Test tracks" is a test folder/, `${script} ${folder}`);
    }
  }
});

test("a loader with no --env stops and says so", () => {
  for (const script of ["load-tracks.mjs", "load-photos.mjs", "export.mjs"]) {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", script)], { encoding: "utf8" });
    assert.equal(r.status, 2, script);
    assert.match(r.stderr, /--env local \| preview \| production/);
  }
});

test("slugs never change once given; a shared first name gets the last initial", () => {
  const existing = [{ slug: "jane", label: "@janesings", source_name: "Jane Doe" }];
  const planned = assignSlugs(["Jane Doe.mp3", "Jane Roe.mp3", "Omar Little.mp3", "Sam Ali.mp3", "Sam Bo.mp3"].map(parseTrackFile), existing);
  assert.deepEqual(planned.map((p) => [p.slug, p.label, p.isNew]), [
    ["jane", "@janesings", false], // already loaded: slug AND hand-edited label kept
    ["jane-r", "Jane R.", true],
    ["omar", "Omar", true],
    ["sam-a", "Sam A.", true],
    ["sam-b", "Sam B.", true],
  ]);
  const clash = assignSlugs(["Sam Adams.mp3", "Sam Allen.mp3"].map(parseTrackFile), []);
  assert.deepEqual(clash.map((p) => p.slug), ["sam-a", "sam-allen"]);
  assert.equal(new Set(planned.map((p) => p.slug)).size, planned.length);
});

test("production and preview never share a database or a bucket", () => {
  const prod = targets("production"), preview = targets("preview"), local = targets("local");
  assert.notEqual(prod.db, preview.db);
  assert.notEqual(prod.bucket, preview.bucket);
  assert.match(preview.db, /preview/);
  assert.match(preview.bucket, /preview/);
  assert.deepEqual(local.where, ["--local"]);
  assert.deepEqual(prod.where, ["--remote"]);
  const toml = fs.readFileSync(path.join(ROOT, "wrangler.toml"), "utf8");
  const ids = [...toml.matchAll(/database_id = "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  assert.throws(() => targets("staging"), /--env must be one of/);
});

test("tie-break: of tracks tied on likes, the one that reached the count first is ahead", () => {
  const tracks = [{ id: 1, slug: "a", label: "A" }, { id: 2, slug: "b", label: "B" }, { id: 3, slug: "c", label: "C" }, { id: 4, slug: "d", label: "D" }];
  const ev = (id, track_id, action) => ({ id, track_id, action, created_at: `2026-10-05T00:00:${String(id).padStart(2, "0")}.000Z` });
  const events = [
    ev(1, 2, "like"), ev(2, 1, "like"),   // b reaches 1, then a reaches 1
    ev(3, 1, "like"),                     // a reaches 2 first (id 3)
    ev(4, 2, "like"),                     // b reaches 2 (id 4)
    ev(5, 1, "unlike"), ev(6, 1, "like"), // a drops to 1 and climbs back to 2 (id 6)
    ev(7, 3, "like"), ev(8, 3, "like"), ev(9, 3, "like"), // c: 3 likes, the outright winner
  ];
  const tally = computeTally(tracks, events, { 1: 4 });
  assert.deepEqual(tally.map((r) => [r.rank, r.slug, r.likes, r.tie_break_order]), [[1, "c", 3, ""], [2, "a", 2, 1], [3, "b", 2, 2], [4, "d", 0, ""]]);
  const a = tally.find((r) => r.slug === "a");
  assert.equal(a.first_reached_at, "2026-10-05T00:00:03.000Z");
  assert.equal(a.last_reached_at, "2026-10-05T00:00:06.000Z", "the later climb is reported too, in case the confirmed rule reads that way");
  assert.equal(a.comments, 4);
  assert.equal(tally.find((r) => r.slug === "d").first_reached_at, null);
  const csv = tallyCsv(tally).split("\n");
  assert.equal(csv[0], "rank,track,slug,likes,comments,tie_break_order,first_reached_at,last_reached_at");
  assert.equal(csv[2], "2,A,a,2,4,1,2026-10-05T00:00:03.000Z,2026-10-05T00:00:06.000Z");
});

test("contacts CSV: one row per voter, quoted properly, formulas defused", () => {
  const csv = contactsCsv([
    { name: 'Jane "JD" Doe', email: "jane@example.com", city: "Atlanta, GA", marketing_opt_in: 1, created_at: "2026-10-05T01:02:03.000Z", flagged: 0, flag_reason: null },
    { name: "=HYPERLINK(\"http://x\")", email: "x@example.com", city: "X", marketing_opt_in: 0, created_at: "2026-10-05T01:02:04.000Z", flagged: 1, flag_reason: "bot" },
  ]).split("\n");
  assert.equal(csv[0], "name,email,city,marketing_opt_in,first_interaction_at,flagged,flag_reason");
  assert.equal(csv[1], '"Jane ""JD"" Doe",jane@example.com,"Atlanta, GA",yes,2026-10-05T01:02:03.000Z,no,');
  assert.ok(csv[2].startsWith(`"'=HYPERLINK`));
  assert.ok(csv[2].endsWith(",no,2026-10-05T01:02:04.000Z,yes,bot"));
  assert.equal(csvCell("+1 555"), "'+1 555");
});

test("voter data, secrets and loader work files cannot be committed", () => {
  for (const p of ["exports/production-x/contacts.csv", "exports/tally.csv", ".dev.vars", ".work/preview/tracks/a.mp3"]) {
    const out = execFileSync("git", ["-C", ROOT, "check-ignore", p], { encoding: "utf8" }).trim();
    assert.equal(out, p);
  }
  const tracked = execFileSync("git", ["-C", ROOT, "ls-files"], { encoding: "utf8" }).split("\n");
  assert.deepEqual(tracked.filter((f) => /\.(csv|mp3|wav|m4a|jpe?g|png)$/i.test(f) || f.startsWith("exports/")), []);
});

test("the docs name every API route, and the brand rules hold in what ships", () => {
  const runbook = fs.readFileSync(path.join(ROOT, "RUNBOOK.md"), "utf8");
  const claude = fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");
  assert.match(claude, /RUNBOOK\.md/);
  const routes = [];
  const walk = (dir, prefix) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.isDirectory()) walk(path.join(dir, f.name), `${prefix}/${f.name}`);
      else if (!f.name.startsWith("[[")) routes.push(`${prefix}/${f.name.replace(/\.js$/, "")}`);
    }
  };
  walk(path.join(ROOT, "functions", "api"), "/api");
  assert.ok(routes.length >= 7, `found ${routes.length} routes`);
  for (const r of routes) assert.ok(runbook.includes(r), `RUNBOOK.md does not describe ${r}`);
  assert.ok(runbook.includes("/media/"));
  for (const step of ["sync-drive", "load-tracks", "load-photos", "GIPHY_BETA_KEY", "hidden = 1", "flagged = 1", "npm run export", "voting_ends_at"]) {
    assert.ok(runbook.includes(step), `RUNBOOK.md does not cover: ${step}`);
  }
  // Brand: "Top Barz" is two words; the slogan is JUMP IN THE BOOTH; never "spit your bars".
  const shipped = [];
  const collect = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) collect(p); else if (/\.(html|js|css|json|txt|svg|webmanifest)$/.test(f.name)) shipped.push(p); } };
  collect(path.join(ROOT, "public")); collect(path.join(ROOT, "functions"));
  assert.ok(shipped.length > 5);
  for (const p of shipped) {
    const text = fs.readFileSync(p, "utf8");
    assert.ok(!/spit\s+your\s+bars/i.test(text), `${p}: never "spit your bars"`);
    assert.ok(!/TopBarz|Topbarz|TOPBARZ|Top-Barz/.test(text), `${p}: "Top Barz" is two words`);
  }
  assert.match(fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8"), /JUMP IN THE BOOTH/);
});

test("the pipeline: one fast merge gate; production only after staging answers; never a bare wrangler deploy", () => {
  const validate = fs.readFileSync(path.join(ROOT, ".github/workflows/validate.yml"), "utf8");
  const deploy = fs.readFileSync(path.join(ROOT, ".github/workflows/deploy.yml"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.match(validate, /^name: Validate$/m);
  assert.ok(Number(/timeout-minutes: (\d+)/.exec(validate)[1]) <= 5, "the merge gate's ceiling is 5 minutes");
  assert.match(validate, /npm test/);
  assert.match(validate, /npm run test:smoke/);
  assert.ok(!/playwright|chromium/i.test(validate + deploy + JSON.stringify(pkg)), "no browser suite in this repo");
  assert.match(deploy, /^name: Deploy$/m, "land waits for the run named Deploy");
  assert.match(deploy, /workflow_run:\n\s+workflows: \[Validate\]/);
  assert.ok(!/^\s+pull_request:|^\s+push:/m.test(deploy), "deploy never fires on a PR or a raw push");
  const order = ["npm run deploy:staging", "npm run smoke:staging", "npm run deploy:production", "npm run smoke:production"].map((s) => deploy.indexOf(`run: ${s}`));
  assert.ok(order.every((i) => i > 0) && order.join() === [...order].sort((a, b) => a - b).join(), "staging, its live check, then production, then its live check");
  assert.match(pkg.scripts["deploy:staging"], /migrate:preview && wrangler pages deploy public --project-name topbarz-voting --branch staging/);
  assert.match(pkg.scripts["deploy:production"], /migrate:production && wrangler pages deploy public --project-name topbarz-voting --branch main/);
  assert.match(pkg.scripts["migrate:preview"], /topbarz-voting-preview --remote --env preview/);
  for (const text of [validate, deploy, ...Object.values(pkg.scripts)]) assert.ok(!/wrangler deploy\b/.test(text), "never a bare `wrangler deploy`");
});
