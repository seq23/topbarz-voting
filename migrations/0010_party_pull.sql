-- The team's safety valve on auto-entry (the plan's red flag 3, 17 Nov 2026): a signed-in team
-- member can take a song out of the vote from /team. A pulled song stays out even if everyone on
-- it ticks again, until the team puts it back. Additive only; likes are kept, nothing is deleted.
ALTER TABLE booth_tracks ADD COLUMN pulled_at INTEGER;
ALTER TABLE booth_tracks ADD COLUMN pulled_by INTEGER;
