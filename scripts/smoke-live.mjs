#!/usr/bin/env node
// After a deploy: is the API really answering at this address, with voting switched on?
//   node scripts/smoke-live.mjs https://staging.topbarz-voting.pages.dev
// Fails (exit 1) unless /api/state is JSON with tracks, an end time, and gate.available = true
// (the signing secret is set), and an unknown /api path is a JSON 404 (the Functions are live,
// not just the static page). Retries for about a minute while a new deployment settles.
const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!/^https?:\/\//.test(base)) { console.error("STOPPED: give the address to check, e.g. https://staging.topbarz-voting.pages.dev"); process.exit(2); }
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
    if (nf.status !== 404 || !(nf.headers.get("content-type") ?? "").includes("json")) problems.push("unknown /api paths are not answered by the Functions");
    if (problems.length === 0) {
      console.log(`ok   ${base}: ${body.tracks.length} track(s), ${body.photos?.length ?? 0} photo(s), closes ${body.voting_ends_at}, closed=${body.closed}, giphy ${body.giphy?.available ? "on" : `off (${body.giphy?.reason})`}`);
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
