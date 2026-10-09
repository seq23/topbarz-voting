-- The contest entry (Scooter, 9 Oct 2026, /entry): the opt-in form for the Top Barz CultureCon
-- contest. Its own tables, never part of the vote: nothing here is read by /api/state, the tally,
-- /api/beats or the booth routes, and no like or comment can point at an entry. An entry reaches
-- the vote only through scripts/promote-entry.mjs. Names, emails and phones live in these tables
-- and in exports/entries.csv and exports/entry-members.csv only: no route answers any of them.
--   entry_uploads  step 1: a raw audio file streamed into R2 (entries/<random>.<ext>). The id is
--                  the one-time upload id the form sends back with its fields. Never served: the
--                  media route does not take the entries/ folder.
--   entries        step 2: the fields. upload_id is UNIQUE, so one upload is one entry, even when
--                  two submissions race.
--   entry_members  the other people in a group recording (first name, last name, email each).

CREATE TABLE entry_uploads (
  id           TEXT PRIMARY KEY,               -- 24 random hex characters
  file_name    TEXT NOT NULL,                  -- the file's name, sanitised (booth rules)
  content_type TEXT,
  size         INTEGER NOT NULL,               -- bytes
  media_key    TEXT NOT NULL UNIQUE,           -- R2 key: entries/<id>.<ext>
  created_at   INTEGER NOT NULL                -- ms since the epoch
);

CREATE TABLE entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,   -- the entry number the entrant is shown
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL,
  city            TEXT NOT NULL,
  email           TEXT NOT NULL,                       -- lower-cased and trimmed
  phone           TEXT NOT NULL,
  in_group        INTEGER NOT NULL CHECK (in_group IN (0, 1)),
  rules_agreed_at INTEGER NOT NULL,                    -- ms since the epoch: the box was ticked
  upload_id       TEXT NOT NULL UNIQUE REFERENCES entry_uploads(id),
  created_at      INTEGER NOT NULL                     -- ms since the epoch
);
CREATE INDEX entries_email ON entries (email);

CREATE TABLE entry_members (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id   INTEGER NOT NULL REFERENCES entries(id),
  first_name TEXT NOT NULL,
  last_name  TEXT NOT NULL,
  email      TEXT NOT NULL
);
CREATE INDEX entry_members_entry ON entry_members (entry_id);
