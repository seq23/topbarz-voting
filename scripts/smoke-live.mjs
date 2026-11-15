#!/usr/bin/env node
// After a deploy: is the API really answering at this address, with voting switched on?
//   node scripts/smoke-live.mjs https://staging.topbarz-voting.pages.dev
// Fails (exit 1) unless /api/state is JSON with tracks, an end time, and gate.available = true
// (the signing secret is set), and an unknown /api path is a JSON 404 (the Functions are live,
// not just the static page), and email codes are in the state wrangler.toml asks for: with the
// switch "on" a missing mail key (verification.available = false) fails the deploy here, rather
// than voting running unverified with nobody told. And the select page: /select is served and
// /api/beats answers with a list (an empty one is fine: the page shows its empty state), and an
// address that is not staging shows no stand-in beat. Retries for about a minute while a new
// deployment settles.
import fs from "node:fs";
import path from "node:path";

const toml = fs.readFileSync(path.resolve(import.meta.dirname, "..", "wrangler.toml"), "utf8");
const switches = [...toml.matchAll(/^EMAIL_VERIFICATION = "([^"]*)"/gm)].map((m) => m[1]);
if (switches.length !== 2 || switches[0] !== switches[1] || !["on", "off"].includes(switches[0])) {
  console.error(`STOPPED: wrangler.toml must set EMAIL_VERIFICATION to "on" or "off", the same in both environments (found: ${switches.join(", ") || "nothing"}).`);
  process.exit(2);
}
const codesWanted = switches[0] === "on";
const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!/^https?:\/\//.test(base)) { console.error("STOPPED: give the address to check, e.g. https://staging.topbarz-voting.pages.dev"); process.exit(2); }
// Stand-in beats (test files) are for staging and a local run only.
const staging = /^https?:\/\/(staging\.|localhost\b|127\.0\.0\.1\b)/.test(base);
let last = "no attempt";
for (let attempt = 1; attempt <= 12; attempt++) {
  try {
    const res = await fetch(`${base}/api/state?smoke=${Date.now()}`, { headers: { accept: "application/json" } });
    const body = await res.json();
    const nf = await fetch(`${base}/api/__smoke__`);
    const problems = [];
    if (res.status !== 200) problems.push(`/api/state answered ${res.status}`);
    if (!Array.isArray(body.tracks)) problems.push("no tracks array");
    if (!body.voting_ends_at || typeof body.closed !== "boolean") problems.push("no voting window");
    if (body.gate?.available !== true) problems.push(`the gate is off (${body.gate?.reason ?? "unknown"}): set VOTER_TOKEN_SECRET — RUNBOOK.md, Secrets`);
    const v = body.verification;
    if (codesWanted && v?.available !== true) problems.push(`email codes are switched on but not working (${v?.reason ?? "no verification state"}): set RESEND_API_KEY — RUNBOOK.md, Email verification`);
    if (!codesWanted && (v?.available !== false || v?.reason !== "switched_off")) problems.push(`email codes are switched off in wrangler.toml but the site says ${JSON.stringify(v ?? null)}`);
    if (nf.status !== 404 || !(nf.headers.get("content-type") ?? "").includes("json")) problems.push("unknown /api paths are not answered by the Functions");
    const select = await fetch(`${base}/select?smoke=${Date.now()}`);
    if (select.status !== 200 || !(await select.text()).includes('id="tbz-beats-list"')) problems.push(`/select is not serving the select page (${select.status})`);
    const entry = await fetch(`${base}/entry?smoke=${Date.now()}`);
    if (entry.status !== 200 || !(await entry.text()).includes('id="tbz-entry-form"')) problems.push(`/entry is not serving the entry page (${entry.status})`);
    const entriesGet = await fetch(`${base}/api/entries?smoke=${Date.now()}`);
    if (entriesGet.status !== 405) problems.push(`GET /api/entries should answer 405, it answered ${entriesGet.status}`);
    if (!body.voting_starts_at || typeof body.open !== "boolean") problems.push("no voting start in /api/state");
    const beatsRes = await fetch(`${base}/api/beats?smoke=${Date.now()}`, { headers: { accept: "application/json" } });
    const beats = (await beatsRes.json().catch(() => null))?.beats;
    if (beatsRes.status !== 200 || !Array.isArray(beats)) problems.push(`/api/beats answered ${beatsRes.status} with no list of beats`);
    else if (!staging && beats.some((b) => /^placeholder-beat-/.test(b.slug) || /placeholder/i.test(b.name))) problems.push("a stand-in beat is showing on an address that is not staging");
    if (problems.length === 0) {
      console.log(`ok   ${base}: ${body.tracks.length} track(s), ${beats.length} beat(s) on /select, ${body.photos?.length ?? 0} photo(s), closes ${body.voting_ends_at}, closed=${body.closed}, giphy ${body.giphy?.available ? "on" : `off (${body.giphy?.reason})`}, email codes ${v.available ? "on" : `off (${v.reason})`}`);
      process.exit(0);
    }
    last = problems.join("; ");
  } catch (err) {
    last = String(err.message ?? err);
  }
  await new Promise((r) => setTimeout(r, 5000));
}
console.error(`FAILED ${base}: ${last}`);
process.exit(1);
