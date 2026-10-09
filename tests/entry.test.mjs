// The contest entry (Scooter, 9 Oct 2026, /entry): the two routes (POST /api/entries/upload, the raw
// audio into R2; POST /api/entries, the fields and the upload id), every field's rules on both
// sides, the page and its copy, the export, the promotion's verdict — and the rule that matters
// most: an entry is never in the vote, and no route ever answers a name, an email or a phone number.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import * as beats from "../functions/api/beats.js";
import * as booth from "../functions/api/booth/[[path]].js";
import * as entries from "../functions/api/entries.js";
import * as entryUpload from "../functions/api/entries/upload.js";
import * as state from "../functions/api/state.js";
import * as media from "../functions/media/[[path]].js";
import { BOOTH_EXTENSIONS, BOOTH_MAX_BYTES, cleanEmail } from "../functions/_lib/booth.js";
import { LIMITS } from "../functions/_lib/config.js";
import { ENTRY_MAX_MEMBERS, cleanPhone, cleanText, entryKey, entryLabel, isUploadId, parseEntry, promoteVerdict, uploadId } from "../functions/_lib/entries.js";
import { computeTally } from "../functions/_lib/tally.js";
import { COPY } from "../public/js/entry-copy.js";
import { MAX_MEMBERS, checkEntry, cleanPhone as pagePhone, cleanText as pageText, entryBody, failureWords } from "../public/js/entry-rules.js";
import { MAX_UPLOAD_BYTES, UPLOAD_EXTENSIONS, cleanEmail as pageEmail } from "../public/js/booth-rules.js";
import { entriesCsv, entryMembersCsv } from "../scripts/export.mjs";
import { ROOT, acceptedBeforeLimit, call, freshIp, makeEnv } from "./helpers.mjs";

const src = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const mp3 = (n = 2048) => new Uint8Array(Array.from({ length: n }, (_, i) => i % 251));

let env, dispose;
before(async () => { ({ env, dispose } = await makeEnv()); });
after(() => dispose());

// A raw-body upload, as the page sends it (not JSON, so not helpers.call).
async function upload(e, { name = "Test - Jane.mp3", type = "audio/mpeg", bytes = mp3(), length = bytes?.byteLength, ip = freshIp(), method = "POST" } = {}) {
  const h = new Headers({ "cf-connecting-ip": ip });
  if (name !== null) h.set("x-file-name", name);
  if (type !== null) h.set("content-type", type);
  if (length !== null && length !== undefined) h.set("content-length", String(length));
  const request = new Request("https://voting.test/api/entries/upload", { method, headers: h, body: method === "POST" ? bytes ?? undefined : undefined });
  const pending = [];
  const res = await entryUpload.onRequest({ request, env: e, params: {}, waitUntil: (x) => pending.push(x) });
  await Promise.all(pending);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body, text, headers: res.headers };
}
const FIELDS = { first_name: "Jane", last_name: "Doe", city: "Atlanta", email: "Jane.Doe@Example.com", phone: "(404) 555-0100", in_group: false, members: [], agree: true, website: "" };
const send = (e, body, ip = freshIp()) => call(entries.onRequest, e, { method: "POST", path: "/api/entries", body, ip });
async function enter(e, extra = {}, uploadOpts = {}) {
  const up = await upload(e, uploadOpts);
  assert.equal(up.status, 200, up.text);
  return { up, res: await send(e, { ...FIELDS, upload_id: up.body.upload_id, ...extra }) };
}
const count = async (table) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;

// ── The fields: every one required, on the server ────────────────────────────────────────────────
test("the fields: each is required and refused with its own code and field; the good body passes and is cleaned", () => {
  const good = parseEntry({ ...FIELDS, upload_id: "a".repeat(24) });
  assert.equal(good.ok, true);
  assert.deepEqual(good.value, { first_name: "Jane", last_name: "Doe", city: "Atlanta", email: "jane.doe@example.com", phone: "4045550100", instagram: "", track_title: "", in_group: false, members: [], upload_id: "a".repeat(24) });
  const extras = parseEntry({ ...FIELDS, instagram: "  @jane.doe, @janed ", track_title: "Midnight\n Run", upload_id: "a".repeat(24) });
  assert.deepEqual([extras.value.instagram, extras.value.track_title], ["@jane.doe, @janed", "Midnight Run"], "the Instagram handle(s) and the title are optional and cleaned");
  assert.equal(parseEntry({ ...FIELDS, instagram: "x".repeat(300), track_title: "y".repeat(300), upload_id: "a".repeat(24) }).value.instagram.length, 120);
  const base = { ...FIELDS, upload_id: "a".repeat(24) };
  const refusals = [
    [{ first_name: "  " }, "first_name", "first_name_required"],
    [{ first_name: undefined }, "first_name", "first_name_required"],
    [{ last_name: "" }, "last_name", "last_name_required"],
    [{ city: "\n" }, "city", "city_required"],
    [{ email: "nope" }, "email", "bad_email"],
    [{ email: "a@b" }, "email", "bad_email"],
    [{ phone: "12" }, "phone", "bad_phone"],
    [{ phone: "call me" }, "phone", "bad_phone"],
    [{ in_group: "yes" }, "in_group", "group_required"],
    [{ in_group: undefined }, "in_group", "group_required"],
    [{ agree: false }, "agree", "agree_required"],
    [{ agree: "true" }, "agree", "agree_required"],
    [{ agree: undefined }, "agree", "agree_required"],
    [{ upload_id: "" }, "upload_id", "track_required"],
    [{ upload_id: "../../etc" }, "upload_id", "track_required"],
    [{ website: "http://spam.example" }, "website", "bad_request"],
    [{ members: [{ first_name: "A", last_name: "B", email: "a@b.co" }] }, "members", "members_without_group"],
  ];
  for (const [patch, field, code] of refusals) {
    const r = parseEntry({ ...base, ...patch });
    assert.deepEqual([r.ok, r.field, r.error], [false, field, code], JSON.stringify(patch));
    assert.ok(r.message.length > 5);
  }
  for (const body of [null, undefined, [], "x", 3]) assert.equal(parseEntry(body).ok, false);
});

test("a group: yes needs 1 to 10 people, each with a first name, a last name and an email; no sends none", () => {
  const person = (i) => ({ first_name: `P${i}`, last_name: "Doe", email: `p${i}@example.com` });
  const base = { ...FIELDS, in_group: true, upload_id: "b".repeat(24) };
  assert.equal(parseEntry({ ...base, members: [] }).error, "members_required");
  assert.equal(parseEntry({ ...base }).error, "members_required");
  assert.equal(parseEntry({ ...base, members: [person(1)] }).ok, true);
  assert.equal(parseEntry({ ...base, members: Array.from({ length: ENTRY_MAX_MEMBERS }, (_, i) => person(i)) }).ok, true);
  assert.equal(parseEntry({ ...base, members: Array.from({ length: ENTRY_MAX_MEMBERS + 1 }, (_, i) => person(i)) }).error, "too_many_members");
  for (const bad of [{ first_name: "" }, { last_name: " " }, { email: "x" }, { email: undefined }]) {
    const r = parseEntry({ ...base, members: [person(0), { ...person(1), ...bad }] });
    assert.deepEqual([r.error, r.field], ["bad_member", "members.1"], JSON.stringify(bad));
  }
  assert.equal(parseEntry({ ...base, members: [null] }).error, "bad_member");
  assert.equal(parseEntry({ ...base, members: [{ ...person(1), email: "  Mixed@Case.COM " }] }).value.members[0].email, "mixed@case.com");
  assert.equal(parseEntry({ ...FIELDS, in_group: false, members: [], upload_id: "b".repeat(24) }).ok, true, "no group, no members");
});

test("the page and the server agree on every field (the same rules, word for word)", () => {
  assert.equal(MAX_MEMBERS, ENTRY_MAX_MEMBERS);
  assert.equal(MAX_UPLOAD_BYTES, BOOTH_MAX_BYTES);
  assert.deepEqual(UPLOAD_EXTENSIONS, BOOTH_EXTENSIONS);
  for (const phone of ["(404) 555-0100", "+1 404.555.0100", "404-555-0100", "5550100", "+44 20 7946 0958", "12", "", "   ", "abc", "404 555 0100 ext 5", "1234567890123456", "+1+4045550100", "40+45550100", null, 4045550100]) {
    assert.equal(pagePhone(phone), cleanPhone(phone), `phone ${JSON.stringify(phone)}`);
  }
  assert.equal(cleanPhone("+1 (404) 555-0100"), "+14045550100");
  assert.equal(cleanPhone("(404) 555-0100"), "4045550100");
  for (const email of ["a@b.co", " A@B.CO ", "a@b", "a b@c.co", "@b.co", "a@@b.co", "", null, "x".repeat(260) + "@b.co"]) assert.equal(pageEmail(email), cleanEmail(email), `email ${JSON.stringify(email)}`);
  for (const text of ["  Jane   Doe ", "a\u0000b\nc", "x".repeat(200), "", 7, null]) assert.equal(pageText(text), cleanText(text), `text ${JSON.stringify(text)}`);
  // Whatever the page lets through, the server accepts, and the other way round.
  const file = { name: "song.mp3", size: 1000 };
  const person = { first_name: "P", last_name: "Q", email: "p@example.com" };
  const cases = [
    { ...FIELDS }, { ...FIELDS, phone: "12" }, { ...FIELDS, email: "x" }, { ...FIELDS, in_group: null }, { ...FIELDS, agree: false }, { ...FIELDS, city: " " },
    { ...FIELDS, in_group: true, members: [] }, { ...FIELDS, in_group: true, members: [person] }, { ...FIELDS, in_group: true, members: [person, { ...person, email: "bad" }] },
    { ...FIELDS, in_group: true, members: Array.from({ length: 11 }, () => person) }, { ...FIELDS, first_name: "" }, { ...FIELDS, last_name: "" },
  ];
  for (const values of cases) {
    const pageSays = checkEntry({ ...values, file }, COPY);
    const serverSays = parseEntry({ ...values, upload_id: "c".repeat(24) });
    // The page lets 11 people through its list only if the add button did (it hides at 10); the server is the backstop.
    const tooMany = Array.isArray(values.members) && values.members.length > MAX_MEMBERS;
    assert.equal(pageSays === null, serverSays.ok || tooMany, JSON.stringify(values));
    if (pageSays && !serverSays.ok) assert.equal(pageSays.field.split(".")[0], serverSays.field.split(".")[0], `the same field first: ${JSON.stringify(values)}`);
  }
  assert.deepEqual(checkEntry({ ...FIELDS, file: null }, COPY).field, "track");
  assert.equal(checkEntry({ ...FIELDS, file: { name: "notes.pdf", size: 10 } }, COPY).message, COPY.notAudio);
  assert.equal(checkEntry({ ...FIELDS, file: { name: "big.wav", size: MAX_UPLOAD_BYTES + 1 } }, COPY).message, COPY.tooBig);
  assert.equal(checkEntry({ ...FIELDS, file: { name: "empty.wav", size: 0 } }, COPY).message, COPY.empty);
  // The body the page sends parses on the server with every field intact.
  const sent = entryBody({ ...FIELDS, in_group: true, members: [person], file }, "d".repeat(24), "");
  assert.equal(sent.agree, true);
  assert.deepEqual(parseEntry(sent).value.members, [person]);
  assert.deepEqual(entryBody({ ...FIELDS, in_group: false, members: [person] }, "d".repeat(24)).members, [], "a 'no' sends no people, even if some were typed and then hidden");
  for (const m of COPY.need.member.matchAll(/\{n\}/g)) assert.ok(m);
});

// ── The upload ───────────────────────────────────────────────────────────────────────────────────
test("upload: audio goes into R2 under entries/ and comes back as a one-time id; nothing else is answered", async () => {
  const bytes = mp3(4096);
  const res = await upload(env, { name: "Test - Jane.mp3", bytes });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(Object.keys(res.body).sort(), ["file_name", "size", "upload_id"]);
  assert.equal(isUploadId(res.body.upload_id), true);
  assert.equal(res.body.file_name, "Test - Jane.mp3");
  assert.equal(res.body.size, 4096);
  const stored = await env.MEDIA.get(entryKey(res.body.upload_id, "mp3"));
  assert.ok(stored, "the object is in the bucket under entries/<id>.mp3");
  assert.equal(stored.size, 4096);
  assert.equal(stored.httpMetadata.contentType, "audio/mpeg");
  const row = await env.DB.prepare("SELECT * FROM entry_uploads WHERE id = ?1").bind(res.body.upload_id).first();
  assert.deepEqual([row.file_name, row.size, row.media_key], ["Test - Jane.mp3", 4096, `entries/${res.body.upload_id}.mp3`]);
  assert.equal((await media.onRequest({ request: new Request(`https://voting.test/media/${row.media_key}`), env, params: { path: row.media_key.split("/") } })).status, 404, "the file is never served");
  assert.equal((await upload(env, { name: "x.wav", type: "audio/wav" })).status, 200);
  assert.equal((await upload(env, { name: "x.m4a", type: "application/octet-stream" })).status, 200, "octet-stream with an audio extension is how some phones send audio");
});

test("upload: audio only, a declared size from 1 byte to 100 MB, and a file name; nothing is stored when refused", async () => {
  const objects = async () => (await env.MEDIA.list({ prefix: "entries/" })).objects.length;
  const before = [await objects(), await count("entry_uploads")];
  const cases = [
    [{ name: "notes.pdf", type: "application/pdf" }, 415, "not_audio"],
    [{ name: "song.mp3", type: "text/plain" }, 415, "not_audio"],
    [{ name: "song.exe", type: "audio/mpeg" }, 415, "not_audio"],
    [{ name: "song", type: "audio/mpeg" }, 415, "not_audio"],
    [{ name: null }, 400, "file_name_required"],
    [{ length: null }, 413, "bad_size"],
    [{ length: 0, bytes: new Uint8Array(0) }, 413, "bad_size"],
    [{ length: BOOTH_MAX_BYTES + 1 }, 413, "bad_size"],
  ];
  for (const [opts, status, code] of cases) {
    const r = await upload(env, opts);
    assert.deepEqual([r.status, r.body?.error], [status, code], JSON.stringify(opts));
  }
  assert.equal((await upload(env, { bytes: mp3(100), length: 99 })).status >= 400, true, "a body that is not the declared size is refused");
  assert.deepEqual([await objects(), await count("entry_uploads")], before, "nothing was stored");
  assert.equal((await upload(env, { method: "GET" })).status, 405);
});

test("upload: 10 an hour per connection, 300 a day for the whole site, and none once voting has ended", async () => {
  assert.deepEqual([LIMITS.entryUploadsPerIp.max, LIMITS.entryUploadsPerIp.window, LIMITS.entryUploadsPerDay.max, LIMITS.entryUploadsPerDay.window, LIMITS.entriesPerIp.max], [10, 3600, 300, 86400, 10]);
  const ip = freshIp();
  const accepted = await acceptedBeforeLimit((i) => upload(env, { ip, bytes: mp3(64), name: `t${i}.mp3` }), LIMITS.entryUploadsPerIp.max);
  assert.ok(accepted >= LIMITS.entryUploadsPerIp.max && accepted <= 2 * LIMITS.entryUploadsPerIp.max, `accepted ${accepted} before the limit`);
  const { env: e2, dispose: d2 } = await makeEnv();
  try {
    const win = Math.floor(Date.now() / 1000 / LIMITS.entryUploadsPerDay.window) * LIMITS.entryUploadsPerDay.window;
    await e2.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES ('entry-uploads-day', ?1, ?2)").bind(win, LIMITS.entryUploadsPerDay.max).run();
    const r = await upload(e2, {});
    assert.deepEqual([r.status, r.body.error], [429, "daily_limit"]);
    const closed = await upload({ ...e2, VOTING_ENDS_AT: new Date(Date.now() - 60_000).toISOString() }, {});
    assert.deepEqual([closed.status, closed.body.error], [403, "entries_closed"]);
  } finally { d2(); }
});

// ── The entry ────────────────────────────────────────────────────────────────────────────────────
test("entry: the fields and the upload id make an entry; the answer is the number and nothing else", async () => {
  const { up, res } = await enter(env, { first_name: "  Jane ", in_group: false });
  assert.equal(res.status, 201, res.text);
  assert.deepEqual(Object.keys(res.body), ["entry"]);
  assert.equal(Number.isInteger(res.body.entry), true);
  const row = await env.DB.prepare("SELECT * FROM entries WHERE id = ?1").bind(res.body.entry).first();
  assert.deepEqual([row.first_name, row.last_name, row.city, row.email, row.phone, row.in_group, row.upload_id], ["Jane", "Doe", "Atlanta", "jane.doe@example.com", "4045550100", 0, up.body.upload_id]);
  assert.ok(row.rules_agreed_at > 0 && row.rules_agreed_at <= Date.now(), "the time the rules were agreed to is kept");
  assert.equal(Math.abs(row.created_at - row.rules_agreed_at) < 5, true);
  const text = res.text.toLowerCase();
  for (const secret of ["jane", "doe", "atlanta", "example.com", "4045550100", "555"]) assert.ok(!text.includes(secret), `the answer never carries ${secret}`);
});

test("entry: a group is kept, person by person", async () => {
  const members = [{ first_name: "Carlos", last_name: "Diaz", email: "Carlos@Example.com" }, { first_name: "Damien", last_name: "Ray", email: "damien@example.com" }];
  const { res } = await enter(env, { in_group: true, members });
  assert.equal(res.status, 201, res.text);
  const rows = (await env.DB.prepare("SELECT first_name, last_name, email FROM entry_members WHERE entry_id = ?1 ORDER BY id").bind(res.body.entry).all()).results;
  assert.deepEqual(rows, [{ first_name: "Carlos", last_name: "Diaz", email: "carlos@example.com" }, { first_name: "Damien", last_name: "Ray", email: "damien@example.com" }]);
  assert.equal((await env.DB.prepare("SELECT in_group FROM entries WHERE id = ?1").bind(res.body.entry).first()).in_group, 1);
  const bad = await enter(env, { in_group: true, members: [] });
  assert.deepEqual([bad.res.status, bad.res.body.error, bad.res.body.field], [400, "members_required", "members"]);
});

test("entry: no rules agreement, no entry; every other missing field too; and nothing is written", async () => {
  const before = await count("entries");
  const up = await upload(env);
  for (const [patch, status, code] of [[{ agree: false }, 400, "agree_required"], [{ agree: undefined }, 400, "agree_required"], [{ phone: "" }, 400, "bad_phone"], [{ email: "" }, 400, "bad_email"], [{ website: "x" }, 400, "bad_request"], [{ upload_id: "e".repeat(24) }, 404, "upload_unknown"]]) {
    const r = await send(env, { ...FIELDS, upload_id: up.body.upload_id, ...patch });
    assert.deepEqual([r.status, r.body.error], [status, code], JSON.stringify(patch));
  }
  assert.equal((await send(env, "not json")).body.error, "bad_json");
  assert.equal(await count("entries"), before);
  const ok = await send(env, { ...FIELDS, upload_id: up.body.upload_id });
  assert.equal(ok.status, 201, "the same upload still works once the fields are right: a failed try wastes nothing");
});

test("entry: one upload is one entry, even when two submissions race", async () => {
  const { up, res } = await enter(env);
  assert.equal(res.status, 201);
  const again = await send(env, { ...FIELDS, upload_id: up.body.upload_id });
  assert.deepEqual([again.status, again.body.error], [409, "upload_used"]);
  const up2 = await upload(env);
  const results = await Promise.all([1, 2, 3].map(() => send(env, { ...FIELDS, upload_id: up2.body.upload_id })));
  assert.equal(results.filter((r) => r.status === 201).length, 1, "exactly one wins");
  assert.ok(results.filter((r) => r.status !== 201).every((r) => r.body.error === "upload_used"));
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM entries WHERE upload_id = ?1").bind(up2.body.upload_id).first()).n, 1);
});

test("entry: 10 an hour per connection; closed once voting has ended; open before it starts; GET is a 405", async () => {
  const ip = freshIp();
  const up = await upload(env);
  const accepted = await acceptedBeforeLimit((i) => send(env, { ...FIELDS, upload_id: "e".repeat(24) }, ip), LIMITS.entriesPerIp.max);
  assert.ok(accepted >= LIMITS.entriesPerIp.max && accepted <= 2 * LIMITS.entriesPerIp.max, `accepted ${accepted} before the limit`);
  const pastEnd = { ...env, VOTING_ENDS_AT: new Date(Date.now() - 60_000).toISOString() };
  const closed = await send(pastEnd, { ...FIELDS, upload_id: up.body.upload_id });
  assert.deepEqual([closed.status, closed.body.error], [403, "entries_closed"]);
  const notStarted = { ...env, VOTING_STARTS_AT: new Date(Date.now() + 3_600_000).toISOString() };
  assert.equal((await upload(notStarted)).status, 200, "the entry is open before voting starts");
  assert.equal((await send(notStarted, { ...FIELDS, upload_id: up.body.upload_id })).status, 201);
  for (const method of ["GET", "PUT", "DELETE"]) assert.equal((await call(entries.onRequest, env, { method, path: "/api/entries" })).status, 405, method);
});

// ── Never in the vote, never answered ────────────────────────────────────────────────────────────
test("an entry is never in /api/state, the tally, /api/beats or the booth; no route answers its people", async () => {
  const { res } = await enter(env, { first_name: "Zelda", last_name: "Quimby", email: "zelda.quimby@example.com", phone: "+13105550123", in_group: true, members: [{ first_name: "Yolanda", last_name: "Vance", email: "yolanda.vance@example.com" }] });
  assert.equal(res.status, 201);
  state._resetStateMemo();
  const probes = [
    await call(state.onRequest, env, { path: "/api/state" }),
    await call(beats.onRequest, env, { path: "/api/beats" }),
    await call(booth.onRequest, env, { path: "/api/booth/tracks", params: { path: ["tracks"] } }),
  ];
  for (const p of probes) {
    assert.equal(p.status, 200);
    for (const secret of ["zelda", "quimby", "yolanda", "vance", "5550123", "entries/", "entry"]) assert.ok(!p.text.toLowerCase().includes(secret), `${secret} is not in ${p.text.slice(0, 80)}`);
  }
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM tracks").first()).n, 0, "no entry became a track");
  assert.deepEqual(computeTally([], [], {}), []);
  const exported = JSON.stringify(Object.keys(probes[0].body).sort());
  assert.equal(exported, JSON.stringify(["closed", "gate", "giphy", "now", "open", "photos", "tracks", "verification", "voting_ends_at", "voting_starts_at"]), "the shape of /api/state has not changed but for the start");
});

test("the entry tables are named only by the entry's own code, its migration, its script, the export, this test and the docs", () => {
  const found = {};
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git", ".wrangler", ".work", "exports"].includes(f.name)) continue;
      const p = path.join(dir, f.name);
      if (f.isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs|sql|md|html|toml)$/.test(f.name)) continue;
      const text = fs.readFileSync(p, "utf8");
      // "entries" is also an English word ("code entries 5 a minute"), so it counts only as a table in SQL.
      for (const [table, rx] of [["entry_uploads", /\bentry_uploads\b/], ["entry_members", /\bentry_members\b/], ["entries", /\b(?:FROM|INTO|UPDATE|JOIN|TABLE)\s+entries\b/]]) if (rx.test(text)) (found[table] ??= []).push(path.relative(ROOT, p));
    }
  };
  walk(ROOT);
  const own = ["CLAUDE.md", "RUNBOOK.md", "functions/_lib/entries.js", "functions/api/entries.js", "migrations/0007_entries.sql", "tests/entry.test.mjs"];
  assert.deepEqual(found.entry_members.sort(), [...own.filter((f) => f !== "functions/api/entries.js"), "scripts/export.mjs", "scripts/promote-entry.mjs"].sort(), "the people's table is read by the export and the promotion, and written through the lib's statement");
  for (const file of [...found.entries, ...found.entry_uploads, ...found.entry_members]) {
    assert.ok(!/^functions\/(api\/(state|beats|likes|comments|voters|me)|_lib\/(state|tally|beats|verify|token))|^functions\/api\/booth|^functions\/media|^public\//.test(file), `${file} is the vote's, the booth's or the page's: it has no business with the entries tables`);
  }
  const routes = [...src("functions/api/entries.js").matchAll(/(?:FROM|INTO|UPDATE|JOIN) ([a-z_]+)/g)].map((m) => m[1]);
  assert.ok(routes.every((t) => t.startsWith("entr")), "the entry route reads and writes entry tables only");
  assert.deepEqual([...new Set([...src("scripts/promote-entry.mjs").matchAll(/(?:FROM|INTO|UPDATE|JOIN) ([a-z_]+)/g)].map((m) => m[1]))].sort(), ["entries", "entry_members", "entry_uploads", "tracks"], "the promotion reads the entry's tables and writes the vote's tracks");
  assert.ok(!/(?:UPDATE|DELETE FROM|INSERT INTO) entr/.test(src("scripts/promote-entry.mjs")), "and never changes an entry row");
  assert.ok(!/ALLOWED = [^\n]*entries/.test(src("functions/media/[[path]].js")), "the media route does not take entries/");
});

test("no entry route answers a name, an email or a phone number: only the number, an id and an error", () => {
  const route = src("functions/api/entries.js") + src("functions/api/entries/upload.js");
  const answers = [...route.matchAll(/json\(([^;]*)\)/g)].map((m) => m[1].replace(/\s+/g, " "));
  assert.deepEqual(answers, ["{ entry: id }, 201", "{ upload_id: id, file_name: fileName, size }"]);
  assert.ok(!/SELECT[^"`]*(email|phone|first_name|last_name)/i.test(route), "neither route reads a person back");
  assert.ok(!/console\.(log|error|warn)\([^)]*(email|phone|first_name|body)/i.test(route), "and neither logs one");
});

// ── The promotion ────────────────────────────────────────────────────────────────────────────────
test("promote-entry: refuses Scooter Taylor, a test entry for production, an unknown entry and a missing agreement", () => {
  const entry = { id: 7, first_name: "Jane", last_name: "Doe", file_name: "Jane Doe.mp3", rules_agreed_at: 1760000000000 };
  assert.deepEqual(promoteVerdict({ entry, members: [], env: "production" }), { ok: true, reason: "agreed", message: "entry 7 agreed to the official rules" });
  assert.equal(promoteVerdict({}).reason, "no_such_entry");
  assert.equal(promoteVerdict({ entry: null }).reason, "no_such_entry");
  for (const name of [{ first_name: "Scooter", last_name: "Taylor" }, { first_name: "Taylor,", last_name: "Scooter" }, { first_name: "scooter", last_name: "TAYLOR" }, { first_name: "Scooter", last_name: "" }, { file_name: "Scooter Taylor.wav" }, { file_name: "scootertaylor.mp3" }]) {
    assert.equal(promoteVerdict({ entry: { ...entry, ...name }, members: [], env: "production" }).reason, "scooter_taylor", JSON.stringify(name));
    assert.equal(promoteVerdict({ entry: { ...entry, ...name }, members: [], env: "preview" }).reason, "scooter_taylor", "in preview too");
  }
  assert.equal(promoteVerdict({ entry, members: [{ first_name: "Scooter", last_name: "Taylor" }], env: "production" }).reason, "scooter_taylor", "a group he is in");
  assert.equal(promoteVerdict({ entry: { ...entry, first_name: "Scooter", last_name: "Braun" }, members: [], env: "production" }).ok, true, "a Scooter who is not Taylor is allowed, as in the loaders");
  assert.equal(promoteVerdict({ entry: { ...entry, file_name: "Test - Jane.mp3" }, members: [], env: "production" }).reason, "test_file_in_production");
  assert.equal(promoteVerdict({ entry: { ...entry, first_name: "Test", last_name: "Person" }, members: [], env: "production" }).reason, "test_file_in_production");
  assert.equal(promoteVerdict({ entry: { ...entry, file_name: "Test - Jane.mp3" }, members: [], env: "preview" }).ok, true, "a test entry is fine for preview");
  assert.equal(promoteVerdict({ entry: { ...entry, first_name: "Testimony" }, members: [], env: "production" }).ok, true, "Testimony is not a test");
  for (const missing of [null, 0, undefined]) assert.equal(promoteVerdict({ entry: { ...entry, rules_agreed_at: missing }, members: [], env: "production" }).reason, "rules_not_agreed");
  assert.equal(entryLabel({ first_name: "  Jane  " }), "Jane");
  assert.equal(entryLabel({}), "Entry");
});

test("promote-entry: the script is wired — named in the docs, in package.json, and its checks read the verdict", () => {
  assert.match(src("package.json"), /"promote-entry": "node scripts\/promote-entry\.mjs"/);
  assert.match(src("RUNBOOK.md"), /- `promote-entry`  -  `node scripts\/promote-entry\.mjs`/, "Porter may run it");
  const script = src("scripts/promote-entry.mjs");
  assert.match(script, /promoteVerdict\(\{ entry, members, env: args\.env \}\)/);
  assert.match(script, /if \(!verdict\.ok\) \{ refused\+\+; continue; \}/, "a refusal skips the entry before any bytes are fetched");
  assert.ok(script.indexOf("promoteVerdict(") < script.indexOf("r2Get(") && script.indexOf("r2Get(") < script.indexOf("INSERT INTO tracks"), "the verdict comes before the audio and the row");
  assert.match(script, /if \(promoted === 0 && refused > 0\) process\.exit\(1\)/, "a run that did nothing but refuse fails");
  assert.match(script, /no entries; there is nothing to promote/, "no entries is a named stop");
});

// ── The export ───────────────────────────────────────────────────────────────────────────────────
test("export: entries.csv and entry-members.csv carry the people, with the time the rules were agreed", () => {
  const at = Date.UTC(2026, 9, 10, 18, 30);
  const csv = entriesCsv([{ id: 3, first_name: "Jane", last_name: "Doe", city: "Atlanta", email: "jane@example.com", phone: "4045550100", instagram: "@janed", track_title: "The song", in_group: 1, rules_agreed_at: at, created_at: at, file_name: "Jane, the song.mp3" }]);
  assert.equal(csv.split("\n")[0], "entry,first_name,last_name,city,email,phone,instagram,track_title,in_group,rules_agreed_at,track_file,entered_at");
  assert.match(csv, /3,Jane,Doe,Atlanta,jane@example\.com,4045550100,'@janed,The song,yes,2026-10-10T18:30:00\.000Z,"Jane, the song\.mp3",2026-10-10T18:30:00\.000Z/);
  const members = entryMembersCsv([{ entry_id: 3, first_name: "Carlos", last_name: "Diaz", email: "c@example.com" }]);
  assert.equal(members.trim(), "entry,first_name,last_name,email\n3,Carlos,Diaz,c@example.com");
  const script = src("scripts/export.mjs");
  assert.match(script, /mode: 0o600/, "private files");
  assert.match(script, /no active tracks and no entries; there is nothing to export/, "nothing at all is still a named stop");
  assert.match(script, /tally is skipped; the entries are written/, "entries are exported before the first track exists");
});

// ── The page and its words ───────────────────────────────────────────────────────────────────────
test("the page: Scooter's words, the official rules at the top, the form's fields, and the box starts unticked", () => {
  const html = src("public/entry.html");
  assert.match(html, /<meta name="robots" content="noindex">/, "noindex while these are the working rules");
  assert.match(html, /<h1 class="slogan">JUMP IN THE BOOTH<\/h1>/);
  assert.ok(!/docs\.google\.com|authuser|usp=drivesdk|scooter%40|@/.test(html), "the page carries no Google link and no address of a person: the rules are on /rules");
  assert.ok(!/<p class="lede"><a/.test(html), "the rules link is no longer at the top; it is in the checkbox text");
  assert.match(html, /<label for="tbz-entry-agree" id="tbz-entry-agree-label"><\/label>/, "the box's label is filled from the copy, with the link");
  for (const id of ["first", "last", "city", "email", "phone", "instagram", "title", "group-yes", "group-no", "file", "agree", "website"]) assert.match(html, new RegExp(`id="tbz-entry-${id}"`), id);
  assert.match(html, /<input id="tbz-entry-email" type="email"/);
  assert.match(html, /<input id="tbz-entry-phone" type="tel"/);
  assert.match(html, /<input type="checkbox" id="tbz-entry-agree"/);
  assert.ok(!/id="tbz-entry-agree"[^>]*\bchecked\b/.test(html), "the box starts unticked");
  assert.match(html, /<button type="submit" id="tbz-entry-submit" class="btn btn-gate" disabled>/, "the button is off until the box is ticked");
  assert.match(html, /<div class="hp" aria-hidden="true"><label for="tbz-entry-website">Website<\/label><input id="tbz-entry-website" type="text" name="website" tabindex="-1" autocomplete="off">/, "the honeypot is hidden from people");
  assert.match(html, /accept="audio\/\*,\.wav,\.mp3,\.m4a,\.aif,\.aiff,\.flac"/);
  assert.ok(!/href="\/entry|entry\.js/.test(src("public/index.html")), "the voting page does not link to it");
  const js = src("public/js/entry.js");
  assert.match(js, /els\.submit\.disabled = busy \|\| !els\.agree\.checked;/, "it cannot be sent until the box is ticked");
  assert.match(js, /fetch\("\/api\/entries"/);
  assert.match(js, /xhr\.open\("POST", "\/api\/entries\/upload"\)/);
});

test("the words: the thank-you, the contest and the prize are Scooter's; the brand words are right; the start is in ET", () => {
  assert.equal(COPY.headline, "Thank you for jumping in the booth");
  assert.ok(COPY.thanks.join(" ").includes("It has been fun watching your recap videos and stories."));
  assert.ok(COPY.thanks.join(" ").includes("If you post a Top Barz recap on your feed, we are open to a collab post with you."));
  assert.ok(COPY.contest[0].includes("The song voted best from CultureCon wins the prize below."));
  assert.equal(COPY.contest[1], "Voting starts Sunday, October 11, at 10 AM ET.");
  assert.deepEqual(COPY.agree, { before: "I agree to the ", link: "official rules", href: "/rules", after: "" }, "\"I agree to the official rules\", with \"official rules\" linked to /rules");
  assert.equal(COPY.zone, "Upload your Top Barz song");
  assert.deepEqual(COPY.prize, ["2 (two) free hours of studio time", "1 (one) general admission ticket to CultureCon 2027"]);
  assert.equal(COPY.prizeNote, "Provided by Top Barz Inc.");
  assert.equal(COPY.winners.email, "info@topbarz.xyz");
  assert.ok(COPY.eligibility.join(" ").includes("Only tracks recorded at the Top Barz Studio Experience at CultureCon are eligible. Edited, re-recorded or any other tracks are not eligible."));
  assert.ok(COPY.eligibility.join(" ").includes("The file you upload must be the exact track that appears on the voting platform. Do not swap in another track or edit the uploaded file."));
  assert.ok(COPY.faq.length >= 5 && COPY.faq.every((f) => f.q.endsWith("?") && f.a), "the FAQ has questions and answers");
  assert.deepEqual(COPY.faq.slice(0, 4).map((f) => f.q), ["How long is the contest?", "What's the prize?", "Who can vote?", "What if we recorded in a group?"], "Scooter's four FAQ questions, in order");
  assert.equal(COPY.faq[3].a, "Please list everyone in the group.", "the group answer is his words");
  assert.ok(COPY.faq.every((f) => !f.link || f.link.href.startsWith("/")), "FAQ links stay on the site");
  assert.equal(COPY.groupLabel, "Did you record in a group?");
  for (const label of [COPY.firstName, COPY.lastName, COPY.city, COPY.email, COPY.phone]) assert.ok(label);
  const all = src("public/js/entry-copy.js") + src("public/entry.html") + src("public/js/entry.js") + src("public/js/entry-rules.js");
  assert.ok(!/spit\s+(your|ur|yo)\s+bars/i.test(all), 'never "spit your bars"');
  for (const m of all.replace(/topbarz\.xyz|topbarz-voting/g, "").matchAll(/top[\s_-]*barz/gi)) assert.equal(m[0], "Top Barz");
  for (const m of all.matchAll(/jump\s+in\s+the\s+booth/gi)) assert.equal(m[0], "JUMP IN THE BOOTH");
  assert.ok(!/\bPST\b|\bEST\b/.test(all), "Oct 11 is daylight time: ET, never EST");
  assert.ok(src("functions/_lib/config.js").includes('"2026-10-11T14:00:00Z"'), "10 AM ET on Oct 11 is 14:00 UTC");
  assert.equal(failureWords(COPY, { code: "entries_closed" }), COPY.closed);
  assert.equal(failureWords(COPY, { status: 429 }), COPY.rateLimited);
  assert.equal(failureWords(COPY, { code: "bad_email", message: "Enter an email address that works." }), "Enter an email address that works.");
  assert.equal(failureWords(COPY, {}), COPY.failed);
});

test("the device keeps nothing: no storage, no cookie, and the done screen shows the number and no one's details", () => {
  for (const file of ["entry.js", "entry-rules.js", "entry-copy.js"]) {
    const js = src(`public/js/${file}`);
    assert.ok(!/localStorage|sessionStorage|document\.cookie|indexedDB/.test(js), `${file}: nothing is kept on the device`);
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(js), `${file}: text only`);
  }
  const js = src("public/js/entry.js");
  const shown = [...js.matchAll(/\.textContent = [^;]*;/g)].map((m) => m[0]).filter((t) => /\.value|email|phone|first|last/i.test(t.replace(/COPY\.(firstName|lastName|email|phone|city)/g, "")));
  assert.deepEqual(shown, [], `no typed value is ever written back to the page: ${shown.join(" | ")}`);
  assert.match(js, /els\.doneText\.textContent = COPY\.doneEntry\.replace\("\{entry\}", String\(entry\)\);/);
  assert.ok(uploadIdOk(uploadId()) && entryKey("a".repeat(24), "mp3") === `entries/${"a".repeat(24)}.mp3`);
});
const uploadIdOk = (id) => isUploadId(id) && id.length === 24;

test("the rules page (/rules): the official rules in the site's own page, no draft notes, the Studio Experience rule in it", () => {
  const html = src("public/rules.html");
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /<h2 class="page-title">Official Rules<\/h2>/);
  assert.ok(html.includes("Only tracks recorded at the Top Barz Studio Experience at CultureCon are eligible: edited, re-recorded or any other tracks are not eligible."));
  assert.ok(html.includes("The uploaded file must be the exact track that appears on the voting platform"));
  assert.ok(html.includes("2 (two) free hours of studio time") && html.includes("provided by Top Barz Inc.") && html.includes("info@topbarz.xyz"));
  assert.ok(!/NOT FOR PUBLICATION|DRAFT|\[(?:OPEN|VERIFY|TOP BARZ|LEGAL|INSERT|Studio 404 comment)|docs\.google|authuser/.test(html), "no review notes, no private Google link");
  assert.ok(!/spit your bars/i.test(html));
});
