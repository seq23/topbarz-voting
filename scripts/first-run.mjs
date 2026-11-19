#!/usr/bin/env node
// The partner's first session on a preview, played end to end over HTTP (the holiday party, after
// Scooter's consolidated revision list of 18 Nov 2026). Exits non-zero on the first failure and
// prints one line starting FIRST_RUN OK when every step passed.
//   node scripts/first-run.mjs --url https://<branch>.topbarz-voting.pages.dev   (or FIRST_RUN_URL)
// Steps: every changed page loads with no placeholder text or error (and the partner logos load);
// the party is on and no end date is set; two people sign up, each on their own (no codes, no group
// setup), and a reload still shows the first; the same email cannot sign up again while in line
// ("already in line", said, not a silent block); with nobody at the upload station, a walk-up
// upload's code lets someone hear and download but never puts them on the song; the team's line
// refuses anyone not signed in. With FIRST_RUN_TEAM_TOKEN (a team token from signing in on that
// preview) it also plays the team's side: both tapped into the booth are one recording, which is
// not at the upload station until the last of them is tapped out; the engineer's upload lands on
// exactly those two and marks them done; both see "have access"; the first to tick Enter manages
// the song and it is in the vote within 12 s with no script run; the other gets not_manager; a
// reload reads entered; unticking takes it out (the run leaves nothing in the preview's vote); and
// one tap puts the first person back in line.
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

if (party.json?.voting_ends_at) fail(`an end date is set (${party.json.voting_ends_at}); Scooter has not set one`);
const state0 = await req("/api/state");
if (state0.json?.voting_ends_at) fail(`/api/state carries an end date (${state0.json.voting_ends_at}): run npm run party-window -- --env preview --starts <ISO> --no-end`);
ok("no end date is set: nothing counts down and nothing closes");

// 2. Two people, each signing up on their own, and a reload.
const tag = `${Date.now().toString(36)}`;
const person = (n, phone, city) => ({ name: `Test ${n} ${tag}`, phone, email: `first-run-${n.toLowerCase()}-${tag}@example.com`, city, instagram: "" });
const guestA = person("Ava", "555 010 2030", "Brooklyn");
const guestB = person("Bo", "555 010 4050", "Queens");
const a = await req("/api/party/join", { method: "POST", body: { ...guestA, website: "" } });
if (a.status !== 201 || a.json?.session?.size !== 1) fail(`the sign-up: ${a.status} ${a.text.slice(0, 160)}`);
if (/555|@example\.com|Brooklyn|Queens/.test(JSON.stringify({ ...a.json, guest_key: "" }))) fail("the sign-up answer carries a phone, an email or a city");
const b = await req("/api/party/join", { method: "POST", body: { ...guestB, website: "" } });
if (b.status !== 201 || b.json?.session?.size !== 1) fail(`the second sign-up: ${b.status} ${b.text.slice(0, 160)}`);
const group = await req("/api/party/join", { method: "POST", body: { guests: [guestA, guestB], website: "" } });
if (group.status !== 400) fail(`a group sign-up was not refused: ${group.status} ${group.text.slice(0, 120)}`);
ok("two people signed up, each on their own (a group sign-up is refused), and the answers carry no phone or email");
const reload = await req("/api/party/me", { method: "POST", body: { guest_key: a.json.guest_key } });
if (reload.json?.session?.status !== "waiting") fail(`after a reload the sign-up reads ${reload.text.slice(0, 120)}`);
ok(`a reload still shows the place, waiting, number ${reload.json.session.place}`);
const twice = await req("/api/party/join", { method: "POST", body: { ...guestB, website: "" } });
if (twice.status !== 409 || twice.json?.error !== "already_in_line") fail(`signing up again while in line answered ${twice.status} ${twice.text.slice(0, 120)}`);
ok(`one place at a time, said out loud: "${twice.json.message}"`);

// 3. A walk-up upload (only with nobody at the upload station: it would take their recording).
const bytes = new Uint8Array(2048).map((_, i) => (i < 3 ? [0x49, 0x44, 0x33][i] : i % 251));
const uploadSong = (name, headers = {}) => req("/api/booth/tracks", { method: "POST", headers: { "x-file-name": encodeURIComponent(name), "content-type": "audio/mpeg", "content-length": String(bytes.byteLength), ...headers }, raw: bytes });
const station0 = await req("/api/booth/sessions");
if (station0.json?.on !== true) fail(`the upload station does not answer: ${station0.status} ${station0.text.slice(0, 120)}`);
if (station0.json.next) fail(`a recording (${station0.json.next.names}) is already waiting at the upload station; upload it or move it on /team first`);
const stale = await uploadSong(`Test - Stale ${tag}.mp3`, { "x-party-take": "999999999" });
if (stale.status !== 409 || stale.json?.error !== "take_changed") fail(`an upload for a recording the station no longer shows answered ${stale.status}`);
const walk = await uploadSong(`Test - Walk up ${tag}.mp3`, { "x-party-take": "none" });
if (walk.status !== 200 || !/^\d{4}$/.test(walk.json?.code ?? "")) fail(`the booth upload: ${walk.status} ${walk.text.slice(0, 120)}`);
const heard = await req(`/api/booth/tracks/${walk.json.code}/enter`, { method: "POST", body: { email: guestA.email } });
if (heard.status !== 200 || !heard.json?.download_url || heard.json?.contest?.you?.performer !== false) fail(`entering a song's code: ${heard.status} ${heard.text.slice(0, 160)}`);
const sneak = await req(`/api/booth/tracks/${walk.json.code}/contest`, { method: "POST", body: { email: guestA.email, enter: true, agree: true } });
if (sneak.status < 400) fail(`someone who only typed the code could enter the song: ${sneak.status} ${sneak.text.slice(0, 120)}`);
ok(`a stale upload page is refused (take_changed); the walk-up code ${walk.json.code} hears and downloads, and never makes anyone a performer`);

// 4. The team's line: closed to anyone not signed in; with a team token, the whole song flow.
const line = await req("/api/party/team/line");
if (line.status !== 401 || line.json?.error !== "team_sign_in") fail(`the team's line without signing in answered ${line.status}`);
ok("the team's line refuses anyone not signed in (401 team_sign_in)");
const token = process.env.FIRST_RUN_TEAM_TOKEN;
if (token) {
  const auth = { authorization: `Bearer ${token}` };
  const l = await req("/api/party/team/line", { headers: auth });
  const find = (sessions, g) => (sessions ?? []).find((x) => x.guests?.some((y) => y.email === g.email));
  const sA = find(l.json?.sessions, guestA);
  const sB = find(l.json?.sessions, guestB);
  if (!sA || !sB || sA.id === sB.id) fail("the team's line does not show the two sign-ups as a card each");
  const lane = async (s, status, from) => (await req(`/api/party/team/sessions/${s.id}/status`, { method: "POST", headers: auth, body: { status, from } })).json?.session?.status;
  if ((await lane(sA, "booth", "waiting")) !== "booth" || (await lane(sB, "booth", "waiting")) !== "booth") fail("green did not take");
  const l2 = await req("/api/party/team/line", { headers: auth });
  const [tA, tB] = [find(l2.json.sessions, guestA)?.take_id, find(l2.json.sessions, guestB)?.take_id];
  if (!tA || tA !== tB) fail(`the two tapped in are not one recording (takes ${tA}, ${tB})`);
  if ((await lane(sA, "upload", "booth")) !== "upload") fail("red did not take");
  if ((await req("/api/booth/sessions")).json?.next) fail("the recording reached the upload station while someone in it was still in the booth");
  if ((await lane(sB, "upload", "booth")) !== "upload") fail("red did not take for the last one out");
  const station = (await req("/api/booth/sessions")).json;
  if (station?.next?.id !== tA || station.next.size !== 2) fail(`the upload station does not show the recording of 2: ${JSON.stringify(station?.next)}`);
  ok("signed in as the team: both tapped green are one recording; it waits at the upload station only once the last of them is tapped out");
  const up = await uploadSong(`Test - First run ${tag}.mp3`, { "x-party-take": String(tA) });
  if (up.status !== 200 || up.json?.tagged !== true) fail(`the upload for the recording: ${up.status} ${up.text.slice(0, 120)}`);
  const code = up.json.code;
  const l3 = await req("/api/party/team/line", { headers: auth });
  if (find(l3.json.sessions, guestA)?.status !== "done" || find(l3.json.sessions, guestB)?.status !== "done") fail("the upload did not mark both done");
  const seen = await req(`/api/booth/tracks/${code}/enter`, { method: "POST", body: { email: guestB.email } });
  if (seen.json?.contest?.you?.performer !== true || seen.json.contest.access?.length !== 2) fail(`the song's access list: ${seen.text.slice(0, 160)}`);
  ok(`the song (${code}) landed on exactly those two, both are done, and the track page lists both as having access`);
  const tick = await req(`/api/booth/tracks/${code}/contest`, { method: "POST", body: { email: guestA.email, enter: true, agree: true } });
  if (tick.json?.error === "voting_closed" || tick.json?.error === "voting_not_open") fail("the preview's voting window is closed: run npm run party-window -- --env preview --starts <ISO> --no-end");
  if (tick.status !== 200 || tick.json.contest.entered !== true || tick.json.contest.you?.manager !== true) fail(`the first Enter: ${tick.status} ${tick.text.slice(0, 160)}`);
  const label = "Test & Test";
  const inVote = async (want) => {
    for (let i = 0; i < 12; i++) {
      const st = await req(`/api/state?first-run=${Date.now()}`);
      if ((st.json?.tracks ?? []).some((t) => t.label === label) === want) return true;
      await sleep(1000);
    }
    return false;
  };
  if (!(await inVote(true))) fail("entered, but the song did not show in /api/state within 12 s");
  ok("the first to tick Enter manages the song, and it is in the vote (/api/state) with no script run and no group confirmation");
  const other = await req(`/api/booth/tracks/${code}/contest`, { method: "POST", body: { email: guestB.email, enter: false } });
  if (other.status !== 403 || other.json?.error !== "not_manager") fail(`the other person could change the entry: ${other.status} ${other.text.slice(0, 120)}`);
  const again = await req(`/api/booth/tracks/${code}/contest-status`, { method: "POST", body: { email: guestB.email } });
  if (again.json?.contest?.entered !== true || again.json.contest.manager !== "Test") fail("after a reload the song no longer reads entered, with its manager");
  ok(`the other person keeps access but not the controls: "${other.json.message}"`);
  const untick = await req(`/api/booth/tracks/${code}/contest`, { method: "POST", body: { email: guestA.email, enter: false } });
  if (untick.json?.contest?.entered !== false || !(await inVote(false))) fail("unticking did not take the song out of the vote");
  ok("unticked: the song left the vote for everyone (this run leaves nothing in the preview's vote)");
  const back = await req("/api/party/rejoin", { method: "POST", body: { guest_key: a.json.guest_key } });
  if (back.status !== 201 || back.json?.session?.status !== "waiting") fail(`Get back in line answered ${back.status} ${back.text.slice(0, 120)}`);
  ok("once their song is uploaded, one tap puts the same person back in line");
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
console.log(`FIRST_RUN OK ${base}: ${step} steps${cleaned}${token ? "" : " (the team's emailed-code sign-in is a person's step: set FIRST_RUN_TEAM_TOKEN to cover the team's line, the recording, the upload station and the manager's entry too)"}`);
