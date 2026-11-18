#!/usr/bin/env node
// The partner's first session on a preview, played end to end over HTTP (the holiday party,
// 17 Nov 2026, with Scooter's preview notes). Exits non-zero on the first failure and prints one
// line starting FIRST_RUN OK when every step passed.
//   node scripts/first-run.mjs --url https://<branch>.topbarz-voting.pages.dev   (or FIRST_RUN_URL)
// Steps: every changed page loads with no placeholder text or error (and the partner logos load);
// the party is on; a group of two signs up on one phone (no codes) and a reload still shows both;
// one of them cannot sign up again while the group is in line ("already in line", said, not a
// silent block); a walk-up upload's code lets someone hear and download but never puts them on
// the song; the team's line refuses anyone not signed in. With FIRST_RUN_TEAM_TOKEN (a team token
// from signing in on that preview) it also plays the team's side: green, then red to the upload
// station while the next group goes in; the engineer's list offers the group just out, not the one
// in the booth; the upload lands the song on that group and moves it to done; Enter alone is not
// enough for a group song; "Confirmed with your group" puts it in the vote within 12 s with no
// script run; a reload still reads entered for both; unticking takes it out (the run leaves
// nothing in the preview's vote); and the group can get back in line once it is done.
// Test data only: "Test …" names, @example.com addresses; production refuses it (and the party
// is off there).
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const base = String(arg("url") ?? process.env.FIRST_RUN_URL ?? "").replace(/\/$/, "");
if (!/^https?:\/\//.test(base)) { console.error("FIRST_RUN FAILED: give the preview address: --url https://… (or FIRST_RUN_URL)"); process.exit(2); }
if (/voting\.topbarz\.xyz|^https:\/\/topbarz-voting\.pages\.dev/.test(base)) { console.error("FIRST_RUN FAILED: this plays test sign-ups; run it on a preview, never production"); process.exit(2); }

let step = 0;
const ok = (what) => console.log(`  ${String(++step).padStart(2)} ok  ${what}`);
const fail = (what) => { console.error(`FIRST_RUN FAILED at step ${step + 1}: ${what}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function req(path, { method = "GET", body, headers = {}, raw } = {}) {
  const res = await fetch(`${base}${path}`, { method, headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

// 1. The pages: each loads, and none ships a placeholder or an error page.
for (const page of ["/join", "/team", "/track", "/", "/booth", "/holiday-rules", "/join-qr", "/listen/0000000000000000"]) {
  const r = await req(page, { headers: { accept: "text/html" } });
  if (r.status !== 200) fail(`${page} answered ${r.status}`);
  if (/lorem ipsum|\bTODO\b|coming soon|<title>[^<]*(error|not found)/i.test(r.text)) fail(`${page} carries placeholder or error text`);
}
for (const logo of ["flow-music", "dick-and-janes", "blitz-and-bubbles"]) {
  const r = await fetch(`${base}/img/partners/${logo}.png`);
  if (r.status !== 200 || !/image\/png/.test(r.headers.get("content-type") ?? "")) fail(`the ${logo} logo answered ${r.status}`);
}
ok("every changed page loads (join, team, track, the vote, booth, holiday rules, the QR sign, listen) with no placeholder text, and the three partner logos load");
const party = await req("/api/party");
if (party.json?.on !== true) fail(`the party is not switched on here (/api/party: ${party.text.slice(0, 80)})`);
ok("the holiday party is on");

// 2. A group of two on one phone, and a reload.
const tag = `${Date.now().toString(36)}`;
const person = (n, phone, city) => ({ name: `Test ${n} ${tag}`, phone, email: `first-run-${n.toLowerCase()}-${tag}@example.com`, city, instagram: "" });
const guestA = person("Ava", "555 010 2030", "Brooklyn");
const guestB = person("Bo", "555 010 4050", "Queens");
const a = await req("/api/party/join", { method: "POST", body: { guests: [guestA, guestB], website: "" } });
if (a.status !== 201 || a.json?.session?.size !== 2) fail(`the group sign-up: ${a.status} ${a.text.slice(0, 160)}`);
if (/555|@example\.com|Brooklyn|Queens/.test(JSON.stringify({ ...a.json, guest_key: "" }))) fail("the sign-up answer carries a phone, an email or a city");
ok(`a group of two signed up on one phone (${a.json.session.names.join(", ")}), and the answer carries no phone or email`);
const reload = await req("/api/party/me", { method: "POST", body: { guest_key: a.json.guest_key } });
if (reload.json?.session?.size !== 2 || reload.json.session.status !== "waiting") fail(`after a reload the group reads ${reload.text.slice(0, 120)}`);
ok(`a reload still shows the group of 2, waiting, place ${reload.json.session.place}`);
const twice = await req("/api/party/join", { method: "POST", body: { ...guestB, website: "" } });
if (twice.status !== 409 || twice.json?.error !== "already_in_line") fail(`signing up again while in line answered ${twice.status} ${twice.text.slice(0, 120)}`);
ok(`one place at a time, said out loud: "${twice.json.message}"`);

// 3. A walk-up upload: the code hears and downloads, and never puts anyone on the song.
const bytes = new Uint8Array(2048).map((_, i) => (i < 3 ? [0x49, 0x44, 0x33][i] : i % 251));
const uploadSong = (name, headers = {}) => req("/api/booth/tracks", { method: "POST", headers: { "x-file-name": encodeURIComponent(name), "content-type": "audio/mpeg", "content-length": String(bytes.byteLength), ...headers }, raw: bytes });
const walk = await uploadSong(`Test - Walk up ${tag}.mp3`);
if (walk.status !== 200 || !/^\d{4}$/.test(walk.json?.code ?? "")) fail(`the booth upload: ${walk.status} ${walk.text.slice(0, 120)}`);
const heard = await req(`/api/booth/tracks/${walk.json.code}/enter`, { method: "POST", body: { email: guestA.email } });
if (heard.status !== 200 || !heard.json?.download_url || heard.json?.contest?.you?.performer !== false) fail(`entering a song's code: ${heard.status} ${heard.text.slice(0, 160)}`);
const sneak = await req(`/api/booth/tracks/${walk.json.code}/contest`, { method: "POST", body: { email: guestA.email, enter: true, agree: true } });
if (sneak.json?.error !== "not_attached") fail(`someone who only typed the code could enter the song: ${sneak.status} ${sneak.text.slice(0, 120)}`);
ok(`the code ${walk.json.code} lets someone hear and download, and never makes them a performer (entering it is refused)`);

// 4. The team's line: closed to anyone not signed in; with a team token, the whole song flow.
const line = await req("/api/party/team/line");
if (line.status !== 401 || line.json?.error !== "team_sign_in") fail(`the team's line without signing in answered ${line.status}`);
ok("the team's line refuses anyone not signed in (401 team_sign_in)");
const token = process.env.FIRST_RUN_TEAM_TOKEN;
if (token) {
  const auth = { authorization: `Bearer ${token}` };
  const l = await req("/api/party/team/line", { headers: auth });
  const s = (l.json?.sessions ?? []).find((x) => x.guests?.some((g) => g.email === guestA.email));
  if (!s || s.guests.length !== 2) fail("the team's line does not show the new group of 2");
  const lane = (status, from) => req(`/api/party/team/sessions/${s.id}/status`, { method: "POST", headers: auth, body: { status, from } });
  if ((await lane("booth", "waiting")).json?.session?.status !== "booth") fail("green did not take");
  const second = await req("/api/party/team/line", { headers: auth });
  if (second.json.sessions.find((x) => x.id === s.id)?.status !== "booth") fail("green did not hold on a second read");
  if ((await lane("upload", "booth")).json?.session?.status !== "upload") fail("red did not move the group to the upload station");
  ok("signed in as the team: the group shows as one card of 2, goes green with one tap, holds on a second read, and red moves it to the upload station");
  const offered = await req("/api/booth/sessions");
  if (!offered.json?.sessions?.some((g) => g.id === s.id)) fail("the engineer's list does not offer the group just out of the booth");
  const up = await uploadSong(`Test - First run ${tag}.mp3`, { "x-party-session": String(s.id) });
  if (up.status !== 200 || up.json?.tagged !== true) fail(`the upload for the group: ${up.status} ${up.text.slice(0, 120)}`);
  const code = up.json.code;
  const done = await req("/api/party/team/line", { headers: auth });
  if (done.json.sessions.find((x) => x.id === s.id)?.status !== "done") fail("the upload did not move the group to done");
  ok(`the engineer picked the group from the upload station; the song (${code}) is theirs and the group is done`);
  const tick = await req(`/api/booth/tracks/${code}/contest`, { method: "POST", body: { email: guestA.email, enter: true, agree: true } });
  if (tick.json?.error === "voting_closed") fail("the preview's voting window is closed: run npm run party-window -- --env preview --starts <ISO> --ends <ISO>");
  if (tick.status !== 200 || tick.json.contest.entered !== false || tick.json.contest.step !== "needs_group") fail(`Enter alone on a group song: ${tick.status} ${tick.text.slice(0, 160)}`);
  ok("Enter alone does not put a group song in: it waits for the group's confirmation");
  const label = `Test & Test`;
  const inVote = async (want) => {
    for (let i = 0; i < 12; i++) {
      const st = await req(`/api/state?first-run=${Date.now()}`);
      if ((st.json?.tracks ?? []).some((t) => t.label === label) === want) return true;
      await sleep(1000);
    }
    return false;
  };
  if (!(await inVote(false))) fail("the song is in the vote before the group confirmed");
  const confirm = await req(`/api/booth/tracks/${code}/contest`, { method: "POST", body: { email: guestB.email, enter: true, agree: true, group_confirmed: true } });
  if (confirm.json?.contest?.entered !== true) fail(`confirmed with the group but not entered: ${confirm.text.slice(0, 160)}`);
  if (!(await inVote(true))) fail("confirmed, but the song did not show in /api/state within 12 s");
  ok("Confirmed with your group: the song is in the vote (/api/state) with no script run");
  const again = await req(`/api/booth/tracks/${code}/contest-status`, { method: "POST", body: { email: guestA.email } });
  if (again.json?.contest?.entered !== true || again.json.contest.confirmed_by !== "Test") fail("after a reload the song no longer reads entered, confirmed");
  ok("a reload on the other phone still reads entered and who confirmed it");
  const untick = await req(`/api/booth/tracks/${code}/contest`, { method: "POST", body: { email: guestA.email, enter: false } });
  if (untick.json?.contest?.entered !== false || !(await inVote(false))) fail("unticking did not take the song out of the vote");
  ok("unticked: the song left the vote for everyone (this run leaves nothing in the preview's vote)");
  const back = await req("/api/party/join", { method: "POST", body: { ...guestB, website: "" } });
  if (back.status !== 201) fail(`once the group is done, signing up again answered ${back.status} ${back.text.slice(0, 120)}`);
  ok("once the group's song is uploaded, the same person gets back in line");
}
// Last: leave the preview as this run found it (Scooter, 18 Nov 2026: test groups and uploads were
// in his demo). Only this run's own rows, by its tag (scripts/clean-test-data.mjs); D1 through
// wrangler on this Mac. If that cannot run, the OK line says so and names the command.
let cleaned = "";
try {
  const { cleanTestData } = await import("./clean-test-data.mjs");
  const { targets } = await import("./lib/cf.mjs");
  const { picked } = await cleanTestData(targets(/\/\/(localhost|127\.0\.0\.1)/.test(base) ? "local" : "preview"), { tag });
  cleaned = `; cleared its own test rows (${picked.guests.length} sign-ups, ${picked.tracks.length} uploads)`;
} catch (err) {
  cleaned = `; its test rows are still there (${String(err.message).split("\n")[0].slice(0, 120)}): npm run clean-test-data -- --env preview --keep <demo code>`;
}
console.log(`FIRST_RUN OK ${base}: ${step} steps${cleaned}${token ? "" : " (the team's emailed-code sign-in is a person's step: set FIRST_RUN_TEAM_TOKEN to cover the team's line, the upload station and the contest entry too)"}`);
