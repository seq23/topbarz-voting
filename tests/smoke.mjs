#!/usr/bin/env node
// The whole thing over HTTP, once: `wrangler pages dev` with a throwaway local D1 and R2. Proves
// what the handler tests cannot — that every route is wired where the front end will call it,
// that Range works through the real runtime, and that a like shows up in the polled state.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const WRANGLER = path.join(ROOT, "node_modules", ".bin", "wrangler");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbz-smoke-"));
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", CI: "1" };
const wr = (args) => execFileSync(WRANGLER, [...args, "--persist-to", dir], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

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
  server = spawn(WRANGLER, ["pages", "dev", "public", "--port", String(port), "--inspector-port", String(await freePort()), "--persist-to", dir, "--binding", "VOTER_TOKEN_SECRET=smoke-only-not-a-secret", "--show-interactive-dev-session=false"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
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
  ok(page.status === 200 && (await page.text()).includes("JUMP IN THE BOOTH"), "GET / serves the page");

  const s1 = await j("/api/state");
  ok(s1.status === 200 && s1.body.tracks.length === 1 && s1.body.tracks[0].slug === "smoke" && s1.body.tracks[0].likes === 0, "GET /api/state lists the track with 0 likes");
  ok(s1.body.closed === false && s1.body.voting_ends_at === "2026-10-12T06:59:00.000Z", "state carries the end time and closed=false");
  ok(s1.body.giphy.available === false && s1.body.giphy.reason === "no_key" && s1.body.gate.available === true, "state names the GIF picker as off (no key) and the gate as on");
  ok(Array.isArray(s1.body.photos) && s1.body.photos.length === 0, "no photos = empty manifest");

  const nf = await j("/api/does-not-exist");
  ok(nf.status === 404 && nf.body?.error === "not_found", "an unknown /api path is a JSON 404, not the HTML page");
  ok((await j("/api/voters")).status === 405, "GET /api/voters is a 405");

  const gate = await post("/api/voters", { name: "Smoke Tester", email: "Smoke.Tester@Example.com ", city: "Brooklyn" });
  ok(gate.status === 200 && /^v1\.\d+\./.test(gate.body.token) && gate.body.voter.first_name === "Smoke", "POST /api/voters returns a signed token and a first name");
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

  if (passed < 18) throw new Error(`only ${passed} checks ran`);
  console.log(`smoke: ${passed} checks passed`);
} catch (err) {
  console.error(String(err.message ?? err));
  process.exitCode = 1;
} finally {
  server?.kill("SIGTERM");
  setTimeout(() => { server?.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }); process.exit(process.exitCode ?? 0); }, 1500);
}
