-- Email verification: the 6-digit code. See functions/_lib/verify.js and RUNBOOK.md.

-- A voter is verified once they have entered a code sent to their email. Everyone else carries
-- the reason they are not:
--   before_verification  signed up before the code existed (every row already here)
--   pending              was sent a code and has never been let in: has no token
--   mail_budget          let in without a code: the daily send budget was spent
--   mail_error           let in without a code: the mail service refused or could not be reached
--   verification_off     signed up while the switch was off
ALTER TABLE voters ADD COLUMN verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1));
ALTER TABLE voters ADD COLUMN verified_at TEXT;
ALTER TABLE voters ADD COLUMN unverified_reason TEXT DEFAULT 'before_verification';
UPDATE voters SET unverified_reason = 'before_verification' WHERE verified = 0;

-- The one live code per voter. Only an HMAC of the code is kept, never the code.
CREATE TABLE email_codes (
  voter_id   INTEGER PRIMARY KEY REFERENCES voters (id),
  code_hmac  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,                   -- epoch seconds
  attempts   INTEGER NOT NULL DEFAULT 0          -- tries used, right or wrong
) WITHOUT ROWID;

-- One row per code email handed to the mail service, so the daily budget (the mail account is
-- shared), the per-email hourly cap and the resend cooldown are counted over true rolling
-- windows. counted = 0: the service refused it outright, so nothing was sent.
CREATE TABLE email_sends (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  voter_id INTEGER NOT NULL REFERENCES voters (id),
  sent_at  INTEGER NOT NULL,                     -- epoch seconds
  counted  INTEGER NOT NULL DEFAULT 1 CHECK (counted IN (0, 1))
);
CREATE INDEX email_sends_at ON email_sends (sent_at);
CREATE INDEX email_sends_voter ON email_sends (voter_id, sent_at);

-- Can this domain receive mail (MX, or A as the fallback)? One DNS lookup per domain, kept here.
CREATE TABLE mail_domains (
  domain     TEXT PRIMARY KEY,
  receives   INTEGER NOT NULL CHECK (receives IN (0, 1)),
  checked_at INTEGER NOT NULL                    -- epoch seconds
) WITHOUT ROWID;
