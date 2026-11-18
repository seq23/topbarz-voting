// scripts/clean-test-data.mjs (Scooter, 18 Nov 2026): test records only; the kept song, its group
// and its people are never touched; production is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { selectTestRows, cleanTestData } from "../scripts/clean-test-data.mjs";

const rows = {
  guests: [
    { id: 1, session_id: 10, name: "Test Ava k1", email: "first-run-ava-k1@example.com" },
    { id: 2, session_id: 10, name: "Test Bo k1", email: "first-run-bo-k1@example.com" },
    { id: 3, session_id: 11, name: "Jeff Gordon", email: "jeff@example.com" },
    { id: 4, session_id: 12, name: "E2E Demo", email: "demo@example.com" },
    { id: 5, session_id: 12, name: "Test Kim", email: "kim@example.com" }, // on the kept song's group: kept
    { id: 6, session_id: 13, name: "Real Person", email: "real@example.com" },
    { id: 7, session_id: 13, name: "Test Mo", email: "mo@example.com" }, // shares a group with a real person
  ],
  visits: [{ guest_id: 1, session_id: 10 }, { guest_id: 2, session_id: 10 }, { guest_id: 3, session_id: 11 }, { guest_id: 4, session_id: 12 }, { guest_id: 5, session_id: 12 }, { guest_id: 6, session_id: 13 }, { guest_id: 7, session_id: 13 }],
  tracks: [
    { id: 100, code: "4380", file_name: "Test - E2E Demo.mp3", party_session_id: 12 },
    { id: 101, code: "1111", file_name: "Test - Walk up k1.mp3", party_session_id: null },
    { id: 102, code: "2222", file_name: "Jingle.mp3", party_session_id: 10 },
    { id: 103, code: "3333", file_name: "Jeff.mp3", party_session_id: null },
    { id: 104, code: "4444", file_name: "Real song.mp3", party_session_id: 13 },
    { id: 105, code: "5555", file_name: "Odd one.mp3", party_session_id: null },
  ],
  people: [{ track_id: 100, email: "demo@example.com" }, { track_id: 100, email: "kim@example.com" }, { track_id: 103, email: "jeff@example.com" }, { track_id: 104, email: "real@example.com" }],
};

test("clean-test-data picks test records only, and never the kept song or anyone on it", () => {
  const p = selectTestRows(rows, { keep: ["4380"], names: ["Jeff Gordon"], codes: ["5555"] });
  assert.deepEqual(p.missing, []);
  assert.deepEqual(p.guests.map((g) => g.id).sort(), [1, 2, 3, 7], "Test …, first-run's and the named; not the kept group's Test Kim");
  assert.deepEqual(p.sessionIds.sort(), [10, 11], "a group with a real person in it stays");
  assert.deepEqual(p.tracks.map((t) => t.code).sort(), ["1111", "2222", "3333", "5555"], "never 4380 (even with a Test file name) or a real group's song");
  assert.deepEqual(selectTestRows(rows, { keep: ["9999"] }).missing, ["9999"], "a kept song that is not there is reported, so nothing is written");
  // first-run's own run: only its tag.
  const own = selectTestRows(rows, { tag: "k1" });
  assert.deepEqual([own.guests.map((g) => g.id).sort(), own.sessionIds, own.tracks.map((t) => t.code).sort()], [[1, 2], [10], ["1111", "2222"]]);
  // Zero test records: nothing picked (and the script says so rather than pretend).
  const none = selectTestRows({ ...rows, guests: rows.guests.filter((g) => g.id === 6), visits: [], tracks: [rows.tracks[4]], people: [] }, { keep: [] });
  assert.deepEqual([none.guests.length, none.sessionIds.length, none.tracks.length], [0, 0, 0]);
});

test("clean-test-data refuses production, and a run with no kept song named", async () => {
  await assert.rejects(cleanTestData({ env: "production", db: "topbarz-voting" }, { keep: [] }), /REFUSED/);
  for (const argv of [["--env", "production", "--keep", "4380"], ["--env", "preview"]]) {
    let code = 0;
    try { execFileSync(process.execPath, ["scripts/clean-test-data.mjs", ...argv], { stdio: "pipe" }); } catch (err) { code = err.status; }
    assert.equal(code, 2, argv.join(" "));
  }
});
