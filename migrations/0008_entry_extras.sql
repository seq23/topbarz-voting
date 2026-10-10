-- The contest entry, after Scooter's preview review (9 Oct 2026): the entrant's Instagram handle(s)
-- and an optional title for the track (a suggestion, for review; the vote's label is still the
-- first name). Both are optional and kept as typed (control characters out). Like the rest of
-- the entry they are in this table and in exports/entries.csv only: no route answers them.
ALTER TABLE entries ADD COLUMN instagram TEXT NOT NULL DEFAULT '';
ALTER TABLE entries ADD COLUMN track_title TEXT NOT NULL DEFAULT '';
