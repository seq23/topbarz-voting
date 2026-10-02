-- voting.topbarz.xyz/select: the beats people hear and pick from. Their own table, never part of
-- the vote: nothing here is read by /api/state, the tally or the export, and no like or comment
-- can point at a beat. Loaded by scripts/load-beats.mjs, returned by GET /api/beats.

CREATE TABLE beats (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT NOT NULL UNIQUE,              -- what the browser remembers as the pick
  name         TEXT NOT NULL,                     -- shown on the row
  source_name  TEXT NOT NULL UNIQUE,              -- the file's base name, never returned by the API
  audio_key    TEXT NOT NULL,                     -- R2 key (beats/...), served at /media/<audio_key>
  duration_ms  INTEGER,
  sort         INTEGER NOT NULL DEFAULT 0,        -- order on the page, lowest first
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  -- 1 = a stand-in made from a test file. Preview and local only: production never returns one.
  stand_in     INTEGER NOT NULL DEFAULT 0 CHECK (stand_in IN (0, 1)),
  credit_label TEXT,                              -- optional: who made it
  credit_url   TEXT,                              -- optional: their link (https only)
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX beats_order ON beats (active, sort, id);
