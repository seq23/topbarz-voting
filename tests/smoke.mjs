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

let passed = 0, server, log = "";
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
  const bindings = ["VOTER_TOKEN_SECRET=smoke-only-not-a-secret", "VOTING_STARTS_AT=2020-01-01T00:00:00Z", "RESEND_API_KEY=smoke-only-not-a-key", `RESEND_ENDPOINT=${stubBase}/emails`, `DOH_ENDPOINT=${stubBase}/dns-query`].flatMap((b) => ["--binding", b]);
  // The dev server, startable more than once: the promote steps below run a second wrangler
  // against the same local D1 and R2, which is not safe while this one is serving them (on
  // Linux the server dies and the next fetch fails), so the server is stopped around them.
  const startServer = async () => {
    server = spawn(WRANGLER, ["pages", "dev", "public", "--port", String(port), "--inspector-port", String(await freePort()), "--persist-to", dir, ...bindings, "--show-interactive-dev-session=false"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", (d) => { log += d; });
    server.stderr.on("data", (d) => { log += d; });
    const deadline = Date.now() + 90_000;
    for (;;) {
      try { if ((await fetch(`${base}/api/state`)).status === 200) break; } catch {}
      if (Date.now() > deadline || server.exitCode !== null) throw new Error(`the dev server did not come up:\n${log.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  const stopServer = async () => {
    if (!server || server.exitCode !== null) return;
    const gone = new Promise((r) => server.once("exit", r));
    server.kill("SIGTERM");
    await Promise.race([gone, new Promise((r) => setTimeout(r, 10_000))]);
    if (server.exitCode === null) { server.kill("SIGKILL"); await gone; }
  };
  await startServer();
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
  for (const [p, needle] of [["/booth", 'id="tbz-zone"'], ["/track", 'id="tbz-code"'], ["/track-qr", 'src="/img/track-qr.svg"'], ["/listen/0123456789abcdef", 'id="tbz-listen-art"'], ["/listen/anything-at-all", 'id="tbz-listen-private"'], ["/listen", 'id="tbz-listen-ig"']]) {
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
  // The way in since 4 Oct 2026: the code WITH an email (POST …/enter); `look` is that with one default email.
  const ME = "artist@example.com";
  const enter = (code, email = ME, ip = `203.0.113.${addr++}`) => j(`/api/booth/tracks/${code}/enter`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify({ email }) });
  const look = (code, ip) => enter(code, ME, ip);
  const sendFile = (name, bytes, type) => fetch(base + "/api/booth/tracks", { method: "POST", headers: { "x-file-name": encodeURIComponent(name), "content-type": type, "content-length": String(bytes.length), "cf-connecting-ip": "203.0.113.9" }, body: bytes }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  // A small WAV made here: a RIFF header, then a second of silence.
  const wavBytes = Buffer.alloc(44 + 8000);
  wavBytes.write("RIFF", 0); wavBytes.writeUInt32LE(36 + 8000, 4); wavBytes.write("WAVEfmt ", 8); wavBytes.writeUInt32LE(16, 16); wavBytes.writeUInt16LE(1, 20); wavBytes.writeUInt16LE(1, 22);
  wavBytes.writeUInt32LE(8000, 24); wavBytes.writeUInt32LE(8000, 28); wavBytes.writeUInt16LE(1, 32); wavBytes.writeUInt16LE(8, 34); wavBytes.write("data", 36); wavBytes.writeUInt32LE(8000, 40);
  const up = await sendFile("Smoke Take 1.wav", wavBytes, "audio/wav");
  ok(up.status === 200 && /^\d{4}$/.test(up.body?.code ?? "") && up.body.file_name === "Smoke Take 1.wav" && Object.keys(up.body).join() === "code,file_name,uploaded_at", `POST /api/booth/tracks takes a generated WAV and answers a 4-digit code (${up.body?.code})`);
  const found = await look(up.body.code);
  ok(found.status === 200 && found.body.file_name === "Smoke Take 1.wav" && found.body.size === wavBytes.length && /^\/media\/booth\/\d{4}-[0-9a-f]{16}\.wav$/.test(found.body.audio_url) && found.body.download_url === `${found.body.audio_url}?dl=1`, "POST /api/booth/tracks/<code>/enter with an email finds it, with its audio and download addresses");
  ok(JSON.stringify(found.body.you) === JSON.stringify({ email: ME, vote_opt_in: false }) && found.body.people === 1 && found.body.opted === 0 && found.body.everyone_in === false, "and answers this person's own state: attached, out, the only one so far");
  const oldGet = await j(`/api/booth/tracks/${up.body.code}`, { headers: { "cf-connecting-ip": "203.0.113.19" } });
  ok([404, 405].includes(oldGet.status) && !("audio_url" in (oldGet.body ?? {})), `the old GET /api/booth/tracks/<code> lookup is gone (${oldGet.status}): no track without an email`);
  const badEmail = await enter(up.body.code, "not-an-email");
  ok(badEmail.status === 400 && badEmail.body.error === "bad_email", "a bad email is a 400 bad_email");
  const noEmail = await j(`/api/booth/tracks/${up.body.code}/enter`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": `203.0.113.${addr++}` }, body: "{}" });
  ok(noEmail.status === 400 && noEmail.body.error === "bad_email", "and so is no email at all");
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
  ok(none.status === 404 && none.body.error === "not_found", "a wrong code with an email is a 404 not_found");
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

  // The people (4 Oct 2026): a second email on the same code, each person's own vote switch, and
  // the rule that everyone_in needs every one of them.
  const OTHER = "friend@example.com";
  const voteAs = (code, email, optIn, ip = `203.0.113.${addr++}`) => j(`/api/booth/tracks/${code}/vote`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify({ email, opt_in: optIn }) });
  const second = await enter(up.body.code, OTHER);
  ok(second.status === 200 && second.body.people === 2 && second.body.everyone_in === false && second.body.you.email === OTHER && !JSON.stringify(second.body).includes(ME), "a second email, the same code: 2 people, not everyone in, and the first person's email is not in the answer");
  const mineIn = await voteAs(up.body.code, ME, true);
  ok(mineIn.status === 200 && mineIn.body.you.vote_opt_in === true && mineIn.body.opted === 1 && mineIn.body.everyone_in === false, "POST /api/booth/tracks/<code>/vote: one in of two is not everyone");
  const bothIn = await voteAs(up.body.code, OTHER, true);
  ok(bothIn.status === 200 && bothIn.body.opted === 2 && bothIn.body.everyone_in === true && (await look(up.body.code)).body.everyone_in === true, "both in: everyone_in, on the vote's answer and the next entry");
  ok((await voteAs(up.body.code, "stranger@example.com", true)).status === 403, "a stranger's vote is a 403");

  // The share (4 Oct 2026): the switch (anyone attached), the listen page's read, the artwork, all through HTTP.
  const flip = (code, pub, ip = `203.0.113.${addr++}`, email = ME) => j(`/api/booth/tracks/${code}/public`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify({ email, public: pub }) });
  const hear = (id, ip = `203.0.113.${addr++}`) => j(`/api/booth/listen/${id}`, { headers: { "cf-connecting-ip": ip } });
  const fresh = await look(up.body.code);
  ok(fresh.status === 200 && fresh.body.public === false && fresh.body.share_id === null && fresh.body.art_url === null && Object.keys(fresh.body).join() === "code,file_name,audio_url,download_url,size,uploaded_at,public,share_id,art_url,you,people,opted,everyone_in", "the entry carries the share state: private, no link, no artwork, until someone attached says otherwise");
  const stranger = await flip(up.body.code, true, undefined, "stranger@example.com");
  ok(stranger.status === 403 && stranger.body.error === "not_attached" && (await look(up.body.code)).body.public === false, "the switch answers 403 not_attached to an email that never entered the code, and nothing flips");
  const on = await flip(up.body.code, true, undefined, OTHER);
  ok(on.status === 200, "any attached person may flip it: share is anyone's call");
  ok(on.status === 200 && on.body.public === true && /^[0-9a-f]{16}$/.test(on.body.share_id ?? "") && on.body.share_id !== up.body.code && Object.keys(on.body).join() === "code,public,share_id", `POST /api/booth/tracks/<code>/public switches the track on and hands out a 16-character share id (${on.body.share_id})`);
  const shareId = on.body.share_id;
  ok((await look(up.body.code)).body.share_id === shareId, "the next lookup says public, with the same id");
  const heard = await hear(shareId);
  ok(heard.status === 200 && heard.body.file_name === "Smoke Take 1.wav" && heard.body.audio_url === found.body.audio_url && heard.body.art_url === null && Object.keys(heard.body).join() === "file_name,audio_url,art_url", "GET /api/booth/listen/<share_id> answers a public track's name and audio, nothing else");
  const openedBefore = (await j("/api/booth/tracks")).body.tracks.find((t) => t.code === up.body.code).opened;
  await hear(shareId); await hear(shareId);
  ok((await j("/api/booth/tracks")).body.tracks.find((t) => t.code === up.body.code).opened === openedBefore, "listening never counts as an open");
  const unknownId = shareId.replace(/./g, (c) => (c === "0" ? "1" : "0"));
  const nobody = await hear(unknownId);
  ok(nobody.status === 404 && nobody.body.error === "not_found" && nobody.body.message === "Sorry, this song is private.", "an unknown share id is a 404 not_found that says private");
  const off = await flip(up.body.code, false);
  const quiet = await hear(shareId);
  ok(off.status === 200 && off.body.public === false && off.body.share_id === null && quiet.status === 404 && quiet.body.error === "private" && quiet.body.message === nobody.body.message && Object.keys(quiet.body).join() === Object.keys(nobody.body).join(), "switched off: the same 404 as an unknown id (code private), the same words, the same shape");
  ok((await look(up.body.code)).body.public === false, "and the lookup says private again");
  ok((await flip(wrongCode, true, "203.0.113.201")).status === 404, "a wrong code on the switch is a 404");
  // Artwork: the smallest JPEG by its first bytes (the server never decodes a picture), raw.
  const art = Buffer.alloc(700, 0x5c); art.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00], 0); art.set([0xff, 0xd9], 698);
  const sendArt = (code, bytes, type, ip = `203.0.113.${addr++}`, email = ME) => fetch(base + `/api/booth/tracks/${code}/art`, { method: "POST", headers: { "content-type": type, "content-length": String(bytes.length), "cf-connecting-ip": ip, ...(email === null ? {} : { "x-email": email }) }, body: bytes }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const noOne = await sendArt(up.body.code, art, "image/jpeg", undefined, null);
  ok(noOne.status === 403 && noOne.body.error === "not_attached", "artwork without an x-email is a 403 not_attached");
  const put = await sendArt(up.body.code, art, "image/jpeg");
  ok(put.status === 200 && /^\/media\/booth\/art\/[0-9a-f]{16}-[0-9a-f]{10}\.jpg$/.test(put.body?.art_url ?? "") && !put.body.art_url.includes(up.body.code) && Object.keys(put.body).join() === "code,art_url", `POST /api/booth/tracks/<code>/art takes a generated JPEG and answers its address (${put.body?.art_url})`);
  const pic = await fetch(base + put.body.art_url);
  const picBytes = Buffer.from(await pic.arrayBuffer());
  ok(pic.status === 200 && pic.headers.get("content-type") === "image/jpeg" && /immutable/.test(pic.headers.get("cache-control")) && pic.headers.get("content-disposition") === null && picBytes.length === 700 && picBytes.equals(art), "the media route serves the artwork, cached a year, never as a download");
  ok((await look(up.body.code)).body.art_url === put.body.art_url, "the lookup shows the artwork");
  await flip(up.body.code, true);
  ok((await hear(shareId)).body.art_url === put.body.art_url, "and so does the listen page's read, once the track is public again");
  const fake = await sendArt(up.body.code, Buffer.from("GIF89a not a jpeg at all, no matter the type"), "image/jpeg");
  ok(fake.status === 415 && fake.body.error === "not_image", "bytes that are not a JPEG are refused whatever the type says (415 not_image)");
  const logNow = (await j("/api/booth/tracks")).body.tracks;
  const myRow = logNow.find((t) => t.code === up.body.code);
  ok(myRow && myRow.public === true && myRow.art_url === put.body.art_url && logNow.every((t) => typeof t.public === "boolean" && "art_url" in t && !("share_id" in t) && !("art_key" in t)), "GET /api/booth/tracks says which tracks are public and which have artwork, never a share id or a key");
  ok(myRow.people === 2 && myRow.everyone_in === true && logNow.every((t) => Number.isInteger(t.people) && typeof t.everyone_in === "boolean") && !JSON.stringify(logNow).includes("@"), "and how many people each has and whether all are in: counts, never an email (no \"@\" in the whole log)");
  const heardAgain = await hear(shareId);
  ok(Object.keys(heardAgain.body).join() === "file_name,audio_url,art_url" && !JSON.stringify(heardAgain.body).includes("@"), "the listen page's read is unchanged: no email, no people");

  const s1 = await j("/api/state");
  ok(s1.status === 200 && s1.body.tracks.length === 1 && s1.body.tracks[0].slug === "smoke" && s1.body.tracks[0].likes === 0, "GET /api/state lists the track with 0 likes");
  ok(!/beat/i.test(JSON.stringify(s1.body)) && Object.keys(s1.body).sort().join() === "closed,gate,giphy,now,open,photos,tracks,verification,voting_ends_at,voting_starts_at", "the beat is not in /api/state, whose shape has not changed");
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

  // The only door onto the voting site: npm run promote-booth, against this same throwaway D1 and
  // R2 (TBZ_PERSIST_TO points the script's wrangler at it). A track with someone still out is
  // refused, non-zero; the smoke track, with both in, is promoted, and then it is in /api/state.
  const promote = (...args) => {
    try { return { status: 0, out: execFileSync(process.execPath, [path.join(ROOT, "scripts/promote-booth.mjs"), ...args], { cwd: ROOT, env: { ...env, TBZ_PERSIST_TO: dir }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
    catch (e) { return { status: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }; }
  };
  await stopServer();
  const refused = promote("--env", "local", "--code", lastCode);
  ok(refused.status === 1 && /REFUSED: 1 of the 1 people attached to code \d{4} has not opted in/.test(refused.out), `promote-booth refuses a track whose one person is out, exit ${refused.status}`);
  const unknown = promote("--env", "local", "--code", wrongCode);
  ok(unknown.status === 1 && /REFUSED: no booth track has that code/.test(unknown.out), "and an unknown code");
  const dry = promote("--env", "local", "--code", up.body.code, "--dry-run");
  await startServer();
  ok(dry.status === 0 && /ALLOWED \(everyone_in\): all 2 people attached/.test(dry.out) && /dry run: would add smoke-take-1  "Smoke Take 1"/.test(dry.out) && (await j("/api/state")).body.tracks.length === 1, "a dry run says everyone is in and what it would add, and adds nothing");
  await stopServer();
  const done = promote("--env", "local", "--code", up.body.code, "--label", "Smoke Group");
  await startServer();
  ok(done.status === 0 && /promoted  smoke-group  "Smoke Group"  1\.0 s  → topbarz-voting-media\/tracks\/smoke-group-[0-9a-f]{10}\.wav/.test(done.out) && /The deep link: http:\/\/localhost:8788\/#smoke-group/.test(done.out), `promote-booth copies the audio under tracks/ and adds the vote track (exit ${done.status}): ${done.out.trim().split("\n").slice(-3).join(" | ")}`);
  let s4;
  const promotedBy = Date.now() + 8_000;
  do { await new Promise((r) => setTimeout(r, 1000)); s4 = await j("/api/state"); } while (!s4.body.tracks.some((t) => t.slug === "smoke-group") && Date.now() < promotedBy);
  const promoted = s4.body.tracks.find((t) => t.slug === "smoke-group");
  ok(promoted && promoted.label === "Smoke Group" && promoted.duration_ms === 1000 && /^\/media\/tracks\/smoke-group-[0-9a-f]{10}\.wav$/.test(promoted.audio_url) && s4.body.tracks.length === 2, "the promoted track is in /api/state beside the seeded one, with its label and duration");
  const promotedAudio = await fetch(base + promoted.audio_url, { headers: { range: "bytes=0-3" } });
  ok(promotedAudio.status === 206 && Buffer.from(await promotedAudio.arrayBuffer()).toString() === "RIFF" && promotedAudio.headers.get("content-type") === "audio/wav", "and its audio plays by Range from tracks/");
  ok((await look(up.body.code)).status === 200 && (await j("/api/booth/tracks")).body.tracks.find((t) => t.code === up.body.code).everyone_in === true, "the booth row is untouched");
  ok(!JSON.stringify(s4.body).includes("@") && !/booth/.test(JSON.stringify(s4.body)), "nothing of the people and nothing of the booth is in /api/state");


  // The contest entry (9 Oct 2026): the page, its two addresses, a real two-step entry over HTTP
  // (the raw upload streams into R2 through the real runtime), the refusals, and the only door
  // onto the vote, npm run promote-entry, against this same throwaway D1 and R2.
  const entryPage = await fetch(base + "/entry", { redirect: "manual" });
  const entryText = await entryPage.text();
  const entryIds = [...entryText.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  ok(entryPage.status === 200 && entryText.includes('id="tbz-entry-form"') && entryText.includes('name="robots" content="noindex"') && entryIds.every((id) => id.startsWith("tbz-")), `GET /entry serves the entry page, noindex (${entryIds.length} ids)`);
  ok((entryPage.headers.get("content-security-policy") ?? "").startsWith("default-src 'self'; script-src 'self'; style-src 'self'") && !/<script(?![^>]*\bsrc=)[^>]*>|<style\b|\sstyle="/.test(entryText), "/entry is served with the same content security policy, nothing inline");
  ok(!/docs\.google|authuser/.test(entryText), "/entry carries no private Google link: the checkbox links /rules");
  const rulesPage = await fetch(base + "/rules", { redirect: "manual" });
  const rulesText = await rulesPage.text();
  ok(rulesPage.status === 200 && rulesText.includes("Official Rules") && rulesText.includes("exact track that appears on the voting platform"), "GET /rules serves the official rules");
  const entryAssets = [...new Set([...entryText.matchAll(/(?:src|href)="(\/(?:js|css|img|fonts)\/[^"]+)"/g)].map((m) => m[1]))];
  const entryMissing = (await Promise.all(entryAssets.map(async (a) => { const x = await fetch(base + a); await x.arrayBuffer(); return x.status === 200 ? null : `${a} → ${x.status}`; }))).filter(Boolean);
  ok(entryAssets.length >= 8 && entryMissing.length === 0, `every file /entry names is served (${entryAssets.length} files${entryMissing.length ? `; missing: ${entryMissing.join(", ")}` : ""})`);
  for (const alias of ["/entry/", "/entry.html"]) {
    const hop = await fetch(base + alias, { redirect: "manual" });
    const landed = await fetch(base + alias);
    ok([301, 308].includes(hop.status) && new URL(hop.headers.get("location"), base).pathname === "/entry" && landed.status === 200 && new URL(landed.url).pathname === "/entry", `GET ${alias} ends up at /entry`);
  }
  ok(!/href="\/entry|entry\.js/.test(pageText), "the voting page does not link to /entry");
  ok((await j("/api/entries")).status === 405, "GET /api/entries is a 405");
  const s5 = await j("/api/state");
  ok(s5.body.voting_starts_at === "2020-01-01T00:00:00.000Z" && s5.body.open === true, "the smoke server's start is moved to the past by its binding, so the vote is open; /api/state carries both");
  const sendEntryFile = (name, bytes, type, ip = "203.0.113.200") => fetch(base + "/api/entries/upload", { method: "POST", headers: { "x-file-name": encodeURIComponent(name), "content-type": type, "content-length": String(bytes.length), "cf-connecting-ip": ip }, body: bytes }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const entryFields = { first_name: "Zora", last_name: "Entrant", city: "Atlanta", email: "smoke.entrant@example.com", phone: "(404) 555-0100", in_group: true, members: [{ first_name: "Pal", last_name: "Mate", email: "pal.mate@example.com" }], agree: true, website: "" };
  const sendEntry = (body, ip = "203.0.113.201") => j("/api/entries", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify(body) });
  const badType = await sendEntryFile("notes.pdf", Buffer.from("%PDF-1.4"), "application/pdf");
  ok(badType.status === 415 && badType.body.error === "not_audio", "POST /api/entries/upload refuses a PDF");
  const entryUp = await sendEntryFile("Smoke Entry.wav", wavBytes, "audio/wav");
  ok(entryUp.status === 200 && /^[0-9a-f]{24}$/.test(entryUp.body?.upload_id ?? "") && Object.keys(entryUp.body).join() === "upload_id,file_name,size", "POST /api/entries/upload takes a generated WAV and answers a one-time id");
  const noRules = await sendEntry({ ...entryFields, agree: false, upload_id: entryUp.body.upload_id });
  ok(noRules.status === 400 && noRules.body.error === "agree_required", "POST /api/entries without the rules agreement is a 400 agree_required");
  const entered = await sendEntry({ ...entryFields, upload_id: entryUp.body.upload_id });
  ok(entered.status === 201 && Object.keys(entered.body).join() === "entry" && Number.isInteger(entered.body.entry) && !JSON.stringify(entered.body).includes("smoke"), `POST /api/entries answers the entry number and nothing else (${entered.body?.entry})`);
  const reused = await sendEntry({ ...entryFields, upload_id: entryUp.body.upload_id });
  ok(reused.status === 409 && reused.body.error === "upload_used", "the same upload cannot be entered twice");
  ok((await fetch(base + `/media/entries/${entryUp.body.upload_id}.wav`)).status === 404, "the entry's file is not reachable under /media");
  const s6 = await j("/api/state");
  ok(!JSON.stringify(s6.body).toLowerCase().includes("entr") && s6.body.tracks.length === 2, "an entry is not in /api/state");
  const promoteEntry = (...args) => {
    try { return { status: 0, out: execFileSync(process.execPath, [path.join(ROOT, "scripts/promote-entry.mjs"), ...args], { cwd: ROOT, env: { ...env, TBZ_PERSIST_TO: dir }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
    catch (e) { return { status: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }; }
  };
  await stopServer();
  const noSuch = promoteEntry("--env", "local", "--id", "999");
  ok(noSuch.status === 1 && /REFUSED: no entry has the number 999/.test(noSuch.out), `promote-entry refuses an unknown entry, exit ${noSuch.status}`);
  const entryDry = promoteEntry("--env", "local", "--id", String(entered.body.entry), "--dry-run");
  ok(entryDry.status === 0 && /ALLOWED \(agreed\)/.test(entryDry.out) && /dry run: would add zora  "Zora"/.test(entryDry.out), `promote-entry --dry-run says what it would do and writes nothing: ${entryDry.out.trim().split("\n").slice(-2).join(" | ")}`);
  const entryDone = promoteEntry("--env", "local", "--id", String(entered.body.entry));
  await startServer();
  ok(entryDone.status === 0 && /promoted  zora  "Zora"  1\.0 s  → topbarz-voting-media\/tracks\/zora-[0-9a-f]{10}\.wav/.test(entryDone.out), `promote-entry copies the audio under tracks/ and adds the vote track (exit ${entryDone.status}): ${entryDone.out.trim().split("\n").slice(-3).join(" | ")}`);
  let s7;
  const entryBy = Date.now() + 8_000;
  do { await new Promise((r) => setTimeout(r, 1000)); s7 = await j("/api/state"); } while (!s7.body.tracks.some((t) => t.slug === "zora") && Date.now() < entryBy);
  ok(s7.body.tracks.length === 3 && s7.body.tracks.some((t) => t.slug === "zora" && t.label === "Zora") && !JSON.stringify(s7.body).includes("@"), "the promoted entry is in /api/state with its first name, and no address");

  if (passed < 131) throw new Error(`only ${passed} checks ran`);
  console.log(`smoke: ${passed} checks passed`);
} catch (err) {
  console.error(String(err.message ?? err));
  if (/fetch failed/.test(String(err?.message)) && server?.exitCode !== null) console.error(`the dev server had exited (code ${server?.exitCode}); its last lines:\n${log.slice(-1500)}`);
  process.exitCode = 1;
} finally {
  server?.kill("SIGTERM");
  stub.close();
  setTimeout(() => { server?.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }); process.exit(process.exitCode ?? 0); }, 1500);
}
