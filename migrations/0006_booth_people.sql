-- The booth's people (the client's ask, 4 Oct 2026): on /track the code is entered WITH an email,
-- and every email that enters a code is attached to that track. A group each enter their own email
-- with the same code, and that is how everyone is attached to their song. Anyone attached can make
-- the song public ("share is anyone's call"); the song reaches the voting site only when every
-- person attached has opted in ("voting is everyone's consent"), and only through
-- scripts/promote-booth.mjs. Emails live in this table and in exports/booth-people.csv only: no API
-- answers another person's email, and the engineer's page shows a count. Still never part of the
-- vote (tests/booth.test.mjs).
--   track_id     the booth track (booth_tracks.id)
--   email        lower-cased and trimmed; one row per (track, email), so the same person entering
--                again is the same person
--   attached_at  ms since the epoch, the first time this email entered the code
--   vote_opt_in  0 or 1: this person's own consent to the public vote (POST …/<code>/vote)
--   opted_at     ms since the epoch when they opted in; NULL while out

CREATE TABLE booth_people (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id     INTEGER NOT NULL REFERENCES booth_tracks(id),
  email        TEXT NOT NULL,
  attached_at  INTEGER NOT NULL,
  vote_opt_in  INTEGER NOT NULL DEFAULT 0 CHECK (vote_opt_in IN (0, 1)),
  opted_at     INTEGER,
  UNIQUE (track_id, email)
);
CREATE INDEX booth_people_track ON booth_people (track_id);
