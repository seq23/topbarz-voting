#!/usr/bin/env node
// Pull the Top Barz build package from Google Drive to ~/topbarz-source/drive (tracks, photos,
// PRD). Files already here and unchanged are skipped. Needs GSC_SERVICE_ACCOUNT_JSON, which lives
// in the boss-os vault — so run with no key in the environment, this re-launches itself through
// `npm run -s vault:run` there and the key goes vault → process, never onto a command line.
//   npm run sync-drive            (or: node scripts/sync-drive.mjs [folderId] [outDir])
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FOLDER_ID = process.argv[2] ?? "1M3nB8NQl_ftKTqurJGpIa_QpmedIC4oz";
const OUT = path.resolve(process.argv[3] ?? path.join(os.homedir(), "topbarz-source", "drive"));

if (!process.env.GSC_SERVICE_ACCOUNT_JSON) {
  const vaultRepo = path.join(os.homedir(), "GitHub", "boss-os");
  if (process.env.TBZ_SYNC_RELAUNCHED || !fs.existsSync(path.join(vaultRepo, "scripts", "vault", "vault.mjs"))) {
    console.error("STOPPED: GSC_SERVICE_ACCOUNT_JSON is not set and the boss-os vault did not provide it. Check: cd ~/GitHub/boss-os && npm run -s vault:status");
    process.exit(2);
  }
  const r = spawnSync("npm", ["run", "-s", "vault:run", "--", "node", import.meta.filename, FOLDER_ID, OUT], { cwd: vaultRepo, stdio: "inherit", env: { ...process.env, TBZ_SYNC_RELAUNCHED: "1" } });
  process.exit(r.status ?? 1);
}

const creds = JSON.parse(process.env.GSC_SERVICE_ACCOUNT_JSON);
const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const unsigned = b64({ alg: "RS256", typ: "JWT" }) + "." + b64({ iss: creds.client_email, sub: "sequoia@westpeek.ventures", scope: "https://www.googleapis.com/auth/drive.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 900 });
const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(creds.private_key).toString("base64url");
const tok = await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + sig }) })).json();
if (!tok.access_token) { console.error("STOPPED: Google token error:", tok.error, tok.error_description); process.exit(3); }
const H = { authorization: "Bearer " + tok.access_token };
const EXPORT = { "application/vnd.google-apps.document": ["text/markdown", ".md"], "application/vnd.google-apps.spreadsheet": ["text/csv", ".csv"], "application/vnd.google-apps.presentation": ["application/pdf", ".pdf"] };
const count = { new: 0, same: 0, failed: 0 };
const perFolder = {};

async function walk(id, rel) {
  let pageToken = "";
  do {
    const r = await (await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${id}' in parents and trashed=false`)}&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime)&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true&pageToken=${pageToken}`, { headers: H })).json();
    if (r.error) { console.error("STOPPED: Drive list error:", r.error.code, r.error.message); process.exit(4); }
    for (const f of r.files ?? []) {
      const p = path.join(rel, f.name.replace(/[\/:]/g, "-"));
      if (f.mimeType === "application/vnd.google-apps.folder") { fs.mkdirSync(path.join(OUT, p), { recursive: true }); perFolder[p] = 0; await walk(f.id, p); continue; }
      const ex = EXPORT[f.mimeType];
      const dest = path.join(OUT, p + (ex ? ex[1] : ""));
      if (rel in perFolder) perFolder[rel]++;
      const st = fs.existsSync(dest) ? fs.statSync(dest) : null;
      if (st && !ex && String(st.size) === f.size && st.mtimeMs >= Date.parse(f.modifiedTime)) { count.same++; continue; }
      const url = ex ? `https://www.googleapis.com/drive/v3/files/${f.id}/export?mimeType=${encodeURIComponent(ex[0])}` : `https://www.googleapis.com/drive/v3/files/${f.id}?alt=media&supportsAllDrives=true`;
      const res = await fetch(url, { headers: H });
      if (!res.ok) { console.log(`FAIL ${p} (${f.mimeType}) http ${res.status}`); count.failed++; continue; }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      console.log(`FILE ${p}${ex ? ex[1] : ""}`);
      count.new++;
    }
    pageToken = r.nextPageToken ?? "";
  } while (pageToken);
}
fs.mkdirSync(OUT, { recursive: true });
await walk(FOLDER_ID, "");
console.log(`\n${count.new} downloaded, ${count.same} unchanged, ${count.failed} failed → ${OUT}`);
for (const [dir, n] of Object.entries(perFolder)) console.log(`  ${dir}: ${n} file(s)`);
if (count.failed) { console.error("STOPPED: some files did not download; run it again."); process.exit(1); }
if (count.new + count.same === 0) { console.error("STOPPED: the Drive folder listed no files at all."); process.exit(1); }
