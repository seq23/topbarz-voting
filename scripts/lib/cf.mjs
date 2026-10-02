// Where each environment's data lives (read from wrangler.toml — never a second list) and thin
// wrappers over the repo's own wrangler. Uses the Mac's `wrangler login`; no secret is read here.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parse } from "smol-toml";

const run = promisify(execFile);
export const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const ENVS = ["local", "preview", "production"];
const WRANGLER = path.join(ROOT, "node_modules", ".bin", "wrangler");
const ACCOUNT_ID = "8d147e242033699dd37c6f5a451f48d2";

export function targets(envName, tomlText = fs.readFileSync(path.join(ROOT, "wrangler.toml"), "utf8")) {
  if (!ENVS.includes(envName)) throw new Error(`--env must be one of: ${ENVS.join(", ")}`);
  const cfg = parse(tomlText);
  const src = envName === "preview" ? cfg.env?.preview : cfg;
  const db = src?.d1_databases?.find((d) => d.binding === "DB")?.database_name;
  const bucket = src?.r2_buckets?.find((b) => b.binding === "MEDIA")?.bucket_name;
  if (!db || !bucket) throw new Error(`wrangler.toml has no DB/MEDIA binding for ${envName}`);
  return {
    env: envName, db, bucket,
    where: envName === "local" ? ["--local"] : ["--remote"],
    envFlag: envName === "preview" ? ["--env", "preview"] : [],
  };
}

async function wrangler(args, opts = {}) {
  try {
    return await run(WRANGLER, args, {
      cwd: ROOT, maxBuffer: 512 * 1024 * 1024,
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID || ACCOUNT_ID, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
      ...opts,
    });
  } catch (err) {
    const said = `${err.stderr ?? ""}\n${err.stdout ?? ""}`.split("\n").map((l) => l.trim()).filter((l) => /error|not exist|not found|denied|authenticat/i.test(l)).slice(0, 3).join(" | ");
    throw new Error(`wrangler ${args.slice(0, 3).join(" ")} failed: ${said || err.message.split("\n")[0]}`);
  }
}

// A loader that fails says one plain line and exits non-zero (never a stack dump, never exit 0).
export function stopOnError() {
  process.on("uncaughtException", (err) => { console.error(`STOPPED: ${err.message}`); process.exit(1); });
}

// Runs SQL → the rows of the LAST statement. (`--command`, not `--file`: a remote --file run goes
// through D1's import path and returns no rows.) No voter data is ever put in SQL by these scripts.
export async function d1(target, sql) {
  const { stdout } = await wrangler(["d1", "execute", target.db, ...target.where, ...target.envFlag, "--json", "--yes", "--command", sql]);
  const out = JSON.parse(stdout.slice(stdout.indexOf("[")));
  const last = out[out.length - 1];
  if (!last || last.success === false) throw new Error(`D1 did not run the statement: ${stdout.slice(0, 300)}`);
  return last.results ?? [];
}

export async function r2Put(target, key, file, contentType) {
  const args = ["r2", "object", "put", `${target.bucket}/${key}`, "--file", file, "--content-type", contentType, ...target.where];
  for (let attempt = 1; ; attempt++) {
    try { await wrangler(args); return; } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

// → Buffer, or null when the object does not exist.
export async function r2Get(target, key) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbz-r2-"));
  const file = path.join(dir, "obj");
  try {
    await wrangler(["r2", "object", "get", `${target.bucket}/${key}`, "--file", file, ...target.where]);
    return fs.readFileSync(file);
  } catch (err) {
    if (/not exist|not found|NoSuchKey|404/i.test(err.message)) return null;
    throw err;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export const sqlText = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

export function parseArgs(argv, known) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { args._.push(a); continue; }
    const name = a.slice(2);
    if (!(name in known)) throw new Error(`unknown flag ${a} (known: ${Object.keys(known).map((k) => "--" + k).join(" ")})`);
    args[name] = known[name] === "flag" ? true : argv[++i];
  }
  return args;
}

export async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

export function sha256File(file) {
  return import("node:crypto").then(({ createHash }) => createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
}

export const DRIVE_DIR = path.join(os.homedir(), "topbarz-source", "drive");
