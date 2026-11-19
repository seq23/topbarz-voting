-- The holiday party, after Scooter's consolidated revision list (18 Nov 2026, "where anything here
-- conflicts with my earlier notes, this wins"). Additive only: no row already here is changed.
--
-- 1. Everyone signs up on their own: one line card (party_sessions row) per person. The brand
--    ambassador taps each person into the booth and out; those taps make a TAKE, the one recording
--    the song belongs to. A person tapped in joins the take that is open (someone of it still in the
--    booth), or starts one. The take CLOSES when the last of its people is tapped out: it is then at
--    the upload station, whole, and the engineer's next upload lands on exactly its people (the oldest
--    closed take first). So people marked out of one recording never carry over into the next upload.
CREATE TABLE party_takes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_at   INTEGER NOT NULL,                       -- ms, the first tap into the booth
  closed_at   INTEGER,                                -- ms, the last of its people tapped out; NULL = still recording
  track_id    INTEGER                                 -- booth_tracks.id once its song is uploaded; NULL until then
);
CREATE INDEX party_takes_station ON party_takes (track_id, closed_at);
ALTER TABLE party_sessions ADD COLUMN take_id INTEGER;  -- the take this person was in the booth for
ALTER TABLE booth_tracks ADD COLUMN party_take_id INTEGER;
--
-- 2. Recordings attach by explicit membership: a song's person names the one record of that person
--    (party_guests.id: one per email, kept when they come back in line), never a match on a typed
--    email or phone. NULL on rows from before (they were attached by the upload from the group).
ALTER TABLE booth_people ADD COLUMN guest_id INTEGER;
--
-- 3. Managing a song is first come: whoever on the song first adds artwork, a title, the contest
--    entry or the first Share keeps those controls. Kept here, never answered to anyone else.
ALTER TABLE booth_tracks ADD COLUMN manager_email TEXT;
ALTER TABLE booth_tracks ADD COLUMN manager_at INTEGER;
--
-- 4. When a song lands on the wrong people, the team re-points it from /team, and every change is a
--    row here, never deleted: who changed it, when, the people before and after (ids and names), and
--    the note they wrote.
CREATE TABLE booth_repoints (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id    INTEGER NOT NULL REFERENCES booth_tracks (id),
  member_id   INTEGER NOT NULL,                       -- team_members.id
  at          INTEGER NOT NULL,                       -- ms
  before_json TEXT NOT NULL,                          -- [{ guest_id, name }]
  after_json  TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX booth_repoints_track ON booth_repoints (track_id, at);
