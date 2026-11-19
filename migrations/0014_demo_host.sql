-- RETIRED the same day (19 Nov 2026). It held a "host" email that ran the preview's demo song
-- without being on it; that let Scooter Taylor's own email manage a song in the vote, which the
-- Scooter Taylor rule (functions/_lib/exclusions.js) forbids, so the routes no longer read it.
-- Kept because it was applied to the preview database (migrations are additive only).
-- scripts/demo-song.mjs sets it back to NULL on every reset; no code reads it.
ALTER TABLE booth_tracks ADD COLUMN host_email TEXT;
