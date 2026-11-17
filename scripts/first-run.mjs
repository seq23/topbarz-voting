#!/usr/bin/env node
// The partner's first session on a preview, played end to end over HTTP (the holiday party,
// 17 Nov 2026). Exits non-zero on the first failure and prints one line starting FIRST_RUN OK
// when every step passed.
//   node scripts/first-run.mjs --url https://<branch>.topbarz-voting.pages.dev   (or FIRST_RUN_URL)
// Steps: every changed page loads with no placeholder text or error; the party is on; two guests
// sign up and join one group by its code; a reload (the guest's own refresh) still shows both;
// the engineer uploads a song; both enter its code with their emails; one ticks "Enter the
// contest" and the song is NOT in the vote ("waiting on" the other); the other ticks and it IS
// in the vote within 10 s, with no script run; a reload still says entered; one unticks and it
// leaves the vote (so the run leaves nothing in the preview's vote); the team's line refuses
// anyone not signed in. With FIRST_RUN_TEAM_TOKEN (a team token from signing in on that
// preview) it also marks the group green, checks it on a second read, and undoes it.
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
ok("every changed page loads (join, team, track, the vote, booth, holiday rules, the QR sign, listen) with no placeholder text");
const party = await req("/api/party");
if (party.json?.on !== true) fail(`the party is not switched on here (/api/party: ${party.text.slice(0, 80)})`);
ok("the holiday party is on");

// 2. Two guests, one group, and a reload.
const tag = `${Date.now().toString(36)}`;
const guestA = { name: `Test Ava ${tag}`, phone: "555 010 2030", email: `first-run-a-${tag}@example.com`, city: "Brooklyn", instagram: "", website: "" };
const guestB = { name: `Test Bo ${tag}`, phone: "555 010 4050", email: `first-run-b-${tag}@example.com`, city: "Queens", instagram: "", website: "" };
const a = await req("/api/party/join", { method: "POST", body: guestA });
if (a.status !== 201 || !/^[A-Z]{4}$/.test(a.json?.session?.code ?? "")) fail(`sign-up A: ${a.status} ${a.text.slice(0, 120)}`);
const b = await req("/api/party/join", { method: "POST", body: { ...guestB, session_code: a.json.session.code } });
if (b.status !== 201 || b.json?.session?.code !== a.json.session.code) fail(`sign-up B with A's code: ${b.status} ${b.text.slice(0, 120)}`);
if (/555|@example\.com|Brooklyn/.test(JSON.stringify({ ...b.json, guest_key: "" }))) fail("a guest's answer carries a phone, an email or a city");
ok(`two guests signed up into one group (${a.json.session.code}), and neither answer carries a phone or an email`);
const reload = await req("/api/party/me", { method: "POST", body: { guest_key: a.json.guest_key } });
if (reload.json?.session?.size !== 2) fail(`after a reload the group has ${reload.json?.session?.size} people, not 2`);
ok(`a reload still shows the group of 2 (${reload.json.session.names.join(", ")}), place ${reload.json.session.place}`);
const wrong = await req("/api/party/join", { method: "POST", body: { ...guestA, email: `first-run-c-${tag}@example.com`, session_code: "ZZZZ" } });
if (wrong.json?.error !== "no_session") fail(`a wrong group code answered ${wrong.status} ${wrong.text.slice(0, 80)}`);
ok(`a wrong group code says: "${wrong.json.message}"`);

// 3. The song: uploaded, entered by both, the contest box, the vote.
const bytes = new Uint8Array(2048).map((_, i) => (i < 3 ? [0x49, 0x44, 0x33][i] : i % 251));
const up = await req("/api/booth/tracks", { method: "POST", headers: { "x-file-name": encodeURIComponent(`Test - First run ${tag}.mp3`), "content-type": "audio/mpeg", "content-length": String(bytes.byteLength) }, raw: bytes });
if (up.status !== 200 || !/^\d{4}$/.test(up.json?.code ?? "")) fail(`the booth upload: ${up.status} ${up.text.slice(0, 120)}`);
const code = up.json.code;
ok(`the engineer's upload gave code ${code}`);
for (const g of [guestA, guestB]) {
  const e = await req(`/api/booth/tracks/${code}/enter`, { method: "POST", body: { email: g.email } });
  if (e.status !== 200 || e.json?.contest?.on !== true) fail(`entering the code: ${e.status} ${e.text.slice(0, 120)}`);
  if (e.json.contest.you.in !== false) fail("the contest box did not start unticked");
}
ok("both entered the code with their emails, and the contest box starts unticked for each");
const forB = await req(`/api/booth/tracks/${code}/contest`, { method: "POST", body: { email: guestB.email, enter: true, agree: true, guest_key: a.json.guest_key } });
if (forB.status !== 403 || forB.json?.error !== "not_your_sign_up") fail(`A's phone ticking B's box answered ${forB.status} ${forB.text.slice(0, 120)}`);
ok("one person cannot tick a friend's box: A's phone with B's email is refused (403 not_your_sign_up)");
const tickA = await req(`/api/booth/tracks/${code}/contest`, { method: "POST", body: { email: guestA.email, enter: true, agree: true, guest_key: a.json.guest_key } });
if (tickA.json?.error === "voting_closed") fail("the preview's voting window is closed: run npm run party-window -- --env preview --starts <ISO> --ends <ISO>");
if (tickA.status !== 200 || tickA.json.contest.entered !== false || !tickA.json.contest.waiting_on.includes("Test")) fail(`one tick: ${tickA.status} ${tickA.text.slice(0, 160)}`);
ok(`one of two ticked: not entered, "waiting on ${tickA.json.contest.waiting_on.join(", ")}"`);
const inVote = async (want) => {
  for (let i = 0; i < 12; i++) {
    const s = await req(`/api/state?first-run=${Date.now()}`);
    const has = (s.json?.tracks ?? []).some((t) => t.label === "Test & Test");
    if (has === want) return true;
    await sleep(1000);
  }
  return false;
};
if (!(await inVote(false))) fail("the song is in the vote after only one of two ticked");
const tickB = await req(`/api/booth/tracks/${code}/contest`, { method: "POST", body: { email: guestB.email, enter: true, agree: true, guest_key: b.json.guest_key } });
if (tickB.json?.contest?.entered !== true) fail(`both ticked but not entered: ${tickB.text.slice(0, 160)}`);
if (!(await inVote(true))) fail("both ticked, but the song did not show in /api/state within 12 s");
ok("both ticked: the song is in the vote (/api/state) with no script run");
const again = await req(`/api/booth/tracks/${code}/contest-status`, { method: "POST", body: { email: guestB.email } });
if (again.json?.contest?.entered !== true || !again.json.contest.people.every((p) => p.in)) fail("after a reload the song no longer reads entered for everyone");
ok("a reload (the other phone's refresh) still reads entered, both in");
const untick = await req(`/api/booth/tracks/${code}/contest`, { method: "POST", body: { email: guestA.email, enter: false } });
if (untick.json?.contest?.entered !== false || !(await inVote(false))) fail("unticking did not take the song out of the vote");
ok("one unticked: the song left the vote for everyone (this run leaves nothing in the preview's vote)");

// 4. The team's line: closed to anyone not signed in; with a team token, green and undo.
const line = await req("/api/party/team/line");
if (line.status !== 401 || line.json?.error !== "team_sign_in") fail(`the team's line without signing in answered ${line.status}`);
ok("the team's line refuses anyone not signed in (401 team_sign_in)");
const token = process.env.FIRST_RUN_TEAM_TOKEN;
if (token) {
  const auth = { authorization: `Bearer ${token}` };
  const l = await req("/api/party/team/line", { headers: auth });
  const s = (l.json?.sessions ?? []).find((x) => x.code === a.json.session.code);
  if (!s || s.guests.length !== 2) fail("the team's line does not show the new group of 2");
  const green = await req(`/api/party/team/sessions/${s.id}/status`, { method: "POST", headers: auth, body: { status: "booth", from: "waiting" } });
  const second = await req("/api/party/team/line", { headers: auth });
  if (green.json?.session?.status !== "booth" || (second.json.sessions.find((x) => x.id === s.id)?.status !== "booth")) fail("marking the group green did not hold on a second read");
  const undo = await req(`/api/party/team/sessions/${s.id}/status`, { method: "POST", headers: auth, body: { status: "waiting", from: "booth" } });
  if (undo.json?.session?.status !== "waiting") fail("undo did not put the group back");
  ok("signed in as the team: the group shows with its 2 people, goes green, holds on a second read, and undo puts it back");
}
console.log(`FIRST_RUN OK ${base}: ${step} steps${token ? "" : " (the team's emailed-code sign-in is a person's step: set FIRST_RUN_TEAM_TOKEN to cover the team's line too)"}`);
