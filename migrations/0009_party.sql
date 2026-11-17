-- The holiday party (Scooter, 17 Nov 2026): a jingle contest at a partner bar, on the booth flow.
-- Additive only. Behind the HOLIDAY_EVENT switch (wrangler.toml): on for preview, off for
-- production until Scooter says go. See RUNBOOK.md, "The holiday party".
--
-- The line. Everyone signs up on their own phone at /join (name, phone, email, city, Instagram);
-- friends join one booth SESSION by its 4-letter code, and the team moves a session through the
-- line on /team: waiting → booth (green) → out (red). Guest details are read by the signed-in
-- team only; no public route answers a name, a phone number or an email.
CREATE TABLE party_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,                   -- 4 letters, no look-alikes (functions/_lib/party.js)
  created_at  INTEGER NOT NULL,                       -- ms; the place in line
  status      TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'booth', 'out')),
  status_at   INTEGER,                                -- ms, the last status change
  texted_at   INTEGER                                 -- ms, the last "Text them" a team member recorded
);
CREATE INDEX party_sessions_line ON party_sessions (status, created_at);

CREATE TABLE party_guests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES party_sessions (id),
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,
  email       TEXT NOT NULL UNIQUE,                   -- lower-cased (booth.js cleanEmail): one sign-up per email
  city        TEXT NOT NULL,
  instagram   TEXT NOT NULL DEFAULT '',
  guest_key   TEXT NOT NULL UNIQUE,                   -- 24 random hex, kept on the guest's own phone: how they move to another session
  joined_at   INTEGER NOT NULL,                       -- ms
  ip_hash     TEXT
);
CREATE INDEX party_guests_session ON party_guests (session_id, joined_at);

-- Every status change is a row, never deleted: who moved which session, from what to what.
CREATE TABLE party_status_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES party_sessions (id),
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  member_id   INTEGER NOT NULL,
  at          INTEGER NOT NULL
);

-- The team: who may sign in to /team (an emailed 6-digit code, the vote's own mail). The list is
-- data, never in the repo; the first member is added by `npm run add-team`.
CREATE TABLE team_members (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL UNIQUE,
  added_at    INTEGER NOT NULL,
  added_by    INTEGER,                                -- team_members.id, NULL for the script
  removed_at  INTEGER                                 -- a removed member cannot sign in; the row stays
);
CREATE TABLE team_codes (
  member_id   INTEGER PRIMARY KEY REFERENCES team_members (id),
  code_hmac   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,                       -- epoch seconds
  attempts    INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
-- Team code emails count against the same daily mail budget as the voters' codes (verify.js).
CREATE TABLE team_code_sends (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id   INTEGER NOT NULL REFERENCES team_members (id),
  sent_at     INTEGER NOT NULL,                       -- epoch seconds
  counted     INTEGER NOT NULL DEFAULT 1 CHECK (counted IN (0, 1))
);
CREATE INDEX team_code_sends_at ON team_code_sends (sent_at);

-- Gallery GIFs the team picks from Giphy, shown until event photos exist. Removing one keeps the row.
CREATE TABLE party_gifs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  giphy_id    TEXT NOT NULL UNIQUE,
  url         TEXT NOT NULL,
  width       INTEGER,
  height      INTEGER,
  title       TEXT NOT NULL DEFAULT '',
  added_at    INTEGER NOT NULL,
  removed_at  INTEGER
);

-- The song flow. A booth track can be tagged with the session in the booth at upload; it can
-- carry a title anyone on it sets; and it remembers the vote track it became (auto-entry).
ALTER TABLE booth_tracks ADD COLUMN party_session_id INTEGER;
ALTER TABLE booth_tracks ADD COLUMN title TEXT;
ALTER TABLE booth_tracks ADD COLUMN vote_track_id INTEGER;
-- Each person's own "Enter the contest" box, with when they agreed to the rules and which rules.
ALTER TABLE booth_people ADD COLUMN contest_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (contest_opt_in IN (0, 1));
ALTER TABLE booth_people ADD COLUMN contest_at INTEGER;
ALTER TABLE booth_people ADD COLUMN rules_version TEXT;
