#!/usr/bin/env node
// Clears the holiday party's TEST records off preview before a demo (Scooter, 18 Nov 2026: "Clean
// up the test data before I demo this to partners - the Test Ava/Bo groups, Jeff Gordon, the old
// test uploads. Test records only. Keep my E2E Demo entry (song 4380)").
//   node scripts/clean-test-data.mjs --env preview --keep 4380 --names "Jeff Gordon" --dry-run
//   node scripts/clean-test-data.mjs --env preview --keep 4380 --names "Jeff Gordon"
//   flags: --keep <code,code> (required: the songs to keep, with their group and people; "none" for
//   none), --names <"First Last","First Last"> (sign-ups that are test records but not named
//   "Test …"), --codes <code,code> (uploads that are test records but match no rule), --dry-run.
//
// A test record is: a sign-up named "Test …", or first-run's own (first-run-…@example.com), or a
// name given in --names; a group whose every sign-up is a test record; an upload whose file is
// "Test …", whose group is a test group, whose people are all test sign-ups, or whose code is in
// --codes. Never touched: the songs in --keep and everyone and every group on them, the team list,
// the GIFs, the beats, the CultureCon tracks, and every like and comment (a song taken off goes out
// of the vote, active = 0, its likes kept as ever). Refuses production. The audio files stay in R2
// (reachable only by the key the deleted row held). Prints what it did (first names only) and
// stops non-zero when a kept song is missing, before anything is written.
import { fileURLToPath } from "node:url";
import { isTestName } from "../functions/_lib/exclusions.js";
import { d1, parseArgs, sqlText, stopOnError, targets } from "./lib/cf.mjs";

const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const isFirstRunEmail = (e) => /^first-run-[a-z0-9-]+@example\.com$/i.test(String(e ?? ""));

// Pure: the rows → what is a test record. `tag` (first-run's own run) narrows it to rows carrying
// that tag in a name or file name.
export function selectTestRows({ guests = [], visits = [], tracks = [], people = [] }, { keep = [], names = [], codes = [], tag = null } = {}) {
  const keepCodes = new Set(keep.map(String));
  const kept = tracks.filter((t) => keepCodes.has(String(t.code)));
  const missing = [...keepCodes].filter((c) => !kept.some((t) => String(t.code) === c));
  const keptIds = new Set(kept.map((t) => t.id));
  const keptSessions = new Set(kept.map((t) => t.party_session_id).filter((v) => v != null));
  const keptEmails = new Set(people.filter((p) => keptIds.has(p.track_id)).map((p) => norm(p.email)));
  const named = new Set(names.map(norm).filter(Boolean));
  const tagged = (s) => !tag || String(s ?? "").includes(tag);
  const protectedGuest = (g) => keptSessions.has(g.session_id) || keptEmails.has(norm(g.email)) || visits.some((v) => v.guest_id === g.id && keptSessions.has(v.session_id));
  const testGuest = (g) => tagged(g.name) && (/^test\b/i.test(String(g.name ?? "").trim()) || isFirstRunEmail(g.email) || named.has(norm(g.name)));
  const G = guests.filter((g) => testGuest(g) && !protectedGuest(g));
  const gIds = new Set(G.map((g) => g.id));
  const gEmails = new Set(G.map((g) => norm(g.email)));
  const sessionIds = [...new Set([...guests.map((g) => g.session_id), ...visits.map((v) => v.session_id)])];
  const S = sessionIds.filter((sid) => !keptSessions.has(sid)
    && guests.filter((g) => g.session_id === sid).every((g) => gIds.has(g.id))
    && visits.filter((v) => v.session_id === sid).every((v) => gIds.has(v.guest_id))
    && (guests.some((g) => g.session_id === sid) || visits.some((v) => v.session_id === sid)));
  const sSet = new Set(S);
  const extra = new Set(codes.map(String));
  const B = tracks.filter((t) => {
    if (keptIds.has(t.id)) return false;
    const on = people.filter((p) => p.track_id === t.id);
    if (tag) return sSet.has(t.party_session_id) || String(t.file_name ?? "").includes(tag);
    return extra.has(String(t.code)) || isTestName(String(t.file_name ?? "")) || sSet.has(t.party_session_id) || (on.length > 0 && on.every((p) => gEmails.has(norm(p.email))));
  });
  return { missing, guests: G, sessionIds: S, tracks: B, kept };
}

const list = (ids) => ids.map((v) => sqlText(v)).join(", ");
const first = (name) => String(name ?? "").trim().split(/\s+/).slice(0, 2).map((w, i) => (i === 0 ? w : `${w[0] ?? ""}.`)).join(" ");

// Reads, selects and (unless dryRun) deletes. → { lines, picked }.
export async function cleanTestData(target, opts = {}) {
  if (target.env === "production") throw new Error("REFUSED: test records are cleaned on preview (or local) only, never production.");
  // One at a time: a local D1 refuses several wrangler processes at once.
  const guests = await d1(target, "SELECT id, session_id, name, email FROM party_guests");
  const visits = await d1(target, "SELECT guest_id, session_id FROM party_visits");
  const tracks = await d1(target, "SELECT id, code, file_name, party_session_id, vote_track_id FROM booth_tracks");
  const people = await d1(target, "SELECT track_id, email FROM booth_people");
  const picked = selectTestRows({ guests, visits, tracks, people }, opts);
  const lines = [];
  if (picked.missing.length) throw new Error(`STOPPED: the song${picked.missing.length > 1 ? "s" : ""} to keep (${picked.missing.join(", ")}) ${picked.missing.length > 1 ? "are" : "is"} not in ${target.db}; nothing was written. Check the code.`);
  lines.push(`${target.db}: keeping ${picked.kept.map((t) => `${t.code} (${t.file_name})`).join(", ") || "no song"} with its group and people.`);
  lines.push(`test sign-ups: ${picked.guests.length}${picked.guests.length ? ` (${[...new Set(picked.guests.map((g) => first(g.name)))].join(", ")})` : ""}; test groups: ${picked.sessionIds.length}; test uploads: ${picked.tracks.length}${picked.tracks.length ? ` (${picked.tracks.map((t) => `${t.code} ${t.file_name}`).join("; ")})` : ""}.`);
  const left = tracks.filter((t) => !picked.tracks.includes(t) && !picked.kept.includes(t));
  if (left.length) lines.push(`uploads left as they are: ${left.map((t) => `${t.code} ${t.file_name}`).join("; ")}.`);
  if (opts.dryRun) { lines.push("dry run: nothing written."); return { lines, picked }; }
  const tIds = picked.tracks.map((t) => t.id);
  const sql = [];
  if (tIds.length) {
    sql.push(`DELETE FROM booth_people WHERE track_id IN (${list(tIds)});`);
    sql.push(`UPDATE tracks SET active = 0 WHERE source_name IN (${list(tIds.map((id) => `booth:${id}`))});`);
    sql.push(`DELETE FROM booth_tracks WHERE id IN (${list(tIds)});`);
  }
  if (picked.sessionIds.length) sql.push(`DELETE FROM party_status_events WHERE session_id IN (${list(picked.sessionIds)});`);
  const gIds = picked.guests.map((g) => g.id);
  if (gIds.length || picked.sessionIds.length) sql.push(`DELETE FROM party_visits WHERE guest_id IN (${list(gIds.length ? gIds : [-1])}) OR session_id IN (${list(picked.sessionIds.length ? picked.sessionIds : [-1])});`);
  if (gIds.length) sql.push(`DELETE FROM party_guests WHERE id IN (${list(gIds)});`);
  if (picked.sessionIds.length) sql.push(`DELETE FROM party_sessions WHERE id IN (${list(picked.sessionIds)});`);
  if (!sql.length) { lines.push("nothing to clean: no test records found."); return { lines, picked }; }
  const keepCheck = picked.kept.length ? `SELECT COUNT(*) AS n FROM booth_tracks WHERE code IN (${list(picked.kept.map((t) => t.code))})` : "SELECT 0 AS n";
  const [{ n }] = await d1(target, `${sql.join("\n")}\n${keepCheck};`);
  if (n !== picked.kept.length) throw new Error(`STOPPED: after the clean ${n} of ${picked.kept.length} kept songs are in ${target.db}. Look at it.`);
  lines.push(`cleaned: ${picked.guests.length} sign-ups, ${picked.sessionIds.length} groups, ${picked.tracks.length} uploads (out of the vote, likes kept). Kept songs still there: ${n}.`);
  return { lines, picked };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  stopOnError();
  const args = parseArgs(process.argv.slice(2), { env: "value", keep: "value", names: "value", codes: "value", "dry-run": "flag" });
  if (args.env !== "preview" && args.env !== "local") { console.error("REFUSED: test records are cleaned on preview (or local) only: --env preview. Production is never cleaned by a script."); process.exit(2); }
  if (!args.keep) { console.error('STOPPED: say which songs to keep: --keep 4380 (or --keep none).'); process.exit(2); }
  const split = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const keep = args.keep === "none" ? [] : split(args.keep);
  if (keep.some((c) => !/^\d{4}$/.test(c))) { console.error("STOPPED: --keep takes 4-digit song codes, comma-separated."); process.exit(2); }
  const { lines } = await cleanTestData(targets(args.env), { keep, names: split(args.names), codes: split(args.codes), dryRun: Boolean(args["dry-run"]) });
  // One line: the job's run record keeps only the last line printed, and the 18 Nov dry run's record
  // read "dry run: nothing written." with the list itself lost. Everything it saw is on that line.
  console.log(lines.join(" "));
}
