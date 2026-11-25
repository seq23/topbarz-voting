-- A resent code no longer kills the one before it (Scooter, 18 Nov 2026: "Please look at the
-- code-sending on the preview ... so I can get back in"). Mail can be slow: someone taps "Send me a
-- new code", then the FIRST email arrives and its code was already replaced, so it answers "That
-- code is not right" and the tries run out. Each table now keeps the code before the newest one
-- while it is still within its own 10 minutes; either one signs in, once, and the tries are shared.
-- Additive only.
ALTER TABLE team_codes ADD COLUMN prev_code_hmac TEXT;
ALTER TABLE team_codes ADD COLUMN prev_expires_at INTEGER;   -- epoch seconds; NULL = no earlier code
ALTER TABLE email_codes ADD COLUMN prev_code_hmac TEXT;
ALTER TABLE email_codes ADD COLUMN prev_expires_at INTEGER;  -- epoch seconds; NULL = no earlier code
