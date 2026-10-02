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

  const s1 = await j("/api/state");
  ok(s1.status === 200 && s1.body.tracks.length === 1 && s1.body.tracks[0].slug === "smoke" && s1.body.tracks[0].likes === 0, "GET /api/state lists the track with 0 likes");
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
  ok(mailbox.length === 1 && code && mail.to?.[0] === "smoke.tester@example.com" && mail.from === "Top Barz Voting <voting@events.westpeek.live>" && mail.text.includes(code) && mail.html.includes(code) && mail.auth === "Bearer smoke-only-not-a-key", "one email went to the mail service: the code, from Top Barz Voting, to that address");
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

  if (passed < 30) throw new Error(`only ${passed} checks ran`);
  console.log(`smoke: ${passed} checks passed`);
} catch (err) {
  console.error(String(err.message ?? err));
  process.exitCode = 1;
} finally {
  server?.kill("SIGTERM");
  stub.close();
  setTimeout(() => { server?.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }); process.exit(process.exitCode ?? 0); }, 1500);
}
