// The voting window. THE ONE PLACE the end time is written: Sunday 11 Oct 2026, 11:59 PM PDT.
// tests/config.test.mjs fails if this literal appears in any other source file.
export const VOTING_ENDS_AT = "2026-10-12T06:59:00Z";
// … and THE ONE PLACE the start time is written: Sunday 11 Oct 2026, 10:00 AM ET (EDT, UTC-4).
// Scooter, 9 Oct 2026: "Voting starts Sunday, October 11, at 10am ET." Before it the server
// refuses likes and comments (403 voting_not_open). tests/window.test.mjs fails if this literal
// appears in any other source file.
export const VOTING_STARTS_AT = "2026-10-11T14:00:00Z";

// Limits. Windows are seconds.
export const LIMITS = {
  gatePerIp: { window: 3600, max: 40 },
  gatePerEmail: { window: 3600, max: 10 },
  likesPerIp: { window: 60, max: 240 },
  likesPerVoter: { window: 60, max: 60 },
  commentsPerIp: { window: 3600, max: 120 },
  commentsPerVoter: { window: 300, max: 10 },
  giphyPerIp: { window: 60, max: 30 },
  verifyPerIp: { window: 600, max: 40 },
  // The booth (functions/api/booth): uploads per engineer's connection and for the whole site per
  // day; the log; and code lookups, so a code cannot be guessed by trying them all.
  boothUploadsPerIp: { window: 3600, max: 60 },
  boothUploadsPerDay: { window: 86400, max: 300 },
  boothLogPerIp: { window: 60, max: 60 },
  boothLookupPerMinute: { window: 60, max: 5 },
  boothLookupPerHour: { window: 3600, max: 30 },
  // The share (4 Oct 2026): the public switch and artwork uploads from /track (one counter), and
  // listen-page lookups. A wrong code on a share route counts as a lookup try (the limits above).
  boothEditsPerMinute: { window: 60, max: 30 },
  boothListenPerMinute: { window: 60, max: 30 },
  // The contest entry (9 Oct 2026, /entry): audio uploads per connection and for the whole site per
  // day, and the entry form itself per connection.
  entryUploadsPerIp: { window: 3600, max: 10 },
  entryUploadsPerDay: { window: 86400, max: 300 },
  entriesPerIp: { window: 3600, max: 10 },
};
export const COMMENT_MAX_CHARS = 500;
export const NAME_MAX_CHARS = 80;
export const STATE_CACHE_SECONDS = 5;

// Giphy beta key: 100 upstream calls per hour for the whole site. We stop at 90 in any rolling hour.
export const GIPHY = { budgetPerHour: 90, searchTtl: 30 * 60, trendingTtl: 60 * 60, pageSize: 12, rating: "pg-13" };

// Email verification (the 6-digit code; functions/_lib/verify.js). The mail account is shared with
// another business and allows 100 emails a day, so voting sends AT MOST 50 code emails in any
// rolling 24 hours. THE ONE PLACE that number is written. Times are seconds unless named ms.
export const VERIFICATION = {
  dailySendBudget: 50,
  previewSendShare: 5, // of the 50: what staging / preview may send. Production gets the rest.
  codeTtl: 10 * 60,
  maxTries: 5,
  resendCooldown: 60,
  sendsPerEmailPerHour: 3,
  // The sending domain decides inbox or spam (measured 2 Oct 2026, see RUNBOOK "Sender and spam").
  // The Resend key is tied to this one domain: change both together.
  from: "Top Barz Voting <topbarz@joinwestpeek.com>",
  resendEndpoint: "https://api.resend.com/emails",
  dohEndpoint: "https://cloudflare-dns.com/dns-query",
  domainOkTtl: 7 * 24 * 3600,
  domainBadTtl: 3600,
  sendTimeoutMs: 8000,
  dnsTimeoutMs: 3000,
};

function parseTime(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) ? ms : null;
}

// The end time for this environment, in ms. Order: a `settings` row (only where the environment
// allows it — preview), then the env var VOTING_ENDS_AT, then the constant above.
export function votingEndsAtMs(env, settingsValue) {
  if (env?.ALLOW_END_OVERRIDE === "1") {
    const fromSettings = parseTime(settingsValue);
    if (fromSettings !== null) return fromSettings;
  }
  const fromEnv = parseTime(env?.VOTING_ENDS_AT);
  if (fromEnv !== null) return fromEnv;
  return Date.parse(VOTING_ENDS_AT);
}

export const END_SETTING_SQL = "SELECT value FROM settings WHERE key = 'voting_ends_at'";

// The start time for this environment, in ms. The same order as the end time: a `settings` row
// (key voting_starts_at; only where the environment allows it, i.e. preview), then the env var
// VOTING_STARTS_AT (tests), then the constant above.
export function votingStartsAtMs(env, settingsValue) {
  if (env?.ALLOW_END_OVERRIDE === "1") {
    const fromSettings = parseTime(settingsValue);
    if (fromSettings !== null) return fromSettings;
  }
  const fromEnv = parseTime(env?.VOTING_STARTS_AT);
  if (fromEnv !== null) return fromEnv;
  return Date.parse(VOTING_STARTS_AT);
}
export const START_SETTING_SQL = "SELECT value FROM settings WHERE key = 'voting_starts_at'";

// Open means started and not ended. `now` before the start is "not_open"; at or after the end,
// "closed". The routes and /api/state all go through here, so there is one answer.
export function votingPhase(env, now, startSetting, endSetting) {
  const startsAt = votingStartsAtMs(env, startSetting);
  const endsAt = votingEndsAtMs(env, endSetting);
  return { startsAt, endsAt, closed: now >= endsAt, notOpen: now < startsAt && now < endsAt };
}

export async function votingWindow(env, now = Date.now()) {
  let settingsValue = null;
  if (env?.ALLOW_END_OVERRIDE === "1") {
    settingsValue = (await env.DB.prepare(END_SETTING_SQL).first())?.value ?? null;
  }
  const endsAt = votingEndsAtMs(env, settingsValue);
  return { endsAt, closed: now >= endsAt };
}

// Named states the front end (and a person reading /api/state) can see: nothing is silently off.
export function giphyStatus(env) {
  return env?.GIPHY_BETA_KEY ? { available: true } : { available: false, reason: "no_key" };
}
export function gateStatus(env) {
  return env?.VOTER_TOKEN_SECRET ? { available: true } : { available: false, reason: "token_secret_missing" };
}
// Production and preview count their sends in their own databases, so the daily budget is split
// between them: whatever happens on staging, the two together can never pass it.
export function sendBudget(env) {
  const { dailySendBudget, previewSendShare } = VERIFICATION;
  return env?.APP_ENV === "preview" ? previewSendShare : dailySendBudget - previewSendShare;
}

// The code step is on only when the switch says so AND there is a key to send mail with.
// Otherwise the gate behaves exactly as it did before codes existed.
export function verificationStatus(env) {
  if (env?.EMAIL_VERIFICATION !== "on") return { available: false, reason: "switched_off" };
  if (!env?.RESEND_API_KEY) return { available: false, reason: "no_key" };
  return { available: true };
}
