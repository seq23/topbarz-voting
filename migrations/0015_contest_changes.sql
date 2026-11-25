-- The contest entry is the whole song's (Scooter, 19 Nov 2026: "Make contest entry a shared
-- song-level setting. Any group member can enter or withdraw it for everyone. Show who last changed
-- it, and preserve its votes if it's withdrawn and entered again."). Additive only.
--
-- Every Enter and every withdraw is a row here, never deleted (but by the preview's demo-song reset,
-- for its own song, and clean-test-data, for the test songs it removes): the song, the email that did it (one
-- of the song's people, or the preview demo's host), their record when they have one, which way, when
-- and which rules were on the page. /track shows the newest as "Entered by Carlos at 9:42 PM" or
-- "Withdrawn by Scooter at 9:50 PM". The votes are never touched: a withdrawn song's vote track is
-- only switched off (active = 0), and entering it again switches the same track back on.
CREATE TABLE booth_contest_changes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id      INTEGER NOT NULL,                     -- the booth song (its row id)
  email         TEXT NOT NULL,
  guest_id      INTEGER,                              -- party_guests.id of that person, when they have one
  entered       INTEGER NOT NULL,                     -- 1 entered, 0 withdrawn
  at            INTEGER NOT NULL,                     -- ms
  rules_version TEXT
);
CREATE INDEX booth_contest_changes_track ON booth_contest_changes (track_id, at);
