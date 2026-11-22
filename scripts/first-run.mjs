#!/usr/bin/env node
// The partner's first session on a preview, played end to end over HTTP (the holiday party, after
// Scooter's consolidated revision list of 18 Nov 2026). Exits non-zero on the first failure and
// prints one line starting FIRST_RUN OK when every step passed.
//   node scripts/first-run.mjs --url https://<branch>.topbarz-voting.pages.dev   (or FIRST_RUN_URL)
// Steps: every changed page loads with no placeholder text or error (and the partner logos load);
// the party is on, the end (27 Nov, 11:59 PM ET), the prize line and the updates box are as Scooter set them; two people sign up, each on their own (no codes, no group
// setup), and a reload still shows the first; the same email cannot sign up again while in line
// ("already in line", said, not a silent block); with nobody at the upload station, a walk-up
// upload's code lets someone hear and download but never puts them on the song; the team's line
// refuses anyone not signed in. With FIRST_RUN_TEAM_TOKEN (a team token from signing in on that
// preview) it also plays the team's side, as Scooter's group did on 19 Nov 2026: the first person
// records and comes out; the second goes in while the song is not uploaded, the line asks "same song
// or new?" and the answer "same" puts them on the same recording, which is not at the upload station
// while anyone of it is in the booth; the engineer's upload (with the key of the names confirmed)
// lands on both and marks them done; both see "have access" and both have the controls; one ticks
// Enter and it is in the vote within 12 s with no script run; the other withdraws it for everyone
// and the line says who; the other enters it again; a reload reads entered with who last changed it;
// unticking takes it out (the run leaves nothing in the preview's vote); and one tap puts the first
// person back in line. With --demo <code> it plays Scooter's demo on that
// song too, and with --demo <code> --demo-only only that (see below).
// Test data only: "Test …" names, @example.com addresses; production refuses it (and the party
// is off there).
import { PARTY_VOTING_ENDS_AT } from "../functions/_lib/config.js";
const PARTY_END = new Date(Date.parse(PARTY_VOTING_ENDS_AT)).toISOString();
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

// The end (Scooter, 19 Nov 2026): Friday, November 27 at 11:59 PM Eastern, on the page with the
// countdown, beside "Prize details TBD" and an unticked, optional "Send me Top Barz updates".
const state0 = await req("/api/state");
if (state0.json?.voting_ends_at !== PARTY_END) fail(`/api/state ends at ${state0.json?.voting_ends_at}, not ${PARTY_END} (11:59 PM ET, 27 Nov): a preview settings row may override it (npm run party-window -- --env preview --clear)`);
if (state0.json?.closed !== false && Date.now() < Date.parse(PARTY_END)) fail("/api/state says voting is closed before the end");
const home = await req("/", { headers: { accept: "text/html" } });
if (!home.text.includes('<strong id="tbz-ends">Friday, November 27 at 11:59 PM EST</strong>')) fail("the voting page does not show the cutoff (Friday, November 27 at 11:59 PM EST)");
if (/id="tbz-countdown-row"[^>]*hidden/.test(home.text)) fail("the countdown row is hidden");
if (!home.text.includes("Prize details TBD")) fail("the voting page does not say Prize details TBD");
if (!/<input id="tbz-gate-optin" name="marketing_opt_in" type="checkbox">/.test(home.text) || /tbz-gate-optin[^>]*(checked|required)/.test(home.text)) fail("Send me Top Barz updates must ship unticked and optional");
ok("voting ends Friday, November 27 at 11:59 PM EST, shown with the countdown; Prize details TBD; the updates box unticked and optional");

// The demo (Scooter, 19 Nov 2026: "make sure I can use my own access to take a song through contest
// entry and see it appear on the voting page"). With --demo <code> (or FIRST_RUN_DEMO_CODE; the code
// `npm run demo-song` printed), play exactly his steps on that song: its code and the demo email open
// it with the controls, Enter the contest puts it on the voting page, and unticking takes it off
// again, so the song is left as it was found. A demo song already entered is left alone.
// With --demo-only it plays the read-only page checks and the demo, nothing else: no sign-ups and no
// walk-up upload, so it is the check to run just before a call and leaves no test rows behind.
const demoCode = arg("demo") ?? process.env.FIRST_RUN_DEMO_CODE;
const demoOnly = process.argv.includes("--demo-only");
if (demoOnly && !demoCode) fail("--demo-only needs --demo <code> (the code npm run demo-song printed)");
let demoAs = "";
async function playDemo() {
  const { DEMO_DEFAULTS } = await import("./demo-song.mjs");
  const email = arg("demo-email") ?? DEMO_DEFAULTS.email;
  const opened = await req(`/api/booth/tracks/${demoCode}/enter`, { method: "POST", body: { email } });
  const c = opened.json?.contest;
  if (opened.status !== 200 || !opened.json?.download_url) fail(`the demo song ${demoCode} with ${email}: ${opened.status} ${opened.text.slice(0, 160)}`);
  if (c?.blocked) fail(`the demo song ${demoCode} cannot go in the contest: ${JSON.stringify(c.blocked).slice(0, 160)}`);
  if (c?.you?.can_manage !== true) fail(`${email} does not have the demo song ${demoCode}'s controls: run npm run demo-song -- --env preview (with --host <that email> for your own) to set it up`);
  demoAs = c.you.host === true ? "the host's own email" : "the demo singer's email";
  ok(`the demo song ${demoCode} opens with ${demoAs}: hear, download, and the controls are theirs`);
  if (c.entered) {
    ok(`the demo song ${demoCode} is already entered: left as it is`);
  } else {
    const label = c.title || c.people.map((p) => p.first_name).join(" & ");
    const shows = async (want) => {
      for (let i = 0; i < 12; i++) {
        const st = await req(`/api/state?first-run=${Date.now()}`);
        if ((st.json?.tracks ?? []).some((t) => t.label === label) === want) return true;
        await sleep(1000);
      }
      return false;
    };
    const tick = await req(`/api/booth/tracks/${demoCode}/contest`, { method: "POST", body: { email, enter: true, agree: true } });
    if (tick.status !== 200 || tick.json?.contest?.entered !== true) fail(`Enter the contest on the demo song: ${tick.status} ${tick.text.slice(0, 160)}`);
    if (!(await shows(true))) fail(`the demo song was entered but "${label}" did not show in /api/state within 12 s`);
    ok(`Enter the contest on the demo song: "${label}" is on the voting page within 12 s, no script run`);
    const untick = await req(`/api/booth/tracks/${demoCode}/contest`, { method: "POST", body: { email, enter: false } });
    if (untick.json?.contest?.entered !== false || !(await shows(false))) fail("unticking the demo song did not take it off the voting page");
    ok("unticked: the demo song is off the voting page again, ready for the call");
  }
}
if (demoOnly) {
  await playDemo();
  console.log(`FIRST_RUN OK ${base}: ${step} steps (demo only: the pages, the cutoff and the demo song ${demoCode}, played with ${demoAs}; no test rows made)`);
  process.exit(0);
}

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
if (station0.json.recording?.length) fail(`a recording is under way (${station0.json.recording.map((p) => p.first_name).join(", ")}): play this once the booth is free`);
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
for (const file of ["line.csv", "songs.csv"]) {
  const r = await req(`/api/party/team/export/${file}`);
  if (r.status !== 401 || /@/.test(r.text)) fail(`the ${file} download without signing in answered ${r.status}`);
}
ok("the team's two downloads (line.csv, songs.csv) refuse anyone not signed in, with no detail");
const token = process.env.FIRST_RUN_TEAM_TOKEN;
if (token) {
  const auth = { authorization: `Bearer ${token}` };
  const l = await req("/api/party/team/line", { headers: auth });
  const find = (sessions, g) => (sessions ?? []).find((x) => x.guests?.some((y) => y.email === g.email));
  const sA = find(l.json?.sessions, guestA);
  const sB = find(l.json?.sessions, guestB);
  if (!sA || !sB || sA.id === sB.id) fail("the team's line does not show the two sign-ups as a card each");
  const move = (s, status, from, song) => req(`/api/party/team/sessions/${s.id}/status`, { method: "POST", headers: auth, body: { status, from, ...(song ? { song } : {}) } });
  const lane = async (s, status, from, song) => (await move(s, status, from, song)).json?.session?.status;
  // Ava records her part and comes out; Bo goes in for his part of the same song (one after the other).
  if ((await lane(sA, "booth", "waiting")) !== "booth" || (await lane(sA, "upload", "booth")) !== "upload") fail("green or red did not take");
  const asked = await move(sB, "booth", "waiting");
  if (asked.status !== 409 || asked.json?.error !== "which_song") fail(`with Ava's song not uploaded and the booth empty, Bo's green tap was not asked "same song or new?": ${asked.status} ${asked.text.slice(0, 120)}`);
  if ((await lane(sB, "booth", "waiting", "same")) !== "booth") fail("Same song did not take");
  const l2 = await req("/api/party/team/line", { headers: auth });
  const [tA, tB] = [find(l2.json.sessions, guestA)?.take_id, find(l2.json.sessions, guestB)?.take_id];
  if (!tA || tA !== tB) fail(`Ava and Bo are not one recording (takes ${tA}, ${tB})`);
  const during = (await req("/api/booth/sessions")).json;
  if (during?.next || during?.recording?.length !== 2) fail(`while Bo records, the booth page should show the whole recording and nothing at the station: ${JSON.stringify(during).slice(0, 200)}`);
  if ((await lane(sB, "upload", "booth")) !== "upload") fail("red did not take for Bo");
  const station = (await req("/api/booth/sessions")).json;
  if (station?.next?.id !== tA || station.next.size !== 2 || station.next.key !== `${tA}.2`) fail(`the upload station does not show the recording of 2: ${JSON.stringify(station?.next)}`);
  ok("signed in as the team: Ava, then Bo for the same song (the line asks same song or new) are one recording; the booth page shows both, and the engineer confirms both names");
  const up = await uploadSong(`Test - First run ${tag}.mp3`, { "x-party-take": station.next.key });
  if (up.status !== 200 || up.json?.tagged !== true) fail(`the upload for the recording: ${up.status} ${up.text.slice(0, 120)}`);
  const code = up.json.code;
  const l3 = await req("/api/party/team/line", { headers: auth });
  if (find(l3.json.sessions, guestA)?.status !== "done" || find(l3.json.sessions, guestB)?.status !== "done") fail("the upload did not mark both done");
  for (const g of [guestA, guestB]) {
    const seen = await req(`/api/booth/tracks/${code}/enter`, { method: "POST", body: { email: g.email } });
    if (seen.json?.contest?.you?.performer !== true || seen.json.contest.you.can_manage !== true || seen.json.contest.access?.length !== 2) fail(`${g.email} on the song: ${seen.text.slice(0, 160)}`);
  }
  ok(`the song (${code}) belongs to both, not just the last one out: both are done, both are listed as having access, both have the controls`);
  const tick = await req(`/api/booth/tracks/${code}/contest`, { method: "POST", body: { email: guestA.email, enter: true, agree: true } });
  if (tick.json?.error === "voting_closed" || tick.json?.error === "voting_not_open") fail("the preview's voting window is closed: run npm run party-window -- --env preview --starts <ISO> --no-end");
  if (tick.status !== 200 || tick.json.contest.entered !== true || tick.json.contest.changed?.action !== "entered") fail(`Ava's Enter: ${tick.status} ${tick.text.slice(0, 160)}`);
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
  ok("Ava ticks Enter and the song is in the vote (/api/state) with no script run and no group confirmation");
  const onPage = (await req(`/api/state?first-run=${Date.now()}`)).json?.tracks?.find((t) => t.label === label);
  if (JSON.stringify(onPage?.people) !== JSON.stringify(["Test", "Test"])) fail(`the song on the voting page does not name its two people by first name: ${JSON.stringify(onPage?.people)}`);
  ok("the voting page names the people on the song, first names only");
  const out = await req(`/api/booth/tracks/${code}/contest`, { method: "POST", body: { email: guestB.email, enter: false } });
  if (out.status !== 200 || out.json?.contest?.entered !== false || out.json.contest.changed?.action !== "withdrawn" || !(await inVote(false))) fail(`Bo's withdraw: ${out.status} ${out.text.slice(0, 160)}`);
  const seenByA = await req(`/api/booth/tracks/${code}/contest-status`, { method: "POST", body: { email: guestA.email } });
  if (seenByA.json?.contest?.changed?.action !== "withdrawn") fail("Ava's page does not say the song was withdrawn");
  ok("Bo withdraws it for everyone: out of the vote, and Ava's page says who withdrew it");
  const back2 = await req(`/api/booth/tracks/${code}/contest`, { method: "POST", body: { email: guestB.email, enter: true, agree: true } });
  if (back2.json?.contest?.entered !== true || !(await inVote(true))) fail("Bo could not enter it again");
  const again = await req(`/api/booth/tracks/${code}/contest-status`, { method: "POST", body: { email: guestA.email } });
  if (again.json?.contest?.entered !== true || again.json.contest.changed?.action !== "entered" || !/^\/#/.test(again.json.contest.vote_url ?? "")) fail("after a reload the song no longer reads entered, with who entered it and its link on the voting page");
  ok("entered again by Bo: the same song is back in the vote, and a reload shows who last changed it and View Contest's link to it");
  const untick = await req(`/api/booth/tracks/${code}/contest`, { method: "POST", body: { email: guestA.email, enter: false } });
  if (untick.json?.contest?.entered !== false || !(await inVote(false))) fail("unticking did not take the song out of the vote");
  ok("unticked: the song left the vote for everyone (this run leaves nothing in the preview's vote)");
  for (const [file, want] of [["line.csv", guestA.email], ["songs.csv", `"${code}",`]]) {
    const r = await req(`/api/party/team/export/${file}`, { headers: auth });
    if (r.status !== 200 || !r.text.startsWith("\uFEFF\"") || !r.text.includes(want)) fail(`the team's ${file} download: ${r.status}`);
  }
  ok("signed in, the team downloads the line (this run's sign-ups in it) and the songs (this run's song in it)");
  const back = await req("/api/party/rejoin", { method: "POST", body: { guest_key: a.json.guest_key } });
  if (back.status !== 201 || back.json?.session?.status !== "waiting") fail(`Get back in line answered ${back.status} ${back.text.slice(0, 120)}`);
  ok("once their song is uploaded, one tap puts the same person back in line");
}
if (demoCode && !demoOnly) await playDemo();
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
console.log(`FIRST_RUN OK ${base}: ${step} steps${cleaned}${token ? "" : " (the team's emailed-code sign-in is a person's step: set FIRST_RUN_TEAM_TOKEN to cover the team's line, the recording, the upload station and the shared entry too)"}`);
