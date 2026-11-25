-- The holiday party, after Scooter's preview notes (17 Nov 2026). Additive only.
--
-- 1. "Just out / at the upload station" is its own lane, apart from "in the booth": a group the
--    team marks Out waits there (status 'out', done_at NULL) until the engineer uploads its song
--    against it (or the team marks it done); then done_at is set. The lane is read from the two
--    columns (functions/_lib/party.js laneOf), so no CHECK constraint changes.
ALTER TABLE party_sessions ADD COLUMN done_at INTEGER;  -- ms; NULL = still in line or at the upload station
--
-- 2. One active place per person, and back in line after a session ends: a returning email keeps
--    its one party_guests row (moved to the new session); every sign-up is also a row here, never
--    deleted, so the team's history of who was in which group is kept.
CREATE TABLE party_visits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_id    INTEGER NOT NULL REFERENCES party_guests (id),
  session_id  INTEGER NOT NULL REFERENCES party_sessions (id),
  joined_at   INTEGER NOT NULL
);
CREATE INDEX party_visits_session ON party_visits (session_id, joined_at);
--
-- 3. The contest entry is the song's (preview only until Scooter settles the waiver question):
--    someone on the song ticks Enter (agreeing to the rules), and on a group song confirms it with
--    the group. Who and when are kept; the emails stay here and are never answered to anyone else.
ALTER TABLE booth_tracks ADD COLUMN contest_entered_by TEXT;
ALTER TABLE booth_tracks ADD COLUMN contest_entered_at INTEGER;
ALTER TABLE booth_tracks ADD COLUMN contest_rules_version TEXT;
ALTER TABLE booth_tracks ADD COLUMN contest_confirmed_by TEXT;
ALTER TABLE booth_tracks ADD COLUMN contest_confirmed_at INTEGER;
