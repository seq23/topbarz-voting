#!/usr/bin/env node
// A song ready to take through the contest entry on the preview, for a demo (Scooter, 19 Nov 2026:
// "I have a partner call today and need to demonstrate adding a song to the contest ... My current
// uploads are marked as test entries and aren't eligible"). His own uploads stay out of the vote:
// any song with Scooter Taylor on it is refused (functions/_lib/exclusions.js), so the demo song's
// one person is a demo singer, and whoever opens /track with the song's code and that person's email
// has its controls (everyone on a song does): artwork, title, Enter the contest, and it is on the voting page.
//   node scripts/demo-song.mjs --env preview            (makes it once; run again = one-click reset)
//   flags: --name "<first last>" (default "Demo Singer"), --email <address> (default
//   jingle.demo@example.com; nothing is ever mailed to it: /track asks no code), --dry-run,
//   --host <address>: the demo's host, who runs the demo with their OWN email (Scooter, 19 Nov
//   2026: "use my own access"). The host holds the song's controls (artwork, title, Enter, Share)
//   without being one of its people (migrations/0014_demo_host.sql), so the song is still the demo
//   singer's and the vote never sees the host's name. Kept on every reset; never written to a file.
// Safe to run again: the second run finds the same song (same code, same link) and puts it back to
// "not entered": out of the vote (likes kept, as ever), no entry history, no title, no artwork. The audio
// is a short synthesised "Jingle Bells" (James Lord Pierpont, 1857: public domain). Refuses
// production, a "Test …" or Scooter Taylor name, and a malformed email. Prints one line starting
// DEMO_SONG with the code and the email to type.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEmail, mediaKey, randomCode } from "../functions/_lib/booth.js";
import { isScooterTaylor, isTestName } from "../functions/_lib/exclusions.js";
import { guestKey, randomSessionCode } from "../functions/_lib/party.js";
import { d1, parseArgs, r2Put, sqlText, stopOnError, targets } from "./lib/cf.mjs";

export const DEMO_FILE = "Holiday Demo - Jingle Bells.wav";
export const DEMO_DEFAULTS = { name: "Demo Singer", email: "jingle.demo@example.com" };

// ── The audio: the "Jingle Bells" chorus as soft sine notes, 16-bit mono WAV, about 9 seconds.
const NOTES = { C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99 };
const TUNE = [
  ["E5", 1], ["E5", 1], ["E5", 2], ["E5", 1], ["E5", 1], ["E5", 2], ["E5", 1], ["G5", 1], ["C5", 1.5], ["D5", 0.5], ["E5", 4],
  ["F5", 1], ["F5", 1], ["F5", 1.5], ["F5", 0.5], ["F5", 1], ["E5", 1], ["E5", 1], ["E5", 0.5], ["E5", 0.5], ["E5", 1], ["D5", 1], ["D5", 1], ["E5", 1], ["D5", 2], ["G5", 2],
];
export function jingleWav({ rate = 22050, beat = 0.27 } = {}) {
  const total = Math.round(TUNE.reduce((s, [, b]) => s + b, 0) * beat * rate);
  const pcm = Buffer.alloc(total * 2);
  let at = 0;
  for (const [note, beats] of TUNE) {
    const n = Math.round(beats * beat * rate);
    for (let i = 0; i < n && at + i < total; i++) {
      const t = i / rate;
      const env = Math.min(1, i / (0.01 * rate)) * Math.exp(-3 * t);
      const f = NOTES[note];
      const v = env * (0.6 * Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t) + 0.1 * Math.sin(6 * Math.PI * f * t));
      pcm.writeInt16LE(Math.round(v * 0.5 * 32767), (at + i) * 2);
    }
    at += n;
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + pcm.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write("data", 36); head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

// ── The rows. Pure: the statements, in order (run as one D1 command).
// Make: one sign-up for the demo singer (a finished place in line, so they are not in the line),
// the booth row, and the singer on the song by their record. A singer already signed up is reused.
export function createStatements({ code, key, size, now, name, email, guest, session, host = null }) {
  const e = sqlText(email);
  return [
    `INSERT INTO party_sessions (code, created_at, status, status_at, done_at) SELECT ${sqlText(session)}, ${now}, 'out', ${now}, ${now} WHERE NOT EXISTS (SELECT 1 FROM party_guests WHERE email = ${e})`,
    `INSERT INTO party_guests (session_id, name, phone, email, city, instagram, guest_key, joined_at) SELECT id, ${sqlText(name)}, '555 010 0000', ${e}, 'Demo', '', ${sqlText(guest)}, ${now} FROM party_sessions WHERE code = ${sqlText(session)} AND NOT EXISTS (SELECT 1 FROM party_guests WHERE email = ${e})`,
    `INSERT INTO booth_tracks (code, file_name, content_type, size, media_key, uploaded_at, host_email) VALUES (${sqlText(code)}, ${sqlText(DEMO_FILE)}, 'audio/wav', ${size}, ${sqlText(key)}, ${now}, ${host ? sqlText(host) : "NULL"})`,
    `INSERT INTO booth_people (track_id, email, attached_at, guest_id) SELECT b.id, ${e}, ${now}, g.id FROM booth_tracks b, party_guests g WHERE b.code = ${sqlText(code)} AND g.email = ${e}`,
  ];
}
// Reset: back to "not entered" with no history line. Out of the vote (likes kept), no title, no art.
// A --host given now becomes the song's host; with none, the host it has is kept.
export function resetStatements({ code, now, host = null }) {
  const c = sqlText(code);
  return [
    `UPDATE tracks SET active = 0, updated_at = ${sqlText(new Date(now).toISOString())} WHERE id = (SELECT vote_track_id FROM booth_tracks WHERE code = ${c})`,
    `DELETE FROM booth_contest_changes WHERE track_id = (SELECT id FROM booth_tracks WHERE code = ${c})`,
    `UPDATE booth_tracks SET contest_entered_by = NULL, contest_entered_at = NULL, contest_rules_version = NULL, contest_confirmed_by = NULL, contest_confirmed_at = NULL, manager_email = NULL, manager_at = NULL, title = NULL, art_key = NULL, public = 0, pulled_at = NULL, pulled_by = NULL${host ? `, host_email = ${sqlText(host)}` : ""} WHERE code = ${c}`,
  ];
}
export const FIND_SQL = `SELECT b.code, p.email FROM booth_tracks b JOIN booth_people p ON p.track_id = b.id WHERE b.file_name = ${sqlText(DEMO_FILE)} ORDER BY b.id LIMIT 1`;

// The flags → { name, email } or a refusal, before anything is read or written.
export function checkArgs(args) {
  if (args.env !== "preview" && args.env !== "local") return { error: "the demo song is for the preview only: --env preview (production's vote takes real songs only)" };
  const name = String(args.name ?? DEMO_DEFAULTS.name).trim();
  const email = cleanEmail(args.email ?? DEMO_DEFAULTS.email);
  if (!name) return { error: "say who sings it: --name \"First Last\"" };
  if (isScooterTaylor(name)) return { error: "a song with Scooter Taylor on it never goes in the vote: give the demo singer another name" };
  if (isTestName(name)) return { error: "a \"Test …\" name is cleared by clean-test-data: give the demo singer another name" };
  if (!email) return { error: "--email is not an email address" };
  const host = args.host === undefined ? null : cleanEmail(args.host);
  if (args.host !== undefined && !host) return { error: "--host is not an email address" };
  if (host && host === email) return { error: "--host is the demo singer's own email: the host is the person running the demo, with their own email" };
  return { name, email, host };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  stopOnError();
  const args = parseArgs(process.argv.slice(2), { env: "value", name: "value", email: "value", host: "value", "dry-run": "flag" });
  const checked = checkArgs(args);
  if (checked.error) { console.error(`STOPPED: ${checked.error}`); process.exit(2); }
  const target = targets(args.env);
  const now = Date.now();
  const [found] = await d1(target, FIND_SQL);
  if (found) {
    if (args["dry-run"]) { console.log(`dry run: would reset the demo song ${found.code} to not entered; nothing written`); process.exit(0); }
    await d1(target, resetStatements({ code: found.code, now, host: checked.host }).join(";\n"));
    const [h] = await d1(target, `SELECT host_email FROM booth_tracks WHERE code = ${sqlText(found.code)}`);
    if (checked.host && h?.host_email !== checked.host) { console.error("STOPPED: the host was not written to the demo song"); process.exit(1); }
    console.log(`DEMO_SONG code ${found.code} · email ${found.email} · reset: not entered, out of the vote${h?.host_email ? " · the host's own email opens it with the controls" : ""}`);
    process.exit(0);
  }
  const taken = new Set((await d1(target, "SELECT code FROM booth_tracks")).map((r) => String(r.code)));
  let code = randomCode();
  while (taken.has(code)) code = randomCode();
  const key = mediaKey(code, "wav");
  const wav = jingleWav();
  if (args["dry-run"]) { console.log(`dry run: would upload ${DEMO_FILE} (${wav.length} bytes) as ${code} with ${checked.name} on it; nothing written`); process.exit(0); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbz-demo-"));
  const file = path.join(dir, "demo.wav");
  fs.writeFileSync(file, wav);
  try { await r2Put(target, key, file, "audio/wav"); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  await d1(target, createStatements({ code, key, size: wav.length, now, name: checked.name, email: checked.email, guest: guestKey(), session: randomSessionCode(), host: checked.host }).join(";\n"));
  const [made] = await d1(target, FIND_SQL);
  if (!made) { console.error("STOPPED: the demo song was not written (no row with its file name and its singer)"); process.exit(1); }
  console.log(`DEMO_SONG code ${made.code} · email ${made.email} · made: not entered yet`);
}
