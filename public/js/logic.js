// Pure logic for the voting page: no DOM, no network. Everything here is unit-tested in
// tests/frontend.test.mjs, and the page's modules import it as it is.

// ── Share
// A track's own link. `origin` is the address the page is being read at, so a shared link always
// opens the same site the sharer was on.
export function trackLink(origin, slug) {
  return `${String(origin).replace(/\/+$/, "")}/#${slug}`;
}

export function shareMessage(label, link) {
  return `${label} wants you to vote on their track from the Top Barz experience ${link}`;
}

// "ios" | "android" | "desktop". iPadOS reports itself as a Mac with a touch screen.
export function detectPlatform(nav = {}) {
  const ua = String(nav.userAgent || "");
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (nav.platform === "MacIntel" && Number(nav.maxTouchPoints) > 1) return "ios";
  return "desktop";
}

// The link that opens the phone's text composer with the message filled in. iOS wants
// `sms:&body=`, Android wants `sms:?body=`. A desktop has no composer: null, and the page
// copies the link instead.
export function smsHref(platform, message) {
  const body = encodeURIComponent(message);
  if (platform === "ios") return `sms:&body=${body}`;
  if (platform === "android") return `sms:?body=${body}`;
  return null;
}

// ── Deep links
// "/#brian" → "brian". Anything that is not a slug (letters, digits, dashes) is null.
export function slugFromHash(hash) {
  let s = String(hash ?? "").replace(/^#/, "");
  try { s = decodeURIComponent(s); } catch { return null; }
  s = s.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,99}$/.test(s) ? s : null;
}

// ── The clock
// The countdown runs on the SERVER's time. Each answer from the server carries its clock
// (`now` in /api/state, and the Date header); between answers we add the time that has passed
// on a monotonic timer (performance.now), which the phone's wall clock cannot move.
// A cached answer is a little old, so every sample is a lower bound: keep whichever sample
// puts the server's clock furthest ahead.
export function serverTimeOf(nowIso, dateHeader) {
  const a = Date.parse(nowIso ?? "");
  const b = Date.parse(dateHeader ?? "");
  if (Number.isFinite(a) && Number.isFinite(b)) return Math.max(a, b);
  if (Number.isFinite(a)) return a;
  return Number.isFinite(b) ? b : null;
}

export function syncClock(clock, serverMs, monoMs) {
  if (!Number.isFinite(serverMs) || !Number.isFinite(monoMs)) return clock ?? null;
  if (!clock) return { serverMs, monoMs };
  return serverMs > serverNow(clock, monoMs) ? { serverMs, monoMs } : clock;
}

export function serverNow(clock, monoMs) {
  return clock ? clock.serverMs + (monoMs - clock.monoMs) : null;
}

// ── Countdown
export function countdownParts(ms) {
  const total = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
  return {
    days: Math.floor(total / 86400),
    hours: Math.floor((total % 86400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
    total,
  };
}

const two = (n) => String(n).padStart(2, "0");

// 9d 04h 03m 22s → 4h 03m 22s → 3m 22s → 22s. Zero or less is "0s" (the page says "Voting closed").
export function formatCountdown(ms) {
  const p = countdownParts(ms);
  if (p.days > 0) return `${p.days}d ${two(p.hours)}h ${two(p.minutes)}m ${two(p.seconds)}s`;
  if (p.hours > 0) return `${p.hours}h ${two(p.minutes)}m ${two(p.seconds)}s`;
  if (p.minutes > 0) return `${p.minutes}m ${two(p.seconds)}s`;
  return `${p.seconds}s`;
}

// What a screen reader hears (no seconds: it is read once a minute, not once a second).
export function countdownSpoken(ms) {
  const p = countdownParts(ms);
  if (p.total <= 0) return "Voting closed";
  const say = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const bits = [];
  if (p.days) bits.push(say(p.days, "day"));
  if (p.hours) bits.push(say(p.hours, "hour"));
  if (!p.days && p.minutes) bits.push(say(p.minutes, "minute"));
  if (!bits.length) return "Less than a minute left to vote";
  return `${bits.join(", ")} left to vote`;
}

// The end of voting in California time, as the page writes it: "Sunday, October 11 at 11:59 PM PDT".
export function formatEndsLine(endMs) {
  const d = new Date(endMs);
  if (Number.isNaN(d.getTime())) return "";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles", weekday: "long", month: "long", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short",
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  // A browser without zone names answers "GMT-7" for California daylight time.
  const zone = parts.timeZoneName === "GMT-7" ? "PDT" : parts.timeZoneName;
  return `${parts.weekday}, ${parts.month} ${parts.day} at ${parts.hour}:${parts.minute} ${parts.dayPeriod} ${zone}`;
}

// ── Likes: optimistic, one request at a time per track, never drifting from the server
// serverLiked / serverCount: the last thing the server confirmed.
// want:      what the voter last asked for, while the server has not confirmed it (else null).
// inflight:  a request for this track is on the wire (taps meanwhile only move `want`).
// holdUntil: a server time; /api/state answers generated before it predate our own like and are
//            ignored for this track, so the count never jumps back to a cached number.
export function likeInitial(serverCount = 0, serverLiked = false) {
  return { serverLiked: !!serverLiked, serverCount: Math.max(0, Number(serverCount) || 0), want: null, inflight: false, holdUntil: 0, error: null };
}

export function likeView(s) {
  const liked = s.want === null ? s.serverLiked : s.want;
  const count = Math.max(0, s.serverCount + (liked ? 1 : 0) - (s.serverLiked ? 1 : 0));
  return { liked, count, busy: s.inflight || s.want !== null, error: s.error };
}

// The request to send now, or null: nothing is sent while one is in flight, or when the server
// already agrees with the voter.
export function likeRequest(s) {
  if (s.inflight || s.want === null || s.want === s.serverLiked) return null;
  return { liked: s.want };
}

export function likeReduce(s, ev) {
  switch (ev.type) {
    case "tap": // flips what the voter sees
      return likeReduce(s, { type: "want", liked: !likeView(s).liked });
    case "want": { // asks for a state (the held like behind the gate asks for `true`)
      const want = ev.liked === s.serverLiked && !s.inflight ? null : !!ev.liked;
      return { ...s, want, error: null };
    }
    case "sent":
      return { ...s, inflight: true };
    case "confirmed": {
      const serverLiked = !!ev.liked;
      return {
        ...s, inflight: false, serverLiked,
        serverCount: Math.max(0, Number(ev.likes) || 0),
        want: s.want === null || s.want === serverLiked ? null : s.want,
        holdUntil: Math.max(s.holdUntil, Number(ev.holdUntil) || 0),
        error: null,
      };
    }
    case "failed": // roll back to what the server last confirmed, and say why
      return { ...s, inflight: false, want: null, error: ev.message || "That like was not saved." };
    case "poll": // a count from /api/state
      if (s.inflight || !(Number(ev.generatedAt) >= s.holdUntil)) return s;
      return { ...s, serverCount: Math.max(0, Number(ev.likes) || 0) };
    case "me": // the voter's own likes from /api/me or the gate
      if (s.inflight || s.want !== null) return s;
      return { ...s, serverLiked: !!ev.liked };
    case "clear-error":
      return s.error ? { ...s, error: null } : s;
    default:
      return s;
  }
}

// The server time before which a cached /api/state cannot contain a write we just made.
// The Date header is whole seconds, so the write happened no later than that second's end.
export function holdFrom(dateHeader, fallbackServerNow) {
  const d = Date.parse(dateHeader ?? "");
  if (Number.isFinite(d)) return d + 1000;
  return Number.isFinite(fallbackServerNow) ? fallbackServerNow + 6000 : 0;
}

// A like that has been on the wire this long shows that it is waiting (a spinner in the heart's
// place). Shorter than this and the answer is already back: a spinner would only flash.
export const LIKE_WAIT_MS = 400;

// ── What this device itself just changed
// /api/state is cached for a few seconds, so straight after a voter's own like or comment a
// refresh (or a second tab) can be handed a count from before it. The page keeps the server's
// own answer to that like or comment, with the server time before which a cached state cannot
// contain it (holdFrom), and shows that number until a newer state arrives. Counts only.
export const OWN_KEEP_MS = 60_000;

// own: { [slug]: { likes?, comments?, until, saved_at } } → the same, with this change added.
export function rememberOwn(own, slug, patch, until, now) {
  const next = pruneOwn(own, now);
  if (typeof slug !== "string" || !Number.isFinite(until) || until <= 0) return next;
  const entry = { ...(next[slug] ?? {}), until: Math.max(next[slug]?.until ?? 0, until), saved_at: now };
  for (const key of ["likes", "comments"]) {
    if (Number.isFinite(Number(patch?.[key])) && patch[key] !== null && patch[key] !== undefined) entry[key] = Math.max(0, Math.floor(Number(patch[key])));
  }
  return { ...next, [slug]: entry };
}

// The remembered counts for a track, or null once a state built at `generatedAt` is new enough
// to contain them (or nothing is remembered).
export function readOwn(own, slug, generatedAt, now) {
  const entry = pruneOwn(own, now)[slug];
  if (!entry || !(Number(generatedAt) < entry.until)) return null;
  return { likes: entry.likes ?? null, comments: entry.comments ?? null, until: entry.until };
}

// Only well-formed entries younger than a minute survive; anything else stored is ignored.
export function pruneOwn(own, now) {
  const out = {};
  if (!own || typeof own !== "object") return out;
  for (const [slug, e] of Object.entries(own)) {
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug) || !e || typeof e !== "object") continue;
    if (!Number.isFinite(e.until) || !Number.isFinite(e.saved_at) || now - e.saved_at > OWN_KEEP_MS || e.saved_at > now + 60_000) continue;
    const entry = { until: e.until, saved_at: e.saved_at };
    if (Number.isFinite(e.likes) && e.likes >= 0) entry.likes = Math.floor(e.likes);
    if (Number.isFinite(e.comments) && e.comments >= 0) entry.comments = Math.floor(e.comments);
    out[slug] = entry;
  }
  return out;
}

// ── The rules line about the end of voting
// "Voting ends …" while it is open; once it has closed the page must not promise a future end.
export function rulesEndLine(closed, endsLine) {
  return `${closed ? "Voting ended" : "Voting ends"} ${endsLine}.`;
}

// ── A very long comment
// More than 8 lines, or more than 320 characters: the page shows the start and a "Show all".
export const COMMENT_FOLD_LINES = 8;
export const COMMENT_FOLD_CHARS = 320;
export function isLongComment(text) {
  const t = String(text ?? "");
  return t.length > COMMENT_FOLD_CHARS || t.split("\n").length > COMMENT_FOLD_LINES;
}

// ── The photo strip from a keyboard
// The strip is ONE Tab stop however many photos it holds: arrow keys move between photos.
// → the photo to focus next, or null when the key is not one of the strip's.
export function stripTarget(index, key, count) {
  if (!(count > 0)) return null;
  const i = Math.min(Math.max(0, Number(index) || 0), count - 1);
  if (key === "ArrowRight") return Math.min(count - 1, i + 1);
  if (key === "ArrowLeft") return Math.max(0, i - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

// ── Polling
export const POLL_MS = 7000;
// After a failed poll: try again soon, then ease off. Never slower than 15 s.
export function nextPollDelay(failures) {
  if (!failures) return POLL_MS;
  return [3000, 6000, 10000][failures - 1] ?? 15000;
}

// ── The gate
const tidy = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

// → { field: "message that names the field" }, empty when the form can be sent.
export function validateGate({ name, email, city } = {}) {
  const fields = {};
  if (!tidy(name)) fields.name = "Enter your name.";
  const e = tidy(email).toLowerCase();
  if (!e) fields.email = "Enter your email.";
  else if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[a-z]{2,}$/.test(e)) fields.email = "That email does not look right. Check it and try again.";
  if (!tidy(city)) fields.city = "Enter your city.";
  return fields;
}

export function gatePayload({ name, email, city, optIn, website } = {}) {
  return {
    name: tidy(name),
    email: tidy(email).toLowerCase(),
    city: tidy(city),
    marketing_opt_in: optIn === true,
    website: String(website ?? ""),
  };
}

// What the browser remembers about a voter: the signed token and a first name. Never the email.
export function voterRecord(response) {
  const token = response?.token;
  if (typeof token !== "string" || !isVoterToken(token)) return null;
  const first = response?.voter?.first_name;
  return { token, first_name: typeof first === "string" ? first.slice(0, 30) : "" };
}

export function isVoterToken(token) {
  return typeof token === "string" && /^v1\.[1-9][0-9]{0,14}\.[A-Za-z0-9_-]{43}$/.test(token);
}

// ── The email code
// What the field holds: digits only, six at most. So a pasted "123 456" or "123-456" is the code.
export function codeDigits(value) {
  return String(value ?? "").replace(/[^0-9]/g, "").slice(0, 6);
}

// A voter part-way through the code step is remembered for an hour, then forgotten.
export const PENDING_KEEP_MS = 60 * 60 * 1000;

// The action a reload can pick up again: a like or a share (never a comment's words).
export function heldToKeep(action) {
  if (!action || (action.type !== "like" && action.type !== "share")) return null;
  if (typeof action.slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(action.slug)) return null;
  return action.type === "like" ? { type: "like", slug: action.slug, liked: action.liked !== false } : { type: "share", slug: action.slug };
}

// What the browser keeps while the code is awaited: what was typed at the gate (so "send a new
// code" needs no retyping) and when a new code may be asked for and the code runs out, on this
// device's clock. NEVER the code. `answer` is the gate's code_sent answer.
export function pendingRecord(payload, answer, now, held = null) {
  if (answer?.verification !== "code_sent") return null;
  const email = tidy(payload?.email).toLowerCase();
  if (!email) return null;
  const seconds = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : fallback);
  return {
    email, name: tidy(payload.name), city: tidy(payload.city), marketing_opt_in: payload.marketing_opt_in === true,
    resend_at: now + seconds(answer.resend_in_seconds, 60) * 1000,
    expires_at: now + seconds(answer.expires_in_seconds, 600) * 1000,
    saved_at: now, held: heldToKeep(held), dismissed: false,
  };
}

// What was stored → a record to trust, or null (not ours, damaged, or older than an hour).
// Only the known keys are read, so nothing else that was stored (a code, say) is ever used.
export function readPending(rec, now) {
  if (!rec || typeof rec !== "object") return null;
  const text = (v) => (typeof v === "string" ? tidy(v) : "");
  const email = text(rec.email).toLowerCase();
  const times = [rec.resend_at, rec.expires_at, rec.saved_at];
  if (!email || !text(rec.name) || !text(rec.city) || !times.every((t) => Number.isFinite(t))) return null;
  if (now - rec.saved_at > PENDING_KEEP_MS || rec.saved_at > now + 60_000) return null;
  return {
    email, name: text(rec.name), city: text(rec.city), marketing_opt_in: rec.marketing_opt_in === true,
    resend_at: rec.resend_at, expires_at: rec.expires_at, saved_at: rec.saved_at,
    held: heldToKeep(rec.held), dismissed: rec.dismissed === true,
  };
}

// Whole seconds until `at` (0 = now or past).
export function secondsUntil(at, now) {
  return Math.max(0, Math.ceil((at - now) / 1000));
}

export function resendLabel(seconds) {
  return seconds > 0 ? `Send a new code in ${seconds} s` : "Send a new code";
}

// ── Small formatters
// 65.1 → "1:05"
export function formatClock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${two(s % 60)}`;
}

export function formatCount(n) {
  return Math.max(0, Math.floor(Number(n) || 0)).toLocaleString("en-US");
}

export function plural(n, one, many = `${one}s`) {
  return `${formatCount(n)} ${Number(n) === 1 ? one : many}`;
}

// "just now", "5m", "3h", "2d", then a date ("Oct 5").
export function relativeTime(createdMs, nowMs) {
  if (!Number.isFinite(createdMs)) return "";
  const s = Math.max(0, Math.floor(((Number.isFinite(nowMs) ? nowMs : createdMs) - createdMs) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" }).format(new Date(createdMs));
}

// A GIF is only ever loaded from Giphy over https. Anything else is not shown.
export function safeGifUrl(url) {
  if (typeof url !== "string" || url.length > 500) return null;
  try {
    const u = new URL(url);
    if (u.protocol === "https:" && (u.hostname === "giphy.com" || u.hostname.endsWith(".giphy.com"))) return u.toString();
  } catch {}
  return null;
}

// Media from /api/state is same-origin (/media/…). Anything else is not loaded.
export function safeMediaUrl(url) {
  return typeof url === "string" && /^\/media\/[A-Za-z0-9/_.-]+$/.test(url) && !url.includes("..") ? url : null;
}

// ── Display order
// Most-liked first ON SCREEN only (Top Barz, 3 Oct 2026): a sorted copy of what the server sent,
// highest like count first, the server's order among equals. Counting is untouched.
export function displayOrder(tracks) {
  return (Array.isArray(tracks) ? tracks : [])
    .map((t, i) => ({ t, i, n: Math.max(0, Number(t?.likes)) || 0 }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map((x) => x.t);
}
// A reorder waits until the page has been still (no touch, scroll or key) for this long, so a
// card never moves under a thumb. Monotonic ms; null = never touched.
export const REORDER_STILL_MS = 2500;
export const canReorder = (lastInput, now) => lastInput == null || now - lastInput >= REORDER_STILL_MS;
