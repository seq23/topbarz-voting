// A real local D1 and R2 (Miniflare, in memory) with the repo's migrations applied, and a way to
// call a Pages Function exactly as the runtime would.
import fs from "node:fs";
import path from "node:path";
import { getPlatformProxy } from "wrangler";
import { _resetStateMemo } from "../functions/api/state.js";

export const ROOT = path.resolve(import.meta.dirname, "..");
// Voting has started in every test environment unless a test says otherwise (the real start,
// 11 Oct 2026 10 AM ET, is in the future until then): tests/window.test.mjs sets its own.
export const LONG_OPEN = "2020-01-01T00:00:00Z";
export const SECRET = "test-secret-not-a-real-one";

export async function makeEnv(extra = {}) {
  const proxy = await getPlatformProxy({ configPath: path.join(ROOT, "wrangler.toml"), persist: false });
  const dir = path.join(ROOT, "migrations");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(dir, file), "utf8").replace(/--.*$/gm, "");
    for (const stmt of sql.split(";").map((s) => s.trim()).filter(Boolean)) await proxy.env.DB.prepare(stmt).run();
  }
  _resetStateMemo();
  const env = { DB: proxy.env.DB, MEDIA: proxy.env.MEDIA, APP_ENV: "test", VOTER_TOKEN_SECRET: SECRET, VOTING_STARTS_AT: LONG_OPEN, ...extra };
  return { env, dispose: () => proxy.dispose() };
}

let ipCounter = 0;
export const freshIp = () => `203.0.113.${(ipCounter++ % 250) + 1}`;

// call(handler, env, { method, path, body, token, ip, headers, params }) → { status, body, headers, text }
export async function call(handler, env, { method = "GET", path: p = "/", body, token, ip = "198.51.100.7", headers = {}, params = {} } = {}) {
  const h = new Headers({ "cf-connecting-ip": ip, ...headers });
  if (token) h.set("authorization", `Bearer ${token}`);
  if (body !== undefined) h.set("content-type", "application/json");
  const request = new Request(`https://voting.test${p}`, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const pending = [];
  const res = await handler({ request, env, params, waitUntil: (x) => pending.push(x), next: () => new Response("next", { status: 404 }) });
  await Promise.all(pending);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString("utf8");
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  return { status: res.status, body: parsed, text, bytes: buf, headers: res.headers };
}

export async function addTrack(env, slug, { label = slug[0].toUpperCase() + slug.slice(1), active = 1, sort = 0, sourceName = `${label} Example` } = {}) {
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO tracks (slug, label, source_name, audio_key, duration_ms, sort, active, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 60000, ?5, ?6, ?7, ?7)")
    .bind(slug, label, sourceName, `tracks/${slug}-abc123.mp3`, sort, active, now).run();
}

export async function signUp(env, voters, { name = "Jane Doe", email, city = "Atlanta", ip = freshIp(), ...rest } = {}) {
  const res = await call(voters.onRequest, env, { method: "POST", path: "/api/voters", ip, body: { name, email, city, ...rest } });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${res.text}`);
  return res.body;
}

// Calls fn(i) until it answers 429 → how many calls were accepted first. Allows for one fixed
// window rolling over mid-test (so at most 2 × max + 2 calls), which a plain "max + 1" loop does not.
export async function acceptedBeforeLimit(fn, max) {
  for (let i = 0; i < 2 * max + 2; i++) {
    const res = await fn(i);
    if (res.status === 429) {
      if (res.body?.error !== "rate_limited") throw new Error(`429 without the rate_limited code: ${res.text}`);
      return i;
    }
  }
  return Infinity;
}
