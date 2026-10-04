#!/usr/bin/env node
// The whole thing over HTTP, once: `wrangler pages dev` with a throwaway local D1 and R2. Proves
// what the handler tests cannot — that every route is wired where the front end will call it,
// that Range works through the real runtime, and that a like shows up in the polled state.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const WRANGLER = path.join(ROOT, "node_modules", ".bin", "wrangler");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbz-smoke-"));
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", CI: "1" };
const wr = (args) => execFileSync(WRANGLER, [...args, "--persist-to", dir], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

// Stand-ins for the two services the code email needs, so the real ones are never called: the
// mail service (POST /emails: keeps what it was sent) and the DNS resolver (GET /dns-query: every
// domain has an MX, except no-mail.example, which does not exist).
const mailbox = [];
const stub = http.createServer((req, res) => {
  const url = new URL(req.url, "http://stub");
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && url.pathname === "/emails") {
      mailbox.push({ auth: req.headers.authorization, ...JSON.parse(body) });
      res.end('{"id":"smoke"}');
    } else if (url.pathname === "/dns-query") {
      res.end(JSON.stringify(url.searchParams.get("name") === "no-mail.example" ? { Status: 3 } : { Status: 0, Answer: [{ type: 15, data: "10 mx.example.net." }] }));
    } else { res.statusCode = 404; res.end("{}"); }
  });
});

let passed = 0, server;
function ok(cond, what) {
  if (!cond) throw new Error(`FAILED: ${what}`);
  passed++;
  console.log(`  ok   ${what}`);
}

try {
  wr(["d1", "migrations", "apply", "topbarz-voting", "--local"]);
  const audio = path.join(dir, "smoke.mp3");
  fs.writeFileSync(audio, Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256)));
  wr(["r2", "object", "put", "topbarz-voting-media/tracks/smoke-0000000000.mp3", "--file", audio, "--content-type", "audio/mpeg", "--local"]);
  wr(["d1", "execute", "topbarz-voting", "--local", "--yes", "--command",
    "INSERT INTO tracks (slug, label, source_name, audio_key, duration_ms, sort, active, created_at, updated_at) VALUES ('smoke', 'Smoke', 'Smoke Test', 'tracks/smoke-0000000000.mp3', 1000, 10, 1, '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z')"]);

  // One beat for the select page, in its own table and its own folder of the bucket.
  wr(["r2", "object", "put", "topbarz-voting-media/beats/smoke-beat-0000000000.mp3", "--file", audio, "--content-type", "audio/mpeg", "--local"]);
  wr(["d1", "execute", "topbarz-voting", "--local", "--yes", "--command",
    "INSERT INTO beats (slug, name, source_name, audio_key, duration_ms, sort, active, stand_in, credit_label, credit_url, created_at, updated_at) VALUES ('smoke-beat', 'Smoke Beat', 'Smoke Beat File', 'beats/smoke-beat-0000000000.mp3', 2000, 10, 1, 0, 'Smoke Producer', 'https://example.com/producer', '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z')"]);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const stubBase = `http://127.0.0.1:${stub.address().port}`;
  // EMAIL_VERIFICATION comes from wrangler.toml, as in production; the mail key and the two
  // endpoints are the stand-ins above.
  const bindings = ["VOTER_TOKEN_SECRET=smoke-only-not-a-secret", "RESEND_API_KEY=smoke-only-not-a-key", `RESEND_ENDPOINT=${stubBase}/emails`, `DOH_ENDPOINT=${stubBase}/dns-query`].flatMap((b) => ["--binding", b]);
  server = spawn(WRANGLER, ["pages", "dev", "public", "--port", String(port), "--inspector-port", String(await freePort()), "--persist-to", dir, ...bindings, "--show-interactive-dev-session=false"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  const deadline = Date.now() + 90_000;
  for (;;) {
    try { if ((await fetch(`${base}/api/state`)).status === 200) break; } catch {}
    if (Date.now() > deadline || server.exitCode !== null) throw new Error(`the dev server did not come up:\n${log.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  const j = async (p, init) => { const r = await fetch(base + p, init); return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) }; };
  const post = (p, body, token) => j(p, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

  const page = await fetch(base + "/");
  const pageText = await page.text();
  ok(page.status === 200 && pageText.includes("JUMP IN THE BOOTH"), "GET / serves the page");
  ok((page.headers.get("content-security-policy") ?? "").includes("script-src 'self'"), "the page is served with its content security policy (public/_headers)");
  const assets = [...new Set([...pageText.matchAll(/(?:src|href)="(\/(?:js|css|img|fonts)\/[^"]+)"/g)].map((m) => m[1]))];
  const served = await Promise.all(assets.map(async (a) => { const r = await fetch(base + a); await r.arrayBuffer(); return r.status === 200 ? null : `${a} → ${r.status}`; }));
  ok(assets.length >= 12 && served.every((x) => x === null), `every file the page names is served (${assets.length} files${served.filter(Boolean).length ? `; missing: ${served.filter(Boolean).join(", ")}` : ""})`);
  const privacy = await fetch(base + "/privacy");
  ok(privacy.status === 200 && (await privacy.text()).includes("Privacy note"), "GET /privacy serves the privacy note");

  // The select page (/select) and its beats.
  const select = await fetch(base + "/select", { redirect: "manual" });
  const selectText = await select.text();
  ok(select.status === 200 && selectText.includes('id="tbz-beats-list"') && !selectText.includes('name="robots"'), "GET /select serves the select page, open to search (noindex came off with the real copy, 3 Oct 2026)");
  ok((select.headers.get("content-security-policy") ?? "").startsWith("default-src 'self'; script-src 'self'; style-src 'self'"), "/select is served with the same content security policy");
  for (const alias of ["/select/", "/select.html"]) {
    const hop = await fetch(base + alias, { redirect: "manual" });
    const landed = await fetch(base + alias);
    ok([301, 308].includes(hop.status) && new URL(hop.headers.get("location"), base).pathname === "/select" && landed.status === 200 && new URL(landed.url).pathname === "/select", `GET ${alias} ends up at /select`);
  }
  const selectAssets = [...new Set([...selectText.matchAll(/(?:src|href)="(\/(?:js|css|img|fonts)\/[^"]+)"/g)].map((m) => m[1]))];
  const selectServed = await Promise.all(selectAssets.map(async (a) => { const r = await fetch(base + a); await r.arrayBuffer(); return r.status === 200 ? null : `${a} → ${r.status}`; }));
  ok(selectAssets.length >= 10 && selectServed.every((x) => x === null), `every file /select names is served (${selectAssets.length} files${selectServed.filter(Boolean).length ? `; missing: ${selectServed.filter(Boolean).join(", ")}` : ""})`);
  ok(!/href="\/select|select\.js/.test(pageText), "the voting page does not link to /select");
  const beats = await j("/api/beats");
  ok(beats.status === 200 && JSON.stringify(beats.body) === JSON.stringify({ beats: [{ slug: "smoke-beat", name: "Smoke Beat", audio_url: "/media/beats/smoke-beat-0000000000.mp3", duration_ms: 2000, credit_label: "Smoke Producer", credit_url: "https://example.com/producer" }] }), "GET /api/beats lists the beat, with its credit");
  ok((await post("/api/beats", { pick: "smoke-beat" })).status === 405, "POST /api/beats is a 405: a pick is never sent to the server");
  const beatRange = await fetch(base + beats.body.beats[0].audio_url, { headers: { range: "bytes=0-1" } });
  ok(beatRange.status === 206 && beatRange.headers.get("content-range") === "bytes 0-1/4096" && beatRange.headers.get("content-type") === "audio/mpeg", "a beat's audio answers Range with 206, as a track's does");

  // The booth: the engineer's page, the rapper's page, the sign, and a real upload end to end.
  for (const [p, needle] of [["/booth", 'id="tbz-zone"'], ["/track", 'id="tbz-code"'], ["/track-qr", 'src="/img/track-qr.svg"']]) {
    const r = await fetch(base + p, { redirect: "manual" });
    const t = await r.text();
    const ids = [...t.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    ok(r.status === 200 && /text\/html/.test(r.headers.get("content-type")) && t.includes(needle), `GET ${p} serves its page`);
    ok((r.headers.get("content-security-policy") ?? "").startsWith("default-src 'self'; script-src 'self'; style-src 'self'") && !/<script(?![^>]*\bsrc=)[^>]*>|<style\b|\sstyle="/.test(t) && ids.length > 0 && ids.every((id) => id.startsWith("tbz-")), `${p}: the same policy, nothing inline, every id starts with tbz- (${ids.length} ids)`);
    const named = [...new Set([...t.matchAll(/(?:src|href)="(\/(?:js|css|img|fonts)\/[^"]+)"/g)].map((m) => m[1]))];
    const missing = (await Promise.all(named.map(async (a) => { const x = await fetch(base + a); await x.arrayBuffer(); return x.status === 200 ? null : `${a} → ${x.status}`; }))).filter(Boolean);
    ok(named.length >= 6 && missing.length === 0, `every file ${p} names is served (${named.length} files${missing.length ? `; missing: ${missing.join(", ")}` : ""})`);
  }
  for (const alias of ["/track/", "/track.html"]) {
    const hop = await fetch(base + alias, { redirect: "manual" });
    const landed = await fetch(base + alias);
    ok([301, 308].includes(hop.status) && new URL(hop.headers.get("location"), base).pathname === "/track" && landed.status === 200 && new URL(landed.url).pathname === "/track", `GET ${alias} ends up at /track`);
  }
  ok(!/href="\/(?:booth|track)|booth\.js|track\.js/.test(pageText) && !/href="\/(?:booth|track)|booth\.js|track\.js/.test(selectText), "neither the voting page nor the select page links to the booth");
  // Each check speaks from its own address (local dev keeps a cf-connecting-ip the client sends),
  // so the lookup limit (5 a minute per address) is proven on purpose below, not tripped by accident.
  let addr = 20;
  const look = (code, ip = `203.0.113.${addr++}`) => j(`/api/booth/tracks/${code}`, { headers: { "cf-connecting-ip": ip } });
  const sendFile = (name, bytes, type) => fetch(base + "/api/booth/tracks", { method: "POST", headers: { "x-file-name": encodeURIComponent(name), "content-type": type, "content-length": String(bytes.length), "cf-connecting-ip": "203.0.113.9" }, body: bytes }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  // A small WAV made here: a RIFF header, then a second of silence.
  const wavBytes = Buffer.alloc(44 + 8000);
  wavBytes.write("RIFF", 0); wavBytes.writeUInt32LE(36 + 8000, 4); wavBytes.write("WAVEfmt ", 8); wavBytes.writeUInt32LE(16, 16); wavBytes.writeUInt16LE(1, 20); wavBytes.writeUInt16LE(1, 22);
  wavBytes.writeUInt32LE(8000, 24); wavBytes.writeUInt32LE(8000, 28); wavBytes.writeUInt16LE(1, 32); wavBytes.writeUInt16LE(8, 34); wavBytes.write("data", 36); wavBytes.writeUInt32LE(8000, 40);
  const up = await sendFile("Smoke Take 1.wav", wavBytes, "audio/wav");
  ok(up.status === 200 && /^\d{4}$/.test(up.body?.code ?? "") && up.body.file_name === "Smoke Take 1.wav" && Object.keys(up.body).join() === "code,file_name,uploaded_at", `POST /api/booth/tracks takes a generated WAV and answers a 4-digit code (${up.body?.code})`);
  const found = await look(up.body.code);
  ok(found.status === 200 && found.body.file_name === "Smoke Take 1.wav" && found.body.size === wavBytes.length && /^\/media\/booth\/\d{4}-[0-9a-f]{16}\.wav$/.test(found.body.audio_url) && found.body.download_url === `${found.body.audio_url}?dl=1`, "GET /api/booth/tracks/<code> finds it, with its audio and download addresses");
  const dl = await fetch(base + found.body.download_url);
  ok(dl.status === 200 && dl.headers.get("content-disposition") === 'attachment; filename="Smoke Take 1.wav"' && dl.headers.get("content-length") === String(wavBytes.length) && dl.headers.get("content-type") === "audio/wav" && (await dl.arrayBuffer()).byteLength === wavBytes.length, "the download address sends the whole file as an attachment under its name");
  const playing = await fetch(base + found.body.audio_url, { headers: { range: "bytes=0-3" } });
  ok(playing.status === 206 && playing.headers.get("content-range") === `bytes 0-3/${wavBytes.length}` && Buffer.from(await playing.arrayBuffer()).toString() === "RIFF" && playing.headers.get("content-disposition") === null, "the audio address answers Range with 206 and plays inline");

  // The real sample songs: the four MP3s in the Drive package's "Test tracks" folder (no media is
  // ever committed: tests/loaders.test.mjs pins that). On a machine where the folder is missing
  // this fails loudly, naming it. On GitHub Actions, where no Drive package can exist, the same
  // four names go up at their real byte sizes with made-up bytes (the server never decodes audio),
  // and the check's own line says so. Never a silent skip.
  const testTracks = path.join(os.homedir(), "topbarz-source", "drive", "Test tracks");
  const SAMPLE_SONGS = { "Test - Brian.mp3": 2602688, "Test - Caleb.mp3": 2865728, "Test - Carlos & Damien.mp3": 2735168, "Test - Chelos x Madame Prez x Cam.mp3": 2865728 };
  let songs, songSource;
  if (fs.existsSync(testTracks)) {
    const names = fs.readdirSync(testTracks).filter((f) => f.endsWith(".mp3")).sort();
    const absent = Object.keys(SAMPLE_SONGS).filter((n) => !names.includes(n));
    if (absent.length) throw new Error(`FAILED: ${testTracks} is missing the sample song(s) ${absent.join(", ")}; run npm run sync-drive`);
    songs = names.map((n) => [n, fs.readFileSync(path.join(testTracks, n))]);
    songSource = `the real files from ${testTracks}`;
  } else if (process.env.GITHUB_ACTIONS === "true") {
    songs = Object.entries(SAMPLE_SONGS).map(([n, size]) => [n, Buffer.alloc(size, 0x5a)]);
    songSource = "the four real names at their real sizes with stand-in bytes: GitHub Actions has no Drive package";
  } else {
    throw new Error(`FAILED: the sample songs are not on this machine: there is no ${testTracks}. Run npm run sync-drive (the Drive package), then npm run check again.`);
  }
  let realUploads = 0;
  let lastCode = null;
  for (const [name, bytes] of songs) {
    const r = await sendFile(name, bytes, "audio/mpeg");
    if (r.status !== 200) throw new Error(`FAILED: uploading ${name} (${bytes.length} bytes) answered ${r.status} ${JSON.stringify(r.body)}`);
    const f = await look(r.body.code);
    lastCode = r.body.code;
    const d = await fetch(base + f.body.download_url, { headers: { range: "bytes=0-1" } });
    await d.arrayBuffer();
    const whole = await fetch(base + f.body.download_url, { method: "HEAD" });
    const audio = await fetch(base + f.body.audio_url, { headers: { range: "bytes=0-1" } });
    await audio.arrayBuffer();
    ok(r.body.file_name === name && f.status === 200 && f.body.file_name === name && f.body.size === bytes.length && whole.status === 200 && whole.headers.get("content-length") === String(bytes.length) && whole.headers.get("content-disposition") === `attachment; filename="${name}"` && d.status === 206 && audio.status === 206 && audio.headers.get("content-range") === `bytes 0-1/${bytes.length}`, `the real song "${name}" (${bytes.length} bytes) goes up, is found by code ${r.body.code}, downloads under its own name at full length, and plays by Range`);
    realUploads++;
  }
  ok(realUploads === 4 && songs.length === 4, `the four sample songs went up: ${songSource}`);
  const logRes = await j("/api/booth/tracks");
  ok(logRes.status === 200 && logRes.body.tracks.length === 1 + realUploads && logRes.body.tracks[0].code === lastCode && logRes.body.tracks.at(-1).code === up.body.code && logRes.body.tracks.every((t) => /^\d{4}$/.test(t.code) && t.opened === 1 && !("media_key" in t)), `GET /api/booth/tracks lists the ${1 + realUploads} uploads, newest first, each opened once, no key`);
  const wrongCode = up.body.code === "0000" ? "0001" : "0000";
  const none = await look(wrongCode);
  ok(none.status === 404 && none.body.error === "not_found", "a wrong code is a 404 not_found");
  const notAudio = await sendFile("notes.txt", Buffer.from("hello"), "text/plain");
  ok(notAudio.status === 415 && notAudio.body.error === "not_audio", "a text file is refused (415 not_audio)");
  // Lookups: 5 a minute per address. One fresh address, six wrong tries: five 404s, then the 429.
  // (The minute is a fixed window; if it is about to roll over, wait for the next one first.)
  const slack = 60_000 - (Date.now() % 60_000);
  if (slack < 5_000) await new Promise((r) => setTimeout(r, slack + 200));
  const tries = [];
  for (let i = 0; i < 6; i++) tries.push((await look(wrongCode, "203.0.113.200")).status);
  ok(tries.join() === "404,404,404,404,404,429", `code lookups are rate limited: the 6th wrong try in a minute is a 429 (${tries.join(",")})`);
  const limited = await look(wrongCode, "203.0.113.200");
  ok(limited.status === 429 && limited.body.error === "rate_limited" && /Give it a minute/.test(limited.body.message), "and it stays shut for the minute, with a message to show");

  const s1 = await j("/api/state");
  ok(s1.status === 200 && s1.body.tracks.length === 1 && s1.body.tracks[0].slug === "smoke" && s1.body.tracks[0].likes === 0, "GET /api/state lists the track with 0 likes");
  ok(!/beat/i.test(JSON.stringify(s1.body)) && Object.keys(s1.body).sort().join() === "closed,gate,giphy,now,photos,tracks,verification,voting_ends_at", "the beat is not in /api/state, whose shape has not changed");
  ok(s1.body.closed === false && s1.body.voting_ends_at === "2026-10-12T06:59:00.000Z", "state carries the end time and closed=false");
  ok(s1.body.giphy.available === false && s1.body.giphy.reason === "no_key" && s1.body.gate.available === true, "state names the GIF picker as off (no key) and the gate as on");
  ok(Array.isArray(s1.body.photos) && s1.body.photos.length === 0, "no photos = empty manifest");
  ok(s1.body.verification?.available === true, "state says email codes are on (the switch in wrangler.toml, plus a mail key)");
  ok(/<input id="tbz-gate-code"[^>]*inputmode="numeric"[^>]*autocomplete="one-time-code"/.test(pageText), "the page's gate has the code field");

  const nf = await j("/api/does-not-exist");
  ok(nf.status === 404 && nf.body?.error === "not_found", "an unknown /api path is a JSON 404, not the HTML page");
  ok((await j("/api/voters")).status === 405, "GET /api/voters is a 405");

  // The gate with email codes on: no token until the emailed code comes back.
  const tokenIn = (r) => /v1\.\d+\.[A-Za-z0-9_-]{43}/.test(JSON.stringify(r.body));
  const dead = await post("/api/voters", { name: "No Mail", email: "someone@no-mail.example", city: "Brooklyn" });
  ok(dead.status === 400 && dead.body.error === "undeliverable_email" && mailbox.length === 0, "a domain that cannot receive mail is refused, and nothing is sent");
  const asked = await post("/api/voters", { name: "Smoke Tester", email: "Smoke.Tester@Example.com ", city: "Brooklyn" });
  ok(asked.status === 200 && asked.body.verification === "code_sent" && asked.body.sent === true && asked.body.resend_in_seconds === 60 && asked.body.expires_in_seconds === 600 && !tokenIn(asked), "POST /api/voters emails a code and returns NO token");
  const mail = mailbox[0] ?? {};
  const code = /^([0-9]{6}) is your Top Barz voting code$/.exec(mail.subject ?? "")?.[1];
  ok(mailbox.length === 1 && code && mail.to?.[0] === "smoke.tester@example.com" && mail.from === "Top Barz Voting <topbarz@joinwestpeek.com>" && mail.text.includes(code) && mail.html.includes(code) && mail.auth === "Bearer smoke-only-not-a-key", "one email went to the mail service: the code, from Top Barz Voting, to that address");
  const again = await post("/api/voters", { name: "Smoke Tester", email: "smoke.tester@example.com", city: "Brooklyn" });
  ok(again.status === 200 && again.body.sent === false && again.body.resend_in_seconds > 0 && mailbox.length === 1 && !tokenIn(again), "asking again inside the cooldown sends nothing and returns no token");
  const wrong = await post("/api/voters/verify", { email: "smoke.tester@example.com", code: code === "000000" ? "000001" : "000000" });
  ok(wrong.status === 400 && wrong.body.error === "wrong_code" && wrong.body.tries_left === 4 && !tokenIn(wrong), "POST /api/voters/verify refuses a wrong code and says the tries left");
  const gate = await post("/api/voters/verify", { email: "smoke.tester@example.com", code });
  ok(gate.status === 200 && gate.body.verification === "verified" && /^v1\.\d+\./.test(gate.body.token) && gate.body.voter.first_name === "Smoke", "the right code returns a signed token and a first name");
  const token = gate.body.token;
  ok((await post("/api/likes", { track: "smoke" })).status === 401, "POST /api/likes without a token is a 401");
  const like = await post("/api/likes", { track: "smoke" }, token);
  ok(like.status === 200 && like.body.liked === true && like.body.likes === 1, "POST /api/likes likes the track");
  const mine = await j("/api/me", { headers: { authorization: `Bearer ${token}` } });
  ok(mine.status === 200 && mine.body.liked.join() === "smoke", "GET /api/me returns the voter's likes");

  const c = await post("/api/comments", { track: "smoke", text: "smoke comment" }, token);
  ok(c.status === 201 && c.body.comment.first_name === "Smoke", "POST /api/comments stores a comment under the first name");
  const list = await j("/api/comments?track=smoke");
  ok(list.status === 200 && list.body.total === 1 && !JSON.stringify(list.body).includes("@"), "GET /api/comments returns it, with no email");

  let s2;
  const until = Date.now() + 15_000;
  do { await new Promise((r) => setTimeout(r, 1000)); s2 = await j("/api/state"); } while (s2.body.tracks[0].likes !== 1 && Date.now() < until);
  ok(s2.body.tracks[0].likes === 1 && s2.body.tracks[0].comments === 1, "the like and the comment reach the polled state within seconds");
  const s3 = await j("/api/state");
  ok(["memory", "edge"].includes(s3.headers.get("x-state-cache")), `a second poll is served from cache (${s3.headers.get("x-state-cache")})`);

  const tr = await j("/api/giphy/trending");
  ok(tr.status === 200 && tr.body.available === false, "GET /api/giphy/trending says the picker is unavailable");
  const se = await j("/api/giphy/search?q=fire");
  ok(se.status === 200 && se.body.available === false, "GET /api/giphy/search says the same");

  const range = await fetch(base + s1.body.tracks[0].audio_url, { headers: { range: "bytes=0-1" } });
  ok(range.status === 206 && range.headers.get("content-range") === "bytes 0-1/4096" && (await range.arrayBuffer()).byteLength === 2, "media answers Range with 206 (iOS Safari audio)");
  const whole = await fetch(base + s1.body.tracks[0].audio_url);
  ok(whole.status === 200 && whole.headers.get("accept-ranges") === "bytes" && /immutable/.test(whole.headers.get("cache-control")) && whole.headers.get("content-type") === "audio/mpeg", "media is served whole with a long cache");
  ok((await fetch(base + "/media/manifest/photos.json")).status === 404, "the manifest is not reachable under /media");

  if (passed < 60) throw new Error(`only ${passed} checks ran`);
  console.log(`smoke: ${passed} checks passed`);
} catch (err) {
  console.error(String(err.message ?? err));
  process.exitCode = 1;
} finally {
  server?.kill("SIGTERM");
  stub.close();
  setTimeout(() => { server?.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }); process.exit(process.exitCode ?? 0); }, 1500);
}
