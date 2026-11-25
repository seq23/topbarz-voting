-- The preview's demo song (Scooter, 19 Nov 2026: "Please make sure I can use my own access to take a
-- song through contest entry and see it appear on the voting page"). Additive only.
--
-- The host: one email that holds the song's controls (artwork, title, Enter the contest, Share)
-- without being one of its people, so the song is still nobody's but its singer's (a song with
-- Scooter Taylor on it never goes in the vote). Set only by scripts/demo-song.mjs, on the preview;
-- the routes ignore it on production. NULL on every other song.
ALTER TABLE booth_tracks ADD COLUMN host_email TEXT;
