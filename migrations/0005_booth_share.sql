-- The booth's share (4 Oct 2026): a rapper can make their track public from /track, which gives
-- it a listen page at /listen/<share_id>, and can add album artwork. Three columns on the booth's
-- own table, nothing else: still never part of the vote (tests/booth.test.mjs).
--   public    0 (the default for every track, old and new) or 1; set by POST /api/booth/tracks/<code>/public
--   share_id  16 random hex characters, never the code and never made from it; given on the first
--             publish (or at upload); the only way to a listen page. UNIQUE through its index
--             (SQLite cannot add a UNIQUE column to an existing table).
--   art_key   R2 key of the artwork (booth/art/<random>-<hash>.jpg), served at /media/<art_key>; NULL = none

ALTER TABLE booth_tracks ADD COLUMN public INTEGER NOT NULL DEFAULT 0;
ALTER TABLE booth_tracks ADD COLUMN share_id TEXT;
ALTER TABLE booth_tracks ADD COLUMN art_key TEXT;
CREATE UNIQUE INDEX booth_tracks_share_id ON booth_tracks (share_id);
