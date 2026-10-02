-- voting.topbarz.xyz: tracks, voters, likes (as events), comments, and the small tables the
-- anti-abuse limits and the Giphy proxy need. Timestamps are ISO-8601 UTC strings.

CREATE TABLE tracks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,              -- the deep link: /#<slug>
  label       TEXT NOT NULL,                     -- shown on the card: first name, later an IG handle
  source_name TEXT NOT NULL UNIQUE,              -- the file's base name ("Jane Doe"); never returned by the API
  audio_key   TEXT NOT NULL,                     -- R2 key, served at /media/<audio_key>
  duration_ms INTEGER,
  sort        INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE voters (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  email            TEXT NOT NULL UNIQUE CHECK (email = lower(trim(email))),
  -- One account per mailbox: the email with any +tag removed (and dots removed for Gmail).
  email_key        TEXT NOT NULL UNIQUE,
  city             TEXT NOT NULL,
  marketing_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (marketing_opt_in IN (0, 1)),
  created_at       TEXT NOT NULL,                -- the voter's first interaction (the gate)
  flagged          INTEGER NOT NULL DEFAULT 0 CHECK (flagged IN (0, 1)),
  flag_reason      TEXT,
  ip_hash          TEXT
);
CREATE INDEX voters_flagged ON voters (id) WHERE flagged = 1;

-- Every like AND every un-like is a row, in order. A voter's state on a track is their newest
-- row; a track's count is likes minus un-likes; the tie-break replays the rows in id order.
CREATE TABLE like_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  voter_id   INTEGER NOT NULL REFERENCES voters (id),
  track_id   INTEGER NOT NULL REFERENCES tracks (id),
  action     TEXT NOT NULL CHECK (action IN ('like', 'unlike')),
  created_at TEXT NOT NULL
);
CREATE INDEX like_events_track ON like_events (track_id, voter_id, action);
CREATE INDEX like_events_voter ON like_events (voter_id, track_id, id);

-- The PRD's "likes (voter, track, created at, removed at)" shape, derived from the events.
CREATE VIEW likes AS
SELECT l.voter_id, l.track_id, l.created_at,
       (SELECT MIN(u.created_at) FROM like_events u
         WHERE u.voter_id = l.voter_id AND u.track_id = l.track_id AND u.action = 'unlike' AND u.id > l.id) AS removed_at
FROM like_events l WHERE l.action = 'like';

CREATE TABLE comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  voter_id   INTEGER NOT NULL REFERENCES voters (id),
  track_id   INTEGER NOT NULL REFERENCES tracks (id),
  body       TEXT NOT NULL DEFAULT '',
  gif_id     TEXT,
  gif_url    TEXT,
  created_at TEXT NOT NULL,
  hidden     INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1))
);
CREATE INDEX comments_track ON comments (track_id, hidden, id);

-- Fixed-window counters: key = "<what>:<who>", window_start = epoch seconds of the window.
CREATE TABLE rate_limits (
  key          TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
) WITHOUT ROWID;

-- Giphy proxy: results by search term (shared by every edge location), and one row per upstream
-- call so the site-wide 100 calls/hour budget is counted over a true rolling hour.
CREATE TABLE giphy_cache (
  term       TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE giphy_calls (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  called_at INTEGER NOT NULL
);
CREATE INDEX giphy_calls_at ON giphy_calls (called_at);

-- Operator switches. `voting_ends_at` is read only where ALLOW_END_OVERRIDE = "1" (preview).
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
