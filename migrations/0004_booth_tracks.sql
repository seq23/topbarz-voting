-- The booth: a finished recording an engineer hands back to the rapper by a 4-digit code
-- (/booth uploads, /track looks up). Its own table, never part of the vote: nothing here is read
-- by /api/state, the tally, the export or /api/beats, and no like or comment can point at a booth
-- track. Written by POST /api/booth/tracks, read by the booth routes and scripts/booth-log.mjs only.

CREATE TABLE booth_tracks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL UNIQUE,           -- the 4 digits the rapper types; never reused
  file_name      TEXT NOT NULL,                  -- the engineer's file name, sanitised
  content_type   TEXT,
  size           INTEGER,                        -- bytes
  media_key      TEXT NOT NULL UNIQUE,           -- R2 key (booth/<code>-<random>.<ext>), served at /media/<media_key>
  uploaded_at    INTEGER NOT NULL,               -- ms since the epoch
  opened         INTEGER NOT NULL DEFAULT 0,     -- how many times the code was looked up
  last_opened_at INTEGER
);
CREATE INDEX booth_tracks_newest ON booth_tracks (uploaded_at DESC, id DESC);
