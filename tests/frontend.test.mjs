// The page in public/: its pure logic (public/js/logic.js, imported as the browser imports it),
// and the copy and wiring rules, read from the shipped HTML and JS.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { VERIFICATION, VOTING_ENDS_AT } from "../functions/_lib/config.js";
import {
  PENDING_KEEP_MS, codeDigits, heldToKeep, pendingRecord, readPending, resendLabel, secondsUntil,
  countdownParts, countdownSpoken, detectPlatform, formatClock, formatCountdown, formatEndsLine, gatePayload, holdFrom,
  isVoterToken, likeInitial, likeReduce, likeRequest, likeView, nextPollDelay, POLL_MS, relativeTime, safeGifUrl,
  safeMediaUrl, serverNow, serverTimeOf, shareMessage, slugFromHash, smsHref, syncClock, trackLink, validateGate, voterRecord,
  COMMENT_FOLD_CHARS, COMMENT_FOLD_LINES, LIKE_WAIT_MS, OWN_KEEP_MS, isLongComment, pruneOwn, readOwn, rememberOwn, rulesEndLine, stripTarget,
  REORDER_STILL_MS, canReorder, displayOrder,
} from "../public/js/logic.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const read = (rel) => fs.readFileSync(path.join(PUBLIC, rel), "utf8");
function shipped(ext) {
  const out = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (ext.test(f.name)) out.push(path.relative(PUBLIC, p));
    }
  };
  walk(PUBLIC);
  return out;
}
const HTML = shipped(/\.html$/);
const JS = shipped(/\.js$/);
const TOKEN = `v1.42.${"a".repeat(43)}`;

// ── Share ────────────────────────────────────────────────────────────────────────────────────
test("share: the message is '<label> wants you to vote on their track from the Top Barz experience' + the track's link", () => {
  const link = trackLink("https://voting.topbarz.xyz", "brian");
  assert.equal(link, "https://voting.topbarz.xyz/#brian");
  assert.equal(trackLink("https://staging.topbarz-voting.pages.dev/", "jane-r"), "https://staging.topbarz-voting.pages.dev/#jane-r", "the link is on the site the sharer is on");
  assert.equal(shareMessage("Brian", link), "Brian wants you to vote on their track from the Top Barz experience https://voting.topbarz.xyz/#brian");
  assert.equal(shareMessage("@handle", link).startsWith("@handle wants you to vote on their track"), true, "'their': no pronoun is collected");
});

test("share: iOS and Android get their own sms: form; a desktop gets none (it copies the link)", () => {
  const message = shareMessage("Carlos & Damien", trackLink("https://voting.topbarz.xyz", "carlos-damien"));
  const ios = smsHref("ios", message);
  const android = smsHref("android", message);
  assert.ok(ios.startsWith("sms:&body="), "iOS: sms:&body=");
  assert.ok(android.startsWith("sms:?body="), "Android: sms:?body=");
  for (const href of [ios, android]) {
    const body = href.slice(href.indexOf("body=") + 5);
    assert.ok(!/[&#? ]/.test(body), "the body is fully encoded: an & or # in it cannot cut the message short");
    assert.equal(decodeURIComponent(body), message, "the composer opens with the whole message and the link");
  }
  assert.equal(smsHref("desktop", message), null);

  const iphone = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1", platform: "iPhone", maxTouchPoints: 5 };
  const ipad = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", platform: "MacIntel", maxTouchPoints: 5 };
  const mac = { ...ipad, maxTouchPoints: 0 };
  const pixel = { userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36", platform: "Linux armv81", maxTouchPoints: 5 };
  const windows = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36", platform: "Win32", maxTouchPoints: 0 };
  assert.equal(detectPlatform(iphone), "ios");
  assert.equal(detectPlatform(ipad), "ios", "an iPad says it is a Mac, with a touch screen");
  assert.equal(detectPlatform(pixel), "android");
  assert.equal(detectPlatform(mac), "desktop");
  assert.equal(detectPlatform(windows), "desktop");
  assert.equal(detectPlatform(), "desktop");
});

// ── Deep links ───────────────────────────────────────────────────────────────────────────────
test("deep link: /#<slug> names a track; anything that is not a slug is ignored", () => {
  assert.equal(slugFromHash("#brian"), "brian");
  assert.equal(slugFromHash("#Chelos-X-Madame-Prez-X-Cam"), "chelos-x-madame-prez-x-cam");
  assert.equal(slugFromHash("#jane%2Dr"), "jane-r");
  assert.equal(slugFromHash("jane-r"), "jane-r");
  for (const bad of ["", "#", "#-x", "#a b", "#<script>", "#../x", "#%E0%A4%A", "#tbz_tracks", `#${"a".repeat(101)}`, null, undefined]) {
    assert.equal(slugFromHash(bad), null, `not a slug: ${bad}`);
  }
});

// ── Countdown and the clock ──────────────────────────────────────────────────────────────────
test("countdown: days down to seconds, and zero at the end", () => {
  const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;
  assert.equal(formatCountdown(9 * D + 4 * H + 3 * M + 22 * S), "9d 04h 03m 22s");
  assert.equal(formatCountdown(D), "1d 00h 00m 00s");
  assert.equal(formatCountdown(4 * H + 3 * M + 2 * S), "4h 03m 02s");
  assert.equal(formatCountdown(3 * M + 2 * S), "3m 02s");
  assert.equal(formatCountdown(59 * S), "59s");
  assert.equal(formatCountdown(1), "1s", "the last partial second still shows 1s, not 0s");
  assert.equal(formatCountdown(0), "0s");
  assert.equal(formatCountdown(-5000), "0s");
  assert.equal(formatCountdown(NaN), "0s");
  assert.deepEqual(countdownParts(D + H + M + S), { days: 1, hours: 1, minutes: 1, seconds: 1, total: 90061 });
  assert.equal(countdownSpoken(2 * D + H + 5 * M), "2 days, 1 hour left to vote");
  assert.equal(countdownSpoken(H + 5 * M), "1 hour, 5 minutes left to vote");
  assert.equal(countdownSpoken(5 * M), "5 minutes left to vote");
  assert.equal(countdownSpoken(30 * S), "Less than a minute left to vote");
  assert.equal(countdownSpoken(0), "Voting closed");
});

test("the end of voting is written in California time, from the one end time in config.js", () => {
  assert.equal(formatEndsLine(Date.parse(VOTING_ENDS_AT)), "Sunday, October 11 at 11:59 PM PDT");
  assert.equal(formatEndsLine(NaN), "");
});

test("the clock is the server's: samples only move it forward, and the phone's wall clock is never read", () => {
  assert.equal(serverTimeOf("2026-10-05T16:00:00.500Z", "Mon, 05 Oct 2026 16:00:03 GMT"), Date.parse("2026-10-05T16:00:03Z"), "a cached body is older than the Date header");
  assert.equal(serverTimeOf("2026-10-05T16:00:00.500Z", null), Date.parse("2026-10-05T16:00:00.500Z"));
  assert.equal(serverTimeOf(undefined, "nonsense"), null);

  let clock = syncClock(null, 1_000_000, 50);
  assert.equal(serverNow(clock, 50), 1_000_000);
  assert.equal(serverNow(clock, 7050), 1_007_000, "between answers, time passes on the monotonic timer");
  // A cached answer (5 s old) arrives 7 s later: it would put the clock back, so it is ignored.
  clock = syncClock(clock, 1_002_000, 7050);
  assert.equal(serverNow(clock, 7050), 1_007_000);
  // A fresh answer that is ahead (the tab slept and the timer stood still) moves it forward.
  clock = syncClock(clock, 1_600_000, 8000);
  assert.equal(serverNow(clock, 8000), 1_600_000);
  assert.equal(syncClock(clock, NaN, 9000), clock);
  assert.equal(serverNow(null, 5), null);

  const logic = read("js/logic.js");
  assert.ok(!/Date\.now\(\)|new Date\(\)/.test(logic), "logic.js never reads the device clock");
  const app = read("js/app.js");
  assert.ok(!/Date\.now\(\)|new Date\(\)/.test(app), "app.js never reads the device clock");
  assert.match(app, /syncClock\(app\.clock, serverTimeOf\(data\.now, date\), mono\(\)\)/, "every /api/state answer feeds the clock");
});

// ── Likes ────────────────────────────────────────────────────────────────────────────────────
test("like: flips at once, sends one request, and settles on the server's answer", () => {
  let s = likeInitial(12, false);
  assert.deepEqual(likeView(s), { liked: false, count: 12, busy: false, error: null });
  s = likeReduce(s, { type: "tap" });
  assert.deepEqual(likeView(s), { liked: true, count: 13, busy: true, error: null }, "the heart and the count move before the server answers");
  assert.deepEqual(likeRequest(s), { liked: true }, "it asks for a state, so a retry cannot toggle twice");
  s = likeReduce(s, { type: "sent" });
  assert.equal(likeRequest(s), null, "nothing else is sent while one is on the wire");
  s = likeReduce(s, { type: "confirmed", liked: true, likes: 14, holdUntil: 5000 });
  assert.deepEqual(likeView(s), { liked: true, count: 14, busy: false, error: null }, "the server's count is shown (someone else liked it too)");
  assert.equal(likeRequest(s), null);

  // Un-like flips back.
  s = likeReduce(likeReduce(s, { type: "tap" }), { type: "sent" });
  assert.deepEqual(likeView(s), { liked: false, count: 13, busy: true, error: null });
  s = likeReduce(s, { type: "confirmed", liked: false, likes: 13, holdUntil: 9000 });
  assert.deepEqual(likeView(s), { liked: false, count: 13, busy: false, error: null });
});

test("like: rapid taps cannot double-vote, stick the button, or drift from the server", () => {
  let s = likeInitial(5, false);
  s = likeReduce(s, { type: "tap" }); // like
  assert.deepEqual(likeRequest(s), { liked: true });
  s = likeReduce(s, { type: "sent" });
  s = likeReduce(s, { type: "tap" }); // un-like, while the first is on the wire
  s = likeReduce(s, { type: "tap" }); // like again
  s = likeReduce(s, { type: "tap" }); // un-like again
  assert.equal(likeRequest(s), null, "taps while a request is on the wire send nothing");
  assert.deepEqual(likeView(s), { liked: false, count: 5, busy: true, error: null }, "the count never goes past ±1 of the server's");
  s = likeReduce(s, { type: "confirmed", liked: true, likes: 6, holdUntil: 0 });
  assert.deepEqual(likeRequest(s), { liked: false }, "the last tap wins: one more request, for the final state");
  assert.deepEqual(likeView(s), { liked: false, count: 5, busy: true, error: null });
  s = likeReduce(likeReduce(s, { type: "sent" }), { type: "confirmed", liked: false, likes: 5, holdUntil: 0 });
  assert.deepEqual(likeView(s), { liked: false, count: 5, busy: false, error: null });
  assert.equal(likeRequest(s), null);

  // An even number of taps before anything is sent ends where it began: nothing to send.
  let t = likeInitial(5, true);
  t = likeReduce(likeReduce(t, { type: "tap" }), { type: "tap" });
  assert.equal(likeRequest(t), null);
  assert.deepEqual(likeView(t), { liked: true, count: 5, busy: false, error: null });

  // Every reachable state keeps the shown count within one of the server's, and never below zero.
  let u = likeInitial(0, false);
  for (const ev of ["tap", "sent", "tap", "tap", "tap", "tap"]) {
    u = likeReduce(u, { type: ev });
    const v = likeView(u);
    assert.ok(v.count >= 0 && Math.abs(v.count - u.serverCount) <= 1);
  }
});

test("like: when the server refuses, the button rolls back and says why", () => {
  let s = likeReduce(likeReduce(likeInitial(7, false), { type: "tap" }), { type: "sent" });
  s = likeReduce(s, { type: "tap" }); // a second tap is waiting
  s = likeReduce(s, { type: "failed", message: "Too many likes. Wait a minute and try again." });
  assert.deepEqual(likeView(s), { liked: false, count: 7, busy: false, error: "Too many likes. Wait a minute and try again." });
  assert.equal(likeRequest(s), null, "a failure never retries by itself");
  s = likeReduce(s, { type: "tap" });
  assert.equal(likeView(s).error, null, "the next tap clears the message");
  assert.deepEqual(likeRequest(s), { liked: true }, "and is the retry");

  const liked = likeReduce(likeReduce(likeReduce(likeInitial(3, true), { type: "tap" }), { type: "sent" }), { type: "failed", message: "x" });
  assert.deepEqual(likeView(liked), { liked: true, count: 3, busy: false, error: "x" }, "a refused un-like goes back to liked");
});

test("like: polled counts never fight the voter's own like", () => {
  let s = likeReduce(likeReduce(likeInitial(10, false), { type: "tap" }), { type: "sent" });
  s = likeReduce(s, { type: "poll", likes: 11, generatedAt: 1000 });
  assert.equal(likeView(s).count, 11, "a poll while the request is on the wire is ignored (it may or may not include it)");
  s = likeReduce(s, { type: "confirmed", liked: true, likes: 11, holdUntil: 5000 });
  s = likeReduce(s, { type: "poll", likes: 10, generatedAt: 4000 });
  assert.equal(likeView(s).count, 11, "a cached answer from before the like does not pull the count back");
  s = likeReduce(s, { type: "poll", likes: 15, generatedAt: 5000 });
  assert.equal(likeView(s).count, 15, "a newer answer is the truth");
  s = likeReduce(s, { type: "poll", likes: 0, generatedAt: NaN });
  assert.equal(likeView(s).count, 15, "an answer with no time is not trusted");

  assert.equal(holdFrom("Mon, 05 Oct 2026 16:00:03 GMT", 0), Date.parse("2026-10-05T16:00:04Z"), "the Date header is whole seconds: hold to the end of that second");
  assert.equal(holdFrom(null, 1000), 7000, "no header: hold for longer than the state cache");
  assert.equal(holdFrom(null, null), 0);
});

test("like: the voter's own likes (/api/me, or the gate) fill the hearts without moving the count", () => {
  let s = likeReduce(likeInitial(4, false), { type: "me", liked: true });
  assert.deepEqual(likeView(s), { liked: true, count: 4, busy: false, error: null }, "the server's count already includes it");
  // The held like behind the gate asks for `true`: already liked means nothing to send.
  s = likeReduce(s, { type: "want", liked: true });
  assert.equal(likeRequest(s), null);
  // A fresh voter's held like goes out.
  const fresh = likeReduce(likeInitial(4, false), { type: "want", liked: true });
  assert.deepEqual(likeRequest(fresh), { liked: true });
  assert.equal(likeView(fresh).count, 5);
  // /api/me arriving while a tap is pending does not undo the tap.
  const pending = likeReduce(likeReduce(likeInitial(4, false), { type: "tap" }), { type: "me", liked: false });
  assert.equal(likeView(pending).liked, true);
});

test("order: the most-liked track is shown first, ties keep the server's order, and the count is never touched", () => {
  const sent = [
    { slug: "a", label: "A", likes: 2 },
    { slug: "b", label: "B", likes: 5 },
    { slug: "c", label: "C", likes: 2 },
    { slug: "d", label: "D", likes: 0 },
    { slug: "e", label: "E", likes: 5 },
  ];
  const before = JSON.stringify(sent);
  assert.deepEqual(displayOrder(sent).map((t) => t.slug), ["b", "e", "a", "c", "d"], "highest first; b before e and a before c because the server sent them that way");
  assert.equal(JSON.stringify(sent), before, "the server's array is not reordered or changed: display only");
  assert.deepEqual(displayOrder(sent).map((t) => t.likes), [5, 5, 2, 2, 0], "every count is exactly what the server sent");
  assert.deepEqual(displayOrder([{ slug: "x", likes: "3" }, { slug: "y", likes: -4 }, { slug: "z" }, { slug: "w", likes: NaN }]).map((t) => t.slug), ["x", "y", "z", "w"], "a bad count sorts as zero, in the server's order");
  assert.deepEqual(displayOrder(null), []);
  // The source of truth for the count is unchanged: the server still orders by sort, label, id and
  // counts likes from like_events as before; the page sorts a copy of what it is sent.
  const stateSql = fs.readFileSync(path.join(ROOT, "functions/_lib/state.js"), "utf8");
  assert.match(stateSql, /FROM tracks t WHERE t\.active = 1 ORDER BY t\.sort, t\.label, t\.id`/, "the API's own order is untouched");
  assert.ok(!/likes/i.test(stateSql.split("ORDER BY")[1].split("`")[0]), "the API never orders by likes: the client does, as display only");
  const app = fs.readFileSync(path.join(PUBLIC, "js/app.js"), "utf8");
  assert.match(app, /const wanted = displayOrder\(tracks\);/, "renderTracks draws the cards in display order");
  assert.match(app, /app\.order !== null && !canReorder\(app\.lastInput, mono\(\)\)/, "and keeps the order on screen while the page is being touched");
  for (const ev of ["pointerdown", "touchstart", "keydown", "wheel", "scroll"]) assert.ok(app.includes(`"${ev}"`), `${ev} counts as touching the page`);
});

test("order: a reorder waits until the page has been still for 2.5 s, so a card never moves under a thumb", () => {
  assert.equal(REORDER_STILL_MS, 2500);
  assert.equal(canReorder(null, 10_000), true, "never touched: reorder at once");
  assert.equal(canReorder(undefined, 10_000), true);
  assert.equal(canReorder(9_000, 10_000), false, "touched 1 s ago: hold the order");
  assert.equal(canReorder(7_500, 10_000), true, "still for exactly 2.5 s: reorder");
  assert.equal(canReorder(7_501, 10_000), false);
});

test("polling: every 7 s, sooner after a failure, never slower than 15 s", () => {
  assert.equal(POLL_MS, 7000);
  assert.equal(nextPollDelay(0), 7000);
  assert.deepEqual([1, 2, 3, 4, 50].map(nextPollDelay), [3000, 6000, 10000, 15000, 15000]);
  const app = read("js/app.js");
  assert.match(app, /if \(document\.hidden\) return;[^\n]*\n\s*pollTimer = setTimeout\(poll, nextPollDelay\(app\.failures\)\)/, "a hidden tab does not poll");
  assert.match(app, /visibilitychange/, "and catches up when it is shown again");
});

// ── The gate ─────────────────────────────────────────────────────────────────────────────────
test("gate: field errors name the field; what is sent is trimmed, lowercased, and opt-in is off unless ticked", () => {
  assert.deepEqual(validateGate({ name: " ", email: "", city: "" }), { name: "Enter your name.", email: "Enter your email.", city: "Enter your city." });
  assert.deepEqual(validateGate({ name: "Jane", email: "jane@", city: "Oakland" }), { email: "That email does not look right. Check it and try again." });
  for (const bad of ["jane", "jane@x", "jane@x.", "ja ne@x.com", "jane@@x.com", "jane@x..com"]) assert.ok(validateGate({ name: "J", email: bad, city: "O" }).email, bad);
  for (const good of ["jane@x.com", " Jane.Doe+tag@Mail.Example.co ", "j@x.io"]) assert.deepEqual(validateGate({ name: "J", email: good, city: "O" }), {}, good);

  assert.deepEqual(gatePayload({ name: "  Jane   Doe ", email: " Jane@Example.COM ", city: " Oakland ", optIn: false, website: "" }),
    { name: "Jane Doe", email: "jane@example.com", city: "Oakland", marketing_opt_in: false, website: "" });
  assert.equal(gatePayload({ optIn: true }).marketing_opt_in, true);
  assert.equal(gatePayload({ optIn: "on" }).marketing_opt_in, false, "only a ticked box is an opt-in");
  assert.equal(gatePayload({ website: "http://bot" }).website, "http://bot", "the honeypot is sent as it is; the server judges it");
});

test("gate: the browser remembers a token and a first name, never the email", async () => {
  const rec = voterRecord({ token: TOKEN, voter: { first_name: "Jane", email: "jane@example.com" }, email: "jane@example.com", liked: [], returning: false });
  assert.deepEqual(rec, { token: TOKEN, first_name: "Jane" });
  assert.equal(voterRecord({ token: "nope", voter: { first_name: "Jane" } }), null);
  assert.equal(isVoterToken(TOKEN), true);
  assert.equal(isVoterToken(`${TOKEN}; path=/`), false);

  // Run the real storage code against a stand-in browser.
  const store = new Map();
  const cookies = [];
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  globalThis.document = { get cookie() { return cookies.filter((c) => !/Max-Age=0/.test(c)).map((c) => c.split(";")[0]).join("; "); }, set cookie(v) { cookies.push(v); } };
  globalThis.location = { protocol: "https:" };
  try {
    const { forgetVoter, loadVoter, saveVoter, VOTER_KEY } = await import("../public/js/api.js");
    saveVoter({ ...rec, email: "jane@example.com", city: "Oakland" });
    const everything = JSON.stringify([...store]) + cookies.join("\n");
    assert.ok(everything.includes(TOKEN), "the token is kept in localStorage and in a cookie");
    assert.ok(store.has(VOTER_KEY) && cookies.length === 1);
    assert.ok(!/jane@example\.com|Oakland/.test(everything), "no email or city is written to the browser");
    assert.match(cookies[0], /Path=\/; SameSite=Lax; Secure$/);
    assert.deepEqual(loadVoter(), rec);
    store.clear();
    assert.deepEqual(loadVoter(), { token: TOKEN, first_name: "" }, "the cookie alone still remembers the voter");
    saveVoter(rec);
    forgetVoter();
    assert.equal(store.size, 0);
    cookies.splice(0, cookies.length - 1);
    assert.match(cookies[0], /Max-Age=0/);
    store.set(VOTER_KEY, JSON.stringify({ token: "tampered", first_name: "x" }));
    assert.equal(loadVoter(), null, "a token that is not ours is not used");
  } finally {
    delete globalThis.localStorage; delete globalThis.document; delete globalThis.location;
  }
  // Only the gate reads the email field, and only to send it.
  for (const file of JS.filter((f) => !/^js\/(gate|logic|api)\.js$/.test(f))) assert.ok(!/email/i.test(read(file)), `${file} has no business with emails`);
  assert.ok(!/localStorage|document\.cookie|sessionStorage/.test(read("js/gate.js")), "the gate stores nothing itself");
});

test("gate markup: three required fields, email first and largest, opt-in unticked, a hidden honeypot, one button, and the code step", () => {
  const html = read("index.html");
  const gate = /<dialog id="tbz-gate"[\s\S]*?<\/dialog>/.exec(html)?.[0] ?? "";
  assert.ok(gate, "the gate is a <dialog> in index.html");
  const inputs = [...gate.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]);
  const byId = (id) => inputs.find((i) => i.includes(`id="${id}"`)) ?? "";
  assert.equal(inputs.length, 6, "email, name, city, the honeypot, the opt-in box, and the emailed code");
  assert.deepEqual(inputs.map((i) => /id="([^"]+)"/.exec(i)[1]), ["tbz-gate-email", "tbz-gate-name", "tbz-gate-city", "tbz-gate-hp", "tbz-gate-optin", "tbz-gate-code"]);
  for (const id of ["tbz-gate-email", "tbz-gate-name", "tbz-gate-city"]) {
    assert.match(byId(id), /\brequired\b/, `${id} is required`);
    assert.ok(gate.includes(`<label for="${id}">`), `${id} has a label`);
    assert.ok(gate.includes(`id="${id}-error"`) && byId(id).includes(`aria-describedby="${id}-error"`), `${id} has its own error line`);
  }
  assert.match(byId("tbz-gate-email"), /type="email"/);
  assert.ok(gate.indexOf("tbz-gate-email") < gate.indexOf("tbz-gate-name"), "email comes first");
  assert.match(read("css/site.css"), /\.field-email input \{[^}]*min-height: 56px; font-size: 1\.15rem/, "and is the biggest field");
  const box = byId("tbz-gate-optin");
  assert.match(box, /type="checkbox"/);
  assert.ok(!/\bchecked\b/.test(box), "the opt-in starts unticked");
  assert.match(gate, /<span>Send me Top Barz updates<\/span>/);
  const hp = byId("tbz-gate-hp");
  assert.match(hp, /tabindex="-1"/);
  assert.match(hp, /autocomplete="off"/);
  assert.match(gate, /<div class="hp" aria-hidden="true">\s*<label for="tbz-gate-hp">/, "the honeypot is hidden from people and from screen readers");
  assert.match(read("css/site.css"), /\.hp \{ position: absolute; left: -10000px;/);
  assert.match(read("js/gate.js"), /website: honeypot\.value/, "and is sent as `website`");
  assert.equal([...gate.matchAll(/<button\b[^>]*type="submit"/g)].length, 1);
  assert.match(gate, />Count my vote</);
  assert.match(gate, /One quick step to count your vote/);
  assert.match(gate, /We use your email to count your vote and to send contest results\.[^<]*<a class="tap-inline" href="\/privacy"/, "one line on what the email is for, and the privacy note (a thumb-sized link)");
  assert.ok(fs.existsSync(path.join(PUBLIC, "privacy.html")));

  // The code step: one field a phone can fill from the email, hidden until a code is sent.
  const details = /<div id="tbz-gate-details" class="gate-step">[\s\S]*?<div id="tbz-gate-code-step"/.exec(gate)?.[0] ?? "";
  for (const id of ["tbz-gate-email", "tbz-gate-name", "tbz-gate-city", "tbz-gate-hp", "tbz-gate-optin"]) assert.ok(details.includes(`id="${id}"`), `${id} is in the details step`);
  assert.ok(!details.includes('id="tbz-gate-code"'));
  assert.match(gate, /<div id="tbz-gate-code-step" class="gate-step" hidden>/, "the code step starts hidden");
  assert.match(gate, /<div id="tbz-gate-code-actions" class="code-actions" hidden>/);
  const code = byId("tbz-gate-code");
  assert.match(code, /type="text"/);
  assert.match(code, /inputmode="numeric"/);
  assert.match(code, /autocomplete="one-time-code"/);
  assert.ok(!/maxlength|readonly|disabled/.test(code), "nothing that would cut a pasted code short");
  assert.ok(gate.includes('<label for="tbz-gate-code">6-digit code</label>'));
  assert.match(code, /aria-describedby="tbz-gate-code-sent tbz-gate-code-help tbz-gate-code-error"/, "a screen reader hears where the code went, how long it lasts, and what went wrong");
  assert.match(gate, /<p id="tbz-gate-code-sent" class="code-sent">We sent a code to <strong id="tbz-gate-code-to"><\/strong>\.<\/p>/);
  assert.match(gate, /<p id="tbz-gate-code-help" class="code-help">It works for 10 minutes\. <strong>Not in your inbox\? Look in your spam or junk folder\.<\/strong><\/p>/, "the code email can land in spam (it did on the first live test), so the step says where to look");
  assert.match(gate, /<p id="tbz-gate-code-error" class="field-error" role="alert" hidden><\/p>/);
  assert.match(gate, /<p id="tbz-gate-code-note" class="code-note" role="status" hidden><\/p>/);
  assert.match(gate, /<button type="button" id="tbz-gate-resend" class="link-btn" disabled>Send a new code<\/button>/, "resend is a real button, off until its wait is over");
  assert.match(gate, /<button type="button" id="tbz-gate-change" class="link-btn">Change email<\/button>/);
  assert.match(read("css/site.css"), /\.field-code input \{[^}]*min-height: 60px;[^}]*font-size: 1\.7rem/, "the code field is big enough for a thumb");
  assert.match(read("css/site.css"), /\.code-actions \.link-btn \{ min-height: 44px;/, "resend and change-email are full-size touch targets");
  assert.match(read("css/site.css"), /\.gate \{\s*width: min\(440px, calc\(100vw - 20px\)\);/, "the popup fits a phone");
  assert.equal(VERIFICATION.codeTtl, 600, "the 10 minutes on the page is the server's");
});

// ── The gate's code step ─────────────────────────────────────────────────────────────────────
test("code step: the field takes digits only (paste works), and what is kept on the device is never the code", async () => {
  assert.equal(codeDigits("123 456"), "123456");
  assert.equal(codeDigits(" 12-34-56 "), "123456");
  assert.equal(codeDigits("code: 004217."), "004217");
  assert.equal(codeDigits("1234567890"), "123456");
  assert.equal(codeDigits("abc"), "");
  assert.equal(codeDigits(null), "");
  assert.equal(secondsUntil(10_500, 10_000), 1);
  assert.equal(secondsUntil(70_000, 10_000), 60);
  assert.equal(secondsUntil(10_000, 10_000), 0);
  assert.equal(secondsUntil(5, 10_000), 0);
  assert.equal(resendLabel(42), "Send a new code in 42 s");
  assert.equal(resendLabel(0), "Send a new code");

  const payload = gatePayload({ name: " Jane  Doe ", email: " Jane@Example.com ", city: "Oakland", optIn: true, website: "" });
  const answer = { verification: "code_sent", sent: true, email: "jane@example.com", resend_in_seconds: 60, expires_in_seconds: 600, code: "123456" };
  const now = 1_000_000;
  const rec = pendingRecord(payload, answer, now, { type: "like", slug: "brian", liked: true, token: "x" });
  assert.deepEqual(rec, {
    email: "jane@example.com", name: "Jane Doe", city: "Oakland", marketing_opt_in: true,
    resend_at: now + 60_000, expires_at: now + 600_000, saved_at: now, held: { type: "like", slug: "brian", liked: true }, dismissed: false,
  });
  assert.equal(pendingRecord(payload, { token: TOKEN, verification: "skipped" }, now), null, "only a code_sent answer starts the code step");
  assert.equal(pendingRecord(payload, { token: TOKEN }, now), null);
  assert.deepEqual(heldToKeep({ type: "share", slug: "caleb", extra: 1 }), { type: "share", slug: "caleb" });
  assert.equal(heldToKeep({ type: "comment", slug: "brian", payload: { text: "private words" } }), null, "a comment's words are not kept");
  assert.equal(heldToKeep({ type: "like", slug: "../x" }), null);
  assert.equal(heldToKeep(null), null);

  assert.deepEqual(readPending({ ...rec, code: "123456", token: TOKEN }, now + 5000), rec, "only the known keys are read back");
  assert.equal(readPending(rec, now + PENDING_KEEP_MS + 1), null, "forgotten after an hour");
  assert.equal(PENDING_KEEP_MS, 3_600_000);
  assert.equal(readPending({ ...rec, email: "" }, now), null);
  assert.equal(readPending({ ...rec, expires_at: "soon" }, now), null);
  assert.equal(readPending("jane@example.com", now), null);
  assert.equal(readPending(null, now), null);

  // The real storage code against a stand-in browser.
  const store = new Map();
  const cookies = [];
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  globalThis.document = { get cookie() { return cookies.join("; "); }, set cookie(v) { cookies.push(v); } };
  try {
    const { PENDING_KEY, VOTER_KEY, forgetPending, loadPending, savePending } = await import("../public/js/api.js");
    assert.equal(PENDING_KEY, "tbz.pending");
    assert.notEqual(PENDING_KEY, VOTER_KEY);
    assert.equal(loadPending(now), null);
    savePending({ ...rec, code: "123456" }, now);
    assert.deepEqual([...store.keys()], [PENDING_KEY]);
    assert.ok(store.get(PENDING_KEY).includes("jane@example.com"), "the email is kept so a refresh returns to the code step");
    assert.ok(!store.get(PENDING_KEY).includes("123456"), "the code is never written to the browser");
    assert.equal(cookies.length, 0, "and nothing of it goes in a cookie (a cookie travels with every request)");
    assert.deepEqual(loadPending(now + 1000), rec);
    assert.equal(loadPending(now + PENDING_KEEP_MS + 1), null);
    assert.equal(store.size, 0, "an old record is removed, not just ignored");
    savePending(rec, now);
    forgetPending();
    assert.equal(store.size, 0);
    savePending({ email: "x" }, now);
    assert.equal(store.size, 0, "a damaged record is not stored");
    store.set(PENDING_KEY, "{not json");
    assert.equal(loadPending(now), null);
  } finally {
    delete globalThis.localStorage; delete globalThis.document;
  }
  assert.ok(!/localStorage|document\.cookie|sessionStorage/.test(read("js/gate.js")), "the gate stores nothing itself: api.js does");
  assert.ok(!/\bcode\b[^;\n]*savePending|savePending\([^)]*code/i.test(read("js/gate.js").replace(/codeDead|codeStep|codeTo|codeInput|codeError|codeNote|codeActions|codeDigits/g, "")), "the gate never hands the code to storage");
  assert.match(read("privacy.html"), /while you are entering your code, what you typed in the form stays on your device[^<]*removed when you finish, and after an hour at most/, "the privacy note says so");
  assert.match(read("privacy.html"), /The code email is sent by Resend/);
});

// The gate's own script, run against a stand-in page: every element it looks up, as index.html
// has it (hidden or not), with fetch, storage and the clock under the test's control.
const clocked = new WeakSet();
async function gateHarness(t, { answers, store = new Map() }) {
  const html = read("index.html");
  const els = {};
  const doc = { activeElement: null, documentElement: { classList: { add() {}, remove() {} } }, querySelector: () => null };
  const make = (id) => {
    const tag = new RegExp(`<[a-z0-9]+\\b[^>]*\\bid="${id}"[^>]*>`).exec(html)?.[0];
    if (!tag) return null;
    const listeners = {};
    const attrs = new Map();
    const el = {
      id, textContent: "", value: "", checked: false, open: false, isConnected: true, dataset: {},
      hidden: /\shidden(\s|>)/.test(tag), disabled: /\sdisabled(\s|>)/.test(tag),
      addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
      fire: (type, ev = {}) => Promise.all((listeners[type] ?? []).map((fn) => fn({ preventDefault() {}, target: null, ...ev }))),
      setAttribute: (k, v) => attrs.set(k, String(v)), removeAttribute: (k) => attrs.delete(k), hasAttribute: (k) => attrs.has(k),
      focus() { doc.activeElement = el; }, select() {},
      showModal() { el.open = true; }, close() { el.open = false; },
      reset() { for (const other of Object.values(els)) { if (other && /^tbz-gate-(email|name|city|hp|code)$/.test(other.id)) other.value = ""; if (other?.id === "tbz-gate-optin") other.checked = false; } },
    };
    return el;
  };
  doc.getElementById = (id) => (els[id] ??= make(id));
  const calls = [];
  globalThis.document = doc;
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const call = { path: String(url), body: JSON.parse(init.body), button: { ...snapshot() } };
    calls.push(call);
    const next = answers.shift();
    assert.ok(next, `an unexpected request: ${call.path}`);
    const [status, body] = next;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  if (!clocked.has(t)) { clocked.add(t); t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 1_800_000_000_000 }); }
  t.after(() => { globalThis.fetch = realFetch; delete globalThis.document; delete globalThis.localStorage; });
  const { createGate } = await import("../public/js/gate.js");
  const seen = { voters: [], held: [] };
  const opener = { id: "the-held-track's-button", isConnected: true, focus() { doc.activeElement = opener; } };
  const gate = createGate({
    onVoter: (data) => seen.voters.push(data),
    runHeld: async (action) => { seen.held.push(action); return { ok: true, done: "Vote counted" }; },
    heldLine: (action) => (action ? `held:${action.type}:${action.slug}` : "nothing held"),
    codesOn: () => true,
    openerFor: (action) => (action ? opener : null),
  });
  const $ = (id) => { const el = doc.getElementById(`tbz-gate${id ? `-${id}` : ""}`); assert.ok(el, `#tbz-gate-${id} is in index.html`); return el; };
  function snapshot() {
    return { state: $("submit").dataset.state, disabled: $("submit").disabled, text: $("submit-text").textContent };
  }
  const fill = (email = "jane@example.com") => { $("email").value = email; $("name").value = "Jane Doe"; $("city").value = "Oakland"; };
  const type = async (digits) => { $("code").value = digits; await $("code").fire("input"); };
  const stored = () => (store.has("tbz.pending") ? JSON.parse(store.get("tbz.pending")) : null);
  return { gate, $, calls, seen, store, stored, fill, type, snapshot, doc, opener, tick: (ms) => t.mock.timers.tick(ms) };
}
const LIKE = { type: "like", slug: "brian", liked: true };
const SENT = { verification: "code_sent", sent: true, email: "jane@example.com", resend_in_seconds: 60, expires_in_seconds: 600 };
const IN = { token: TOKEN, voter: { first_name: "Jane" }, liked: [], returning: false };

test("code step, start to finish: sending, sent, the resend countdown, a wrong code, then verified and the held like goes out", async (t) => {
  const h = await gateHarness(t, { answers: [[200, SENT], [400, { error: "wrong_code", message: "That code is not right. 4 tries left.", tries_left: 4 }], [200, { ...IN, verification: "verified" }]] });
  h.gate.open(LIKE, null);
  assert.deepEqual([h.$("details").hidden, h.$("code-step").hidden, h.$("code-actions").hidden], [false, true, true], "the details step first");
  assert.equal(h.$("held").textContent, "held:like:brian");
  assert.equal(h.doc.activeElement, h.$("email"));
  h.fill();
  await h.$("form").fire("submit");

  // Sending the code: waiting, button off.
  assert.equal(h.calls[0].path, "/api/voters");
  assert.deepEqual(h.calls[0].button, { state: "working", disabled: true, text: "Sending your code…" });
  // Sent: the code step, naming the email, with a way to change it and the resend counting down.
  assert.deepEqual([h.$("details").hidden, h.$("code-step").hidden, h.$("code-actions").hidden], [true, false, false]);
  assert.equal(h.$("title").textContent, "Enter the code we emailed you");
  assert.equal(h.$("code-to").textContent, "jane@example.com");
  assert.deepEqual(h.snapshot(), { state: "idle", disabled: false, text: "Check my code" });
  assert.equal(h.doc.activeElement, h.$("code"), "the cursor is in the code field");
  assert.equal(h.$("email").value, "", "the email is not left in the form");
  assert.deepEqual([h.$("resend").disabled, h.$("resend").textContent], [true, "Send a new code in 60 s"]);
  assert.equal(h.$("change").disabled, false);
  assert.deepEqual([h.seen.voters.length, h.seen.held.length], [0, 0], "nothing is counted before the code");
  assert.equal(h.stored().email, "jane@example.com");
  h.tick(59_000);
  assert.deepEqual([h.$("resend").disabled, h.$("resend").textContent], [true, "Send a new code in 1 s"]);
  h.tick(1000);
  assert.deepEqual([h.$("resend").disabled, h.$("resend").textContent], [false, "Send a new code"]);

  // Too few digits: said under the field, nothing sent.
  h.$("code").value = "123";
  await h.$("form").fire("submit");
  assert.equal(h.calls.length, 1);
  assert.deepEqual([h.$("code-error").hidden, h.$("code-error").textContent], [false, "Enter the 6-digit code from the email."]);

  // A wrong code, sent by itself at the sixth digit: the tries left, and the field ready to retype.
  await h.type("111111");
  assert.deepEqual([h.calls[1].path, h.calls[1].body], ["/api/voters/verify", { email: "jane@example.com", code: "111111" }]);
  assert.deepEqual(h.calls[1].button, { state: "working", disabled: true, text: "Checking…" });
  assert.deepEqual([h.$("code-error").hidden, h.$("code-error").textContent], [false, "That code is not right. 4 tries left."]);
  assert.equal(h.$("code").hasAttribute("aria-invalid"), true);
  assert.deepEqual(h.snapshot(), { state: "idle", disabled: false, text: "Check my code" });
  await h.type("111111");
  assert.equal(h.calls.length, 2, "the same wrong digits are not sent again by themselves");

  // The right code, pasted with a space: verified, and the held like completes on its own.
  await h.type("123 456");
  assert.equal(h.$("code").value, "", "the form is cleared once the voter is in");
  assert.deepEqual(h.calls[2].body, { email: "jane@example.com", code: "123456" });
  assert.equal(h.seen.voters[0].token, TOKEN);
  assert.deepEqual(h.seen.held, [LIKE]);
  assert.deepEqual(h.snapshot(), { state: "done", disabled: true, text: "Vote counted" });
  assert.equal(h.stored(), null, "nothing is kept once the voter is in");
  assert.ok(![...h.store.values()].join().match(/111111|123456/), "no code was ever stored");
  assert.equal(h.$("").open, true);
  h.tick(900);
  assert.equal(h.$("").open, false, "and the popup closes by itself");
});

test("code step: an expired or used-up code says so and offers a new one; the hourly cap and a failed resend say why", async (t) => {
  const h = await gateHarness(t, { answers: [
    [200, SENT],
    [410, { error: "code_exhausted", message: "Too many wrong tries. Send a new code." }],
    [429, { error: "resend_cooldown", message: "You can ask for a new code in 45 seconds.", retry_after_seconds: 45 }],
    [200, { ...SENT, resend_in_seconds: 60 }],
    [410, { error: "code_expired", message: "That code has expired. Send a new one." }],
    [429, { error: "code_limit", message: "We have sent 3 codes to this email in the last hour. Use the newest one, or try again in 20 minutes.", retry_after_seconds: 1200 }],
    [503, { error: "code_unavailable", message: "We could not send your code right now. Try again in a little while." }],
  ] });
  h.gate.open(LIKE, null);
  h.fill();
  await h.$("form").fire("submit");
  h.tick(61_000);

  // Out of tries: the message, the submit button off, and the next step in focus.
  await h.type("222222");
  assert.deepEqual([h.$("code-error").hidden, h.$("code-error").textContent], [false, "Too many wrong tries. Send a new code."]);
  assert.equal(h.$("submit").disabled, true, "a dead code cannot be tried again");
  assert.deepEqual([h.$("code").disabled, h.$("code").value], [true, ""], "and its field is off and empty: nothing on the step looks usable that does nothing");
  assert.deepEqual([h.$("resend").disabled, h.$("resend").textContent], [false, "Send a new code"]);
  assert.equal(h.doc.activeElement, h.$("resend"), "focus moves to the way forward");
  await h.type("333333");
  assert.equal(h.calls.length, 2, "typing into a dead code sends nothing");

  // Asked too soon: the server's wait is shown on the control.
  await h.$("resend").fire("click");
  assert.deepEqual(h.calls[2].body, { name: "Jane Doe", email: "jane@example.com", city: "Oakland", marketing_opt_in: false, website: "" }, "a resend is the same gate call, with what was typed");
  assert.deepEqual(h.calls[2].button, { state: "working", disabled: true, text: "Sending a new code…" });
  assert.deepEqual([h.$("error").hidden, h.$("error").textContent], [false, "You can ask for a new code in 45 seconds."]);
  assert.deepEqual([h.$("resend").disabled, h.$("resend").textContent], [true, "Send a new code in 45 s"]);
  await h.$("resend").fire("click");
  assert.equal(h.calls.length, 3, "a resend during the wait does nothing");
  h.tick(45_000);

  // A new code: said out loud, the field live again.
  await h.$("resend").fire("click");
  assert.deepEqual([h.$("code-note").hidden, h.$("code-note").textContent], [false, "A new code is on its way."]);
  assert.deepEqual([h.$("code-error").hidden, h.$("submit").disabled, h.$("error").hidden], [true, false, true]);
  assert.equal(h.$("code").disabled, false, "the new code's field takes typing again");
  assert.equal(h.doc.activeElement, h.$("code"));
  assert.equal(h.$("resend").textContent, "Send a new code in 60 s");

  // Expired, as the server says it…
  await h.type("444444");
  assert.equal(h.$("code-error").textContent, "That code has expired. Send a new one.");
  assert.deepEqual([h.$("submit").disabled, h.$("code").disabled], [true, true]);
  // …the cap of three an hour…
  h.tick(60_000);
  await h.$("resend").fire("click");
  assert.match(h.$("error").textContent, /^We have sent 3 codes to this email in the last hour\./);
  assert.equal(h.$("resend").textContent, "Send a new code in 1200 s");
  // …and mail down for an email that is already verified.
  h.tick(1_200_000);
  await h.$("resend").fire("click");
  assert.equal(h.$("error").textContent, "We could not send your code right now. Try again in a little while.");
  assert.deepEqual([h.seen.voters.length, h.seen.held.length], [0, 0]);
});

test("code step: a code that runs out while the popup is open says so by itself", async (t) => {
  const h = await gateHarness(t, { answers: [[200, SENT]] });
  h.gate.open(LIKE, null);
  h.fill();
  await h.$("form").fire("submit");
  h.tick(599_000);
  assert.equal(h.$("code-error").hidden, true);
  h.tick(1000);
  assert.deepEqual([h.$("code-error").hidden, h.$("code-error").textContent, h.$("submit").disabled], [false, "That code has expired. Send a new one.", true]);
  assert.equal(h.$("code").disabled, true, "the field goes off with the code");
  assert.equal(h.doc.activeElement, h.$("resend"));
  assert.equal(h.calls.length, 1);
});

test("code step: a code that dies while the resend wait is still running puts the keyboard on Send a new code when the wait ends", async (t) => {
  const h = await gateHarness(t, { answers: [[200, SENT], [410, { error: "code_exhausted", message: "Too many wrong tries. Send a new code." }]] });
  h.gate.open(LIKE, null);
  h.fill();
  await h.$("form").fire("submit");
  h.tick(10_000);
  await h.type("222222");
  assert.deepEqual([h.$("code").disabled, h.$("resend").disabled, h.$("resend").textContent], [true, true, "Send a new code in 50 s"], "dead, and the way forward says when it opens");
  assert.notEqual(h.doc.activeElement, h.$("resend"));
  h.tick(50_000);
  assert.deepEqual([h.$("resend").disabled, h.$("resend").textContent], [false, "Send a new code"]);
  assert.equal(h.doc.activeElement, h.$("resend"), "the one control that helps is in focus the moment it works");
});

test("skipped goes straight through with no code step; code_unavailable shows its message", async (t) => {
  const h = await gateHarness(t, { answers: [
    [503, { error: "code_unavailable", message: "We could not send your code right now. Try again in a little while." }],
    [200, { ...IN, verification: "skipped", reason: "mail_budget" }],
  ] });
  h.gate.open(LIKE, null);
  h.fill();
  await h.$("form").fire("submit");
  assert.deepEqual([h.$("error").hidden, h.$("error").textContent], [false, "We could not send your code right now. Try again in a little while."]);
  assert.deepEqual(h.snapshot(), { state: "retry", disabled: false, text: "Try again" });
  assert.deepEqual([h.$("details").hidden, h.$("code-step").hidden], [false, true], "still on the details step");
  assert.equal(h.stored(), null);
  assert.equal(h.seen.voters.length, 0);

  await h.$("form").fire("submit");
  assert.equal(h.$("code-step").hidden, true, "no code step");
  assert.equal(h.seen.voters[0].verification, "skipped");
  assert.deepEqual(h.seen.held, [LIKE], "the like goes out at once");
  assert.deepEqual(h.snapshot(), { state: "done", disabled: true, text: "Vote counted" });
  assert.equal(h.stored(), null);
});

test("closing the popup or refreshing mid-step returns the voter to the code step; change email goes back", async (t) => {
  const store = new Map();
  const h = await gateHarness(t, { store, answers: [[200, SENT], [200, { ...IN, verification: "verified" }]] });
  h.gate.open(LIKE, null);
  h.fill();
  await h.$("form").fire("submit");
  assert.deepEqual(h.stored().held, LIKE);
  // Closed with the X: the held like is dropped, the code stays good.
  await h.$("close").fire("click");
  assert.equal(h.$("").open, false);
  assert.deepEqual([h.stored().email, h.stored().held, h.stored().dismissed], ["jane@example.com", null, true]);
  assert.equal(h.gate.resume(), false, "a popup the voter closed does not reopen by itself");
  // The next like opens the code step, not the form.
  const other = { type: "like", slug: "caleb", liked: true };
  h.gate.open(other, null);
  assert.deepEqual([h.$("details").hidden, h.$("code-step").hidden, h.$("code-to").textContent], [true, false, "jane@example.com"]);
  assert.equal(h.$("held").textContent, "held:like:caleb");
  assert.equal(h.doc.activeElement, h.$("code"));
  assert.equal(h.calls.length, 1, "no new email is sent to show it");
  assert.deepEqual(h.stored().held, other);

  // A refresh (a new page, the same browser storage): straight back to the code step, with the like.
  const again = await gateHarness(t, { store, answers: [[200, { ...IN, verification: "verified" }]] });
  assert.equal(again.gate.resume(), true);
  assert.deepEqual([again.$("").open, again.$("details").hidden, again.$("code-step").hidden, again.$("code-to").textContent], [true, true, false, "jane@example.com"]);
  assert.equal(again.$("held").textContent, "held:like:caleb");
  assert.match(again.$("resend").textContent, /^Send a new code in [0-9]+ s$/, "the countdown carries on from where it was");
  // Closed after a reload, the keyboard goes back to the held track's own button, not to nowhere.
  await again.$("close").fire("click");
  assert.equal(again.doc.activeElement, again.opener, "focus returns to the button the held like belongs to");
  again.gate.open(other, again.opener);
  await again.type("123456");
  assert.deepEqual(again.calls[0].body, { email: "jane@example.com", code: "123456" });
  assert.deepEqual(again.seen.held, [{ type: "like", slug: "caleb", liked: true }]);
  assert.equal(again.stored(), null);

  // Change email: back to the details, filled in, and the old address forgotten.
  const third = await gateHarness(t, { store, answers: [[200, SENT]] });
  assert.equal(third.gate.resume(), false, "nothing to resume once the voter is in");
  third.gate.open(LIKE, null);
  third.fill("jnae@example.com");
  third.$("optin").checked = true;
  await third.$("form").fire("submit");
  await third.$("change").fire("click");
  assert.deepEqual([third.$("details").hidden, third.$("code-step").hidden, third.$("code-actions").hidden], [false, true, true]);
  assert.deepEqual([third.$("email").value, third.$("name").value, third.$("city").value, third.$("optin").checked], ["jnae@example.com", "Jane Doe", "Oakland", true]);
  assert.equal(third.doc.activeElement, third.$("email"));
  assert.equal(third.$("title").textContent, "One quick step to count your vote");
  assert.deepEqual(third.snapshot(), { state: "idle", disabled: false, text: "Count my vote" });
  assert.equal(third.stored(), null);

  // A code that has run out is not resumed on a reload; the next like still offers a new one.
  const stale = await gateHarness(t, { store: new Map([["tbz.pending", JSON.stringify({ ...pendingRecord(gatePayload({ name: "J", email: "j@example.com", city: "O" }), SENT, 1_800_000_000_000 - 700_000, LIKE) })]]), answers: [] });
  assert.equal(stale.gate.resume(), false);
  stale.gate.open(LIKE, null);
  assert.deepEqual([stale.$("code-step").hidden, stale.$("code-error").textContent, stale.$("submit").disabled, stale.$("resend").disabled], [false, "That code has expired. Send a new one.", true, false]);
  assert.equal(stale.doc.activeElement, stale.$("resend"));
});

// ── The final pass (hostile review, 2 Oct 2026): each defect it fixed is pinned here ─────────
const CSS = () => read("css/site.css");
const cssRule = (selector) => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\n)${esc} \\{([^}]*)\\}`).exec(CSS())?.[1] ?? "";
};
const token = (name) => new RegExp(`--${name}: ([^;]+);`).exec(CSS())?.[1]?.trim() ?? "";
const px = (value) => { const m = /^(-?[0-9.]+)px$/.exec(value); return m ? Number(m[1]) : NaN; };
// A colour token → [r, g, b]: #rgb / #rrggbb / hsl(h s% l%) as the stylesheet writes them.
function rgbOf(value) {
  let m = /^#([0-9a-f]{3})$/i.exec(value);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16));
  m = /^#([0-9a-f]{6})$/i.exec(value);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^hsl\(([0-9.]+) ([0-9.]+)% ([0-9.]+)%\)$/.exec(value);
  assert.ok(m, `a colour this test can read: ${value}`);
  const [h, s, l] = [Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100];
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map((n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))));
}
function contrast(a, b) {
  const lum = (rgb) => { const [r, g, bl] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
  const [x, y] = [lum(rgbOf(token(a))), lum(rgbOf(token(b)))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test("header: the slogan never touches the logo (air between them at every width)", () => {
  const top = cssRule(".top");
  const logo = cssRule(".logo");
  assert.ok(!/\bgap:/.test(top), "the space is the logo's own margin, not a small gap");
  const m = /margin-bottom: var\(--(space-[0-9]+)\)/.exec(logo);
  assert.ok(m, ".logo sets the space under itself from the spacing scale");
  assert.ok(px(token(m[1])) >= 28, `at least 28px under the logo on a phone (it was 6px): ${token(m[1])}`);
  const wide = /@media \(min-width: 45rem\) \{[\s\S]*?\n\}/.exec(CSS())[0];
  const w = /\.logo \{ margin-bottom: var\(--(space-[0-9]+)\); \}/.exec(wide);
  assert.ok(w && px(token(w[1])) >= px(token(m[1])), "and no less on a desktop");
});

test("brand: the page is set the way topbarz.xyz is (its ellipse buttons, its type, its colours)", () => {
  // Values read from https://www.topbarz.xyz/ on 2 Oct 2026 (RUNBOOK.md, "The page").
  const btn = cssRule(".btn");
  assert.match(btn, /border: var\(--line-btn\) solid var\(--color-accent\); border-radius: 100%;/, "buttons are the site's ellipse");
  assert.equal(token("line-btn"), "4px", "with its 4px line");
  assert.match(btn, /min-height: 59px;/, "at its height");
  assert.match(btn, /font: 400 var\(--text-base\)\/1\.2 var\(--font-body\); text-transform: uppercase;/, "capitals in Epilogue 400, not bold");
  assert.match(btn, /white-space: nowrap;/, "and a button's words never wrap");
  assert.match(cssRule(".slogan"), /font: italic 400 var\(--text-display\)\/1\.09 var\(--font-display\); letter-spacing: var\(--tracking-display\);/, "the slogan is slanted and tight, as the site sets it");
  assert.equal(token("tracking-display"), "-0.02em");
  assert.match(token("text-display"), /^clamp\(2\.145rem, .+, 3\.208rem\)$/, "34px on a phone to 51px on a desktop");
  assert.equal(token("color-accent"), "hsl(16.91 100% 56.86%)");
  assert.equal(token("color-warm"), "hsl(31.65 90.1% 80.2%)");
  assert.equal(token("color-ink"), "hsl(60 9.09% 97.84%)");
  assert.equal(token("color-accent-ink"), "hsl(210 7.41% 10.59%)");
  assert.match(cssRule(".foot"), /background: var\(--color-warm\); color: var\(--color-warm-ink\);/, "the closing section is the site's peach, with dark text");
  assert.ok(!/border-radius: (?!0\b|50%|100%|99px|999px)/.test(CSS()), "no rounded rectangles: square, a circle, a pill or the ellipse");
  assert.ok(!/font-weight: 700/.test(CSS().replace(/\.field-code input \{[^}]*\}/, "")), "nothing is bold but the code's digits");
});

test("tokens: every colour and typeface on the page is a named token, and motion is named per property", () => {
  const css = CSS();
  assert.match(css, /^\/\* Hallmark · macrostructure: [^\n]+\n(?:[^\n]*\n){1,5}?[^\n]*pre-emit critique: P[1-5] H[1-5] E[1-5] S[1-5] R[1-5] V[1-5]/, "the stylesheet opens with its stamp");
  const root = /:root \{([\s\S]*?)\n\}/.exec(css)[1];
  const rest = css.replace(root, "").replace(/@font-face \{[\s\S]*?\}/g, "");
  const literals = [...rest.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch)\([^)]*\)/g)].map((m) => m[0]).filter((v) => v !== "#000");
  assert.deepEqual(literals, [], "a colour written outside :root");
  assert.equal([...rest.matchAll(/#000/g)].length, 2, "the only #000 outside :root is the scrub bar's mask (a mask, not a colour)");
  assert.ok(!/font-family:/.test(rest), "typefaces come from --font-display and --font-body");
  assert.ok(!/transition: all|transition:[^;]*\ball\b/.test(css), "never transition: all");
  assert.ok(!/z-index: [0-9]/.test(css), "layers are named");
  for (const el of ["html", "body"]) assert.match(css, new RegExp(`\\n${el} \\{[^}]*overflow-x: clip;`), `${el} cannot scroll sideways`);
  assert.match(cssRule(".gif-grid"), /repeat\(3, minmax\(0, 1fr\)\)/, "a grid of images cannot push the page wider");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ animation: none !important; transition: none !important;/);
});

test("contrast: text, field edges and focus rings pass on every surface they sit on", () => {
  for (const paper of ["color-paper", "color-paper-2", "color-paper-3"]) {
    assert.ok(contrast("color-accent", paper) >= 4.5, `orange text on ${paper}: ${contrast("color-accent", paper).toFixed(2)}`);
    assert.ok(contrast("color-ink-2", paper) >= 4.5, `quiet text on ${paper}`);
    assert.ok(contrast("color-error", paper) >= 4.5, `error text on ${paper}`);
    assert.ok(contrast("color-field-line", paper) >= 3, `a field's edge on ${paper} (it was 2.1:1): ${contrast("color-field-line", paper).toFixed(2)}`);
    assert.ok(contrast("color-off", paper) >= 3, `an unplayed bar / a switched-off chip on ${paper}`);
  }
  assert.ok(contrast("color-accent-ink", "color-accent") >= 4.5, "text on an orange button");
  assert.ok(contrast("color-warm-ink", "color-warm") >= 7, "text on peach");
  assert.ok(contrast("color-accent", "color-warm") < 3, "orange on peach does NOT pass…");
  const foot = [...CSS().matchAll(/\n(\.foot[^{]*) \{([^}]*)\}/g)];
  assert.ok(foot.length >= 8);
  for (const [, selector, body] of foot) assert.ok(!/color: var\(--color-accent\)/.test(body), `…so nothing in the peach section is orange: ${selector}`);
  assert.match(cssRule(".foot"), /--color-focus: var\(--color-warm-ink\);/, "and its focus ring is dark, not peach on peach");
  const fields = /\.compose-input, \.gif-search, \.field input, \.share-link \{([^}]*)\}/.exec(CSS())[1];
  assert.match(fields, /border: 2px solid var\(--color-field-line\);/);
  assert.match(fields, /outline: 2px solid transparent; outline-offset: 1px;/, "the focus ring's place is kept, so focus moves nothing");
  const states = [...CSS().matchAll(/\n([^{}\n]*(?:input|compose-input|gif-search|share-link)[^{}\n]*(?::focus|:disabled|:hover|\[aria-invalid)[^{}\n]*) \{([^}]*)\}/g)];
  assert.ok(states.length >= 3, "the fields' focus, invalid and disabled rules were read");
  for (const [, selector, body] of states) assert.ok(!/border(?:-width)?:/.test(body), `no field changes its line weight between states: ${selector}`);
});

test("touch: every control is a thumb-sized target, and has a pressed and an off state", () => {
  assert.equal(token("tap"), "44px");
  assert.match(cssRule(".foot-links a"), /min-height: var\(--tap\);/, "footer links (they were 15px tall)");
  assert.match(cssRule(".tap-inline"), /padding-block: 13px; margin-block: -13px;/, "a link inside a sentence");
  const index = read("index.html");
  assert.equal([...index.matchAll(/<a class="tap-inline"/g)].length, 2);
  assert.match(/<p class="foot-links">[\s\S]*?<\/p>/.exec(index)[0], /@topbarz\.xyz on Instagram<\/a>\s*<a href="https:\/\/www\.topbarz\.xyz\/">topbarz\.xyz<\/a>\s*<a href="\/privacy">Privacy note<\/a>/);
  assert.match(cssRule(".chip"), /min-height: var\(--tap\);/);
  for (const sel of [".btn:active", ".chip:active:not(:disabled)", ".play:active", ".arrow:active:not(:disabled)", ".link-btn:active", ".panel-close:active", ".shot:active img"]) assert.ok(cssRule(sel), `${sel} is styled`);
  for (const sel of [".btn:disabled", ".chip:disabled", ".arrow:disabled", ".link-btn:disabled", ".field input:disabled"]) assert.ok(cssRule(sel), `${sel} is styled`);
});

test("like: a like still on its way shows that it is waiting, without flashing on a fast one", () => {
  assert.ok(LIKE_WAIT_MS >= 150 && LIKE_WAIT_MS <= 600, "long enough not to flash, short enough to be seen");
  const app = read("js/app.js");
  assert.match(app, /icon\("heart"\), h\("span", \{ class: "spinner", "aria-hidden": "true" \}\), likeCount\)/, "the like button carries a spinner");
  assert.match(app, /if \(card\.like\.inflight && waitTimer === null\) waitTimer = setTimeout\(\(\) => showWaiting\(card\.like\.inflight\), LIKE_WAIT_MS\);/);
  assert.match(app, /if \(!card\.like\.inflight\) \{ clearTimeout\(waitTimer\); waitTimer = null; showWaiting\(false\); \}/, "and stops the moment the server answers");
  assert.match(app, /likeBtn\.setAttribute\("aria-busy", "true"\)/, "a screen reader is told too");
  assert.match(cssRule(".like.is-waiting .spinner"), /display: block;/);
  assert.match(cssRule(".like.is-waiting .ico-heart"), /display: none;/, "the spinner takes the heart's place, so nothing moves");
});

test("counts: a refresh or a second tab right after a voter's own like or comment shows the new count", async () => {
  const now = 1_800_000_000_000;
  const until = now + 1000; // server time before which a cached state cannot contain the like
  let own = rememberOwn({}, "brian", { likes: 13 }, until, now);
  assert.deepEqual(own, { brian: { likes: 13, until, saved_at: now } });
  assert.deepEqual(readOwn(own, "brian", until - 4000, now + 500), { likes: 13, comments: null, until }, "a state built before the like: the remembered count wins");
  assert.equal(readOwn(own, "brian", until, now + 500), null, "a state built after it: the server's count wins");
  assert.equal(readOwn(own, "caleb", 0, now), null);
  own = rememberOwn(own, "brian", { comments: 4 }, until + 3000, now + 2000);
  assert.deepEqual(own.brian, { likes: 13, comments: 4, until: until + 3000, saved_at: now + 2000 }, "a comment on the same track is kept beside the like");
  assert.deepEqual(rememberOwn(own, "brian", { likes: 12 }, until - 500, now + 3000).brian.until, until + 3000, "the hold only moves forward");
  assert.equal(readOwn(own, "brian", 0, now + 2000 + OWN_KEEP_MS + 1), null, "forgotten after a minute");
  assert.equal(OWN_KEEP_MS, 60_000);
  assert.deepEqual(rememberOwn({}, "brian", { likes: 1 }, NaN, now), {}, "no hold, nothing kept");
  assert.deepEqual(pruneOwn({ "../x": { until, saved_at: now }, brian: "13", caleb: { likes: -1, until, saved_at: now, email: "x" } }, now), { caleb: { until, saved_at: now } }, "only well-formed counts are read back, nothing else that was stored");
  assert.deepEqual(pruneOwn(null, now), {});

  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  try {
    const { OWN_KEY, loadOwn, saveOwn } = await import("../public/js/api.js");
    assert.equal(OWN_KEY, "tbz.own");
    saveOwn(own, now + 2000);
    assert.deepEqual(loadOwn(now + 2500), own);
    assert.ok(!/@|token|v1\./.test(store.get(OWN_KEY)), "counts only: no email, no token");
    assert.deepEqual(loadOwn(now + 2000 + OWN_KEEP_MS + 1), {});
    saveOwn({}, now);
    assert.equal(store.size, 0, "an empty record is removed, not stored");
    store.set(OWN_KEY, "{not json");
    assert.deepEqual(loadOwn(now), {});
  } finally { delete globalThis.localStorage; }

  const app = read("js/app.js");
  const { keepOwn, ownCounts, loadOwn: load2 } = await import("../public/js/api.js");
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  try {
    store.clear();
    keepOwn("brian", { likes: 13 }, until, now);
    keepOwn("brian", { comments: 4 }, until + 3000, now + 2000);
    assert.deepEqual(ownCounts(load2(now + 2100), "brian", until - 4000, now + 2100), { likes: 13, comments: 4, until: until + 3000 }, "what a refreshed page reads back");
  } finally { delete globalThis.localStorage; }
  assert.match(app, /keepOwn\(card\.slug, \{ likes: card\.like\.serverCount \}, card\.like\.holdUntil\);/, "kept when the server confirms a like");
  assert.match(app, /keepOwn\(slug, \{ comments: count \}, holdUntil\);/, "and a comment");
  assert.match(app, /applyOwn\(card, generatedAt, stored\);\n    card\.like = likeReduce\(card\.like, \{ type: "poll"/, "applied before a polled count is believed");
  assert.match(app, /if \(ev\.key === OWN_KEY\) \{/, "and a tab that is already open follows at once");
});

test("comments: a very long comment shows its start and a way to read the rest", () => {
  assert.equal(isLongComment("nice"), false);
  assert.equal(isLongComment("a".repeat(COMMENT_FOLD_CHARS)), false);
  assert.equal(isLongComment("a".repeat(COMMENT_FOLD_CHARS + 1)), true);
  assert.equal(isLongComment(Array.from({ length: COMMENT_FOLD_LINES }, () => "x").join("\n")), false);
  assert.equal(isLongComment(Array.from({ length: COMMENT_FOLD_LINES + 1 }, () => "x").join("\n")), true, "250 one-letter lines must not take over the page");
  assert.equal(isLongComment(null), false);
  assert.match(cssRule(".c-text.is-clamped"), new RegExp(`-webkit-line-clamp: ${COMMENT_FOLD_LINES}; line-clamp: ${COMMENT_FOLD_LINES}; overflow: hidden;`));
  const js = read("js/comments.js");
  assert.match(js, /if \(isLongComment\(c\.text\)\) \{/);
  assert.match(js, /"aria-expanded": String\(open\), text: open \? "Show less" : "Show all"/, "the control says what it does and its state");
  assert.match(js, /state\.unfolded\.add\(c\.id\)/, "an opened comment stays open when the list is redrawn");
});

test("closed: nothing on the page still promises a future end, and a like that arrives late is not dropped in silence", () => {
  const ends = formatEndsLine(Date.parse(VOTING_ENDS_AT));
  assert.equal(rulesEndLine(false, ends), `Voting ends ${ends}.`);
  assert.equal(rulesEndLine(true, ends), `Voting ended ${ends}.`);
  assert.ok(read("index.html").includes(`<li id="tbz-rule-ends">${rulesEndLine(false, ends)}</li>`), "the rules line as shipped is the open one, from the same function");
  const app = read("js/app.js");
  assert.match(app, /els\.ruleEnds\.textContent = rulesEndLine\(app\.closed, formatEndsLine\(app\.endMs\)\)/);
  assert.match(/function setClosed\(closed\) \{[\s\S]*?\n\}/.exec(app)[0], /renderRuleEnds\(\);/, "rewritten the moment the window closes or reopens");
  assert.match(app, /if \(app\.closed\) \{ setStatus\("late"\); return \{ ok: false \}; \}/, "the gate finished after the close: the page says the action was not counted");
  assert.match(app, /late: "Voting closed before that went through, so it was not counted\."/);
});

test("photo strip: one Tab stop however many photos; arrow keys move between them", () => {
  assert.equal(stripTarget(0, "ArrowRight", 200), 1);
  assert.equal(stripTarget(199, "ArrowRight", 200), 199, "stops at the last photo");
  assert.equal(stripTarget(0, "ArrowLeft", 200), 0);
  assert.equal(stripTarget(57, "ArrowLeft", 200), 56);
  assert.equal(stripTarget(57, "Home", 200), 0);
  assert.equal(stripTarget(57, "End", 200), 199);
  assert.equal(stripTarget(57, "Tab", 200), null, "Tab is not the strip's: it leaves it");
  assert.equal(stripTarget(0, "ArrowRight", 0), null);
  assert.equal(stripTarget(900, "ArrowLeft", 4), 2, "an index past the end is pulled back in");
  const strip = /<ul id="tbz-strip"[^>]*>/.exec(read("index.html"))[0];
  assert.ok(!/tabindex/.test(strip), "the list itself is not a stop");
  const js = read("js/gallery.js");
  assert.match(js, /all\.forEach\(\(btn, n\) => \{ btn\.tabIndex = n === current \? 0 : -1; \}\);/, "exactly one photo is in the Tab order (200 photos were 200 presses before VOTE)");
  assert.match(js, /const next = stripTarget\(current, ev\.key, photos\.length\);/);
  assert.match(js, /setCurrent\(0\);\n      requestAnimationFrame\(arrows\);/, "set each time the strip is rebuilt");
});

test("Back: with a popup open, the phone's Back button closes the popup instead of leaving the page", async () => {
  const listeners = {};
  const calls = [];
  const stack = [null];
  globalThis.window = { addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); } };
  globalThis.history = {
    get state() { return stack.at(-1); },
    pushState(state) { stack.push(state); calls.push("push"); },
    back() { calls.push("back"); stack.pop(); },
  };
  globalThis.document = { documentElement: { classList: { add() {}, remove() {} } }, querySelector: () => null };
  try {
    const { showModal, closeModal } = await import("../public/js/dom.js?back-button");
    const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
    const pop = () => listeners.popstate.forEach((fn) => fn({}));
    let dismissed = 0;
    const onBack = () => { dismissed += 1; closeModal(dialog); };

    // Back while it is open: the popup's own entry is what Back leaves, and the popup closes.
    showModal(dialog, onBack);
    assert.deepEqual([dialog.open, calls.join(), stack.length], [true, "push", 2], "opening adds one history entry");
    stack.pop(); pop(); // the browser goes back one entry
    assert.deepEqual([dismissed, dialog.open, calls.join(), stack.length], [1, false, "push", 1], "closed by Back, and the page did not step back a second time");

    // Closed by its own button: the popup's entry is taken back out, and that step closes nothing.
    showModal(dialog, onBack);
    closeModal(dialog);
    assert.deepEqual([dialog.open, calls.join(), stack.length], [false, "push,push,back", 1]);
    const other = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
    let otherDismissed = 0;
    showModal(other, () => { otherDismissed += 1; closeModal(other); });
    pop(); // the popstate from the page's own back(), arriving late
    assert.deepEqual([otherDismissed, other.open], [0, true], "the page's own step back never closes a popup that opened meanwhile");
    stack.pop(); pop();
    assert.deepEqual([otherDismissed, other.open], [1, false], "a real Back still does");

    // A dialog opened with no onBack (nothing asked for) touches no history.
    const plain = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
    const before = calls.length;
    showModal(plain); closeModal(plain);
    assert.equal(calls.length, before);
  } finally { delete globalThis.window; delete globalThis.history; delete globalThis.document; }
  assert.match(read("js/gate.js"), /showModal\(dialog, dismiss\);/, "the gate: Back drops the held action, the code stays good");
  assert.match(read("js/gallery.js"), /showModal\(box, close\);/, "the full-size photo too");
  assert.match(read("js/gate.js"), /if \(after\) setTimeout\(after, AFTER_CLOSE_MS\);/, "a held share hands over to Messages only after the popup's entry is gone");
});

test("phones: the lock screen names the track, and Android and iPhone each get their own text link", () => {
  assert.match(read("js/player.js"), /const artwork = Array\.isArray\(track\.artwork\) && track\.artwork\.length \? \{ artwork: track\.artwork \} : \{\};\s*navigator\.mediaSession\.metadata = new MediaMetadata\(\{ title: track\.title \|\| "CultureCon track", artist: track\.artist \|\| "Top Barz at CultureCon", \.\.\.artwork \}\)/, "the title, the artist, and artwork only when the track carries some (a booth track with a picture; since 4 Oct 2026)");
  assert.ok(!/artwork/.test(read("js/app.js")) && !/artwork/.test(read("js/select.js")), "the voting page and the select page pass no artwork");
  assert.match(read("js/app.js"), /hint: card\.audio\.duration, title: card\.track\.label \}\)/);
  assert.ok(!/\bartist\b/.test(read("js/app.js")), "the voting page names no artist of its own, so its tracks still say Top Barz at CultureCon");
  assert.ok(smsHref("android", "a & b").startsWith("sms:?body=a%20%26%20b"), "Android: sms:?body=, with & escaped so the text is not cut");
  assert.ok(smsHref("ios", "a & b").startsWith("sms:&body=a%20%26%20b"), "iPhone: sms:&body=");
  const code = /<input id="tbz-gate-code"[^>]*>/.exec(read("index.html"))[0];
  assert.match(code, /inputmode="numeric"/, "both show the number pad");
  assert.match(code, /autocomplete="one-time-code"/, "an iPhone offers the code from the email; Android offers it from the clipboard");
});

// ── Small formatters and guards ──────────────────────────────────────────────────────────────
test("formatters: track time, comment time, and what may be loaded", () => {
  assert.equal(formatClock(65.12), "1:05");
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(NaN), "0:00");
  const now = Date.parse("2026-10-05T16:00:00Z");
  assert.equal(relativeTime(now - 5_000, now), "just now");
  assert.equal(relativeTime(now + 5_000, now), "just now", "a comment a little ahead of our clock is not 'in the future'");
  assert.equal(relativeTime(now - 5 * 60_000, now), "5m");
  assert.equal(relativeTime(now - 3 * 3_600_000, now), "3h");
  assert.equal(relativeTime(now - 2 * 86_400_000, now), "2d");
  assert.equal(relativeTime(Date.parse("2026-09-20T16:00:00Z"), now), "Sep 20");
  assert.equal(safeGifUrl("https://media2.giphy.com/media/abc/giphy.gif"), "https://media2.giphy.com/media/abc/giphy.gif");
  for (const bad of ["http://media.giphy.com/x.gif", "https://giphy.com.evil.example/x.gif", "https://evilgiphy.com/x.gif", "javascript:alert(1)", "data:image/gif;base64,AAAA", "", null]) assert.equal(safeGifUrl(bad), null, String(bad));
  assert.equal(safeMediaUrl("/media/tracks/brian-3290fefeb1.mp3"), "/media/tracks/brian-3290fefeb1.mp3");
  for (const bad of ["https://evil.example/a.mp3", "//evil.example/a.mp3", "/media/../api/state", "/api/state", "javascript:alert(1)", null]) assert.equal(safeMediaUrl(bad), null, String(bad));
});

// ── Copy ─────────────────────────────────────────────────────────────────────────────────────
test("copy: Top Barz, JUMP IN THE BOOTH, 11:59 PM PDT, for them and their friends, and never the banned lines", () => {
  assert.ok(HTML.includes("index.html") && HTML.includes("privacy.html") && JS.length >= 7, `read ${HTML.length} pages and ${JS.length} scripts`);
  for (const file of [...HTML, ...JS, "css/site.css"]) {
    const text = read(file);
    assert.ok(!/spit\s+(your|ur|yo)\s+bars/i.test(text), `${file}: never "spit your bars"`);
    assert.ok(!/\bPST\b/.test(text), `${file}: California time on Oct 11 is PDT, never PST`);
    assert.ok(!/them and friends/i.test(text), `${file}: "for them and their friends"`);
    // The brand name in words is always "Top Barz". (topbarz.xyz and topbarz-voting are addresses.)
    const words = text.replace(/topbarz\.xyz|topbarz-voting/g, "");
    for (const m of words.matchAll(/top[\s_-]*barz/gi)) assert.equal(m[0], "Top Barz", `${file}: "${m[0]}" should be "Top Barz"`);
    for (const m of text.matchAll(/jump\s+in\s+the\s+booth/gi)) assert.equal(m[0], "JUMP IN THE BOOTH", `${file}: the slogan is capitals`);
    // No address of a real person. The only one on the page is the form's placeholder.
    for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/g)) assert.equal(m[0], "you@example.com", `${file}: an email address is on the page: ${m[0]}`);
  }

  const index = read("index.html");
  const body = index.slice(index.indexOf("<body"));
  assert.match(body, /<h1 class="slogan">JUMP IN THE BOOTH<\/h1>/);
  assert.equal([...body.matchAll(/<img\b[^>]*alt="Top Barz"/g)].length, 1, "the logo, once");
  const header = /<header class="top">[\s\S]*?<\/header>/.exec(body)[0];
  assert.ok(!/>\s*Top Barz\s*</.test(header), '"Top Barz" is not repeated under the logo');
  assert.equal([...body.matchAll(/TRACKS FROM CULTURECON/g)].length, 1, "the tracks heading appears once");
  assert.match(body, /the winner wins a free studio session for them and their friends\./);
  assert.ok(body.includes("The winner gets a free studio session for them and their friends at Studio404 in Brooklyn. Travel is not included, so winners outside New York need to come to New York."), "the prize wording, exactly as locked");

  // The date on the page is the one in config.js, written by the same function the page uses.
  const ends = formatEndsLine(Date.parse(VOTING_ENDS_AT));
  assert.ok(ends.endsWith("11:59 PM PDT"));
  assert.ok(body.includes(`<strong id="tbz-ends">${ends}</strong>`), "the voting-ends line");
  const dated = [...index.matchAll(/(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), [A-Z][a-z]+ \d{1,2} at \d{1,2}:\d{2} [AP]M [A-Z]{2,4}/g)].map((m) => m[0]);
  assert.ok(dated.length >= 4, "the end time is on the page, in the rules, and in the link preview");
  for (const d of dated) assert.equal(d, ends);
  assert.equal([...index.matchAll(/11:59/g)].length, dated.length, "every 11:59 on the page is the full line with PM PDT");
  assert.match(read("js/app.js"), /els\.ends\.textContent = formatEndsLine\(app\.endMs\)/, "and the live page rewrites it from the server's end time");

  assert.match(read("js/logic.js"), /`\$\{label\} wants you to vote on their track from the Top Barz experience \$\{link\}`/);
});

test("link preview: Open Graph tags and a 1200x630 image", async () => {
  const index = read("index.html");
  const meta = (prop) => new RegExp(`<meta (?:property|name)="${prop}" content="([^"]+)">`).exec(index)?.[1];
  assert.equal(meta("og:title"), "Vote for your favorite CultureCon track | Top Barz");
  assert.equal(meta("og:url"), "https://voting.topbarz.xyz/");
  assert.equal(meta("og:image"), "https://voting.topbarz.xyz/img/og.png");
  assert.equal(meta("twitter:card"), "summary_large_image");
  assert.ok(meta("og:description")?.length > 40 && meta("og:image:alt"));
  const sharp = (await import("sharp")).default;
  const info = await sharp(path.join(PUBLIC, "img/og.png")).metadata();
  assert.deepEqual([info.width, info.height, meta("og:image:width"), meta("og:image:height")], [1200, 630, "1200", "630"]);
  assert.ok(fs.statSync(path.join(PUBLIC, "img/og.png")).size < 300_000, "small enough for a text preview");
});

// ── Wiring: nothing the page needs is missing, nothing inline, nothing heavy ─────────────────
// Each page that runs a script, and the one script it runs. Every other script is reached from
// one of these by import, and belongs to the page (or pages) that reach it.
const PAGE_SCRIPTS = { "index.html": "app.js", "select.html": "select.js", "booth.html": "booth.js", "track.html": "track.js", "listen.html": "listen.js" };
// What each pair of pages may have in common. The vote's page shares its helpers and player with
// the select page, the rapper's page and the listen page (the same four files for each); the
// engineer's page takes only the DOM helpers; the three booth pages share the booth's rules.
const SHARED = {
  "app.js+select.js": ["api.js", "dom.js", "logic.js", "player.js"],
  "app.js+track.js": ["api.js", "dom.js", "logic.js", "player.js"],
  "app.js+listen.js": ["api.js", "dom.js", "logic.js", "player.js"],
  "app.js+booth.js": ["dom.js"],
  "booth.js+select.js": ["dom.js"],
  "select.js+track.js": ["api.js", "dom.js", "logic.js", "player.js"],
  "listen.js+select.js": ["api.js", "dom.js", "logic.js", "player.js"],
  "booth.js+track.js": ["booth-rules.js", "dom.js"],
  "booth.js+listen.js": ["booth-rules.js", "dom.js"],
  "listen.js+track.js": ["api.js", "booth-rules.js", "dom.js", "logic.js", "player.js"],
};
// The scripts of the two vote-side pages (the same eleven files as before the booth existed),
// and the scripts that belong only to the booth's three pages (/booth, /track, /listen).
const VOTE_SCRIPTS = ["api.js", "app.js", "comments.js", "dom.js", "gallery.js", "gate.js", "logic.js", "pick.js", "player.js", "select-copy.js", "select.js"];
const BOOTH_ONLY_SCRIPTS = ["booth-copy.js", "booth-rules.js", "booth.js", "listen-copy.js", "listen.js", "track-copy.js", "track.js"];
function scriptsOf(entry) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of read(`js/${file}`).matchAll(/from "\.\/([^"]+)"/g)) {
      assert.ok(fs.existsSync(path.join(PUBLIC, "js", m[1])), `${file} imports ${m[1]}`);
      walk(m[1]);
    }
  };
  walk(entry);
  return [...seen].sort();
}

test("wiring: every file a page names exists; every element a page's scripts look up is in that page", () => {
  for (const page of HTML) {
    const html = read(page);
    const local = [...html.matchAll(/\b(?:src|href)="(\/[^"#?]*)"/g)].map((m) => m[1]).filter((p) => p !== "/");
    assert.ok(local.length >= 5, `${page} names its files`);
    for (const p of local) {
      const file = path.join(PUBLIC, p);
      assert.ok(fs.existsSync(file) || fs.existsSync(`${file}.html`), `${page} names ${p}, which is not in public/`);
    }
    const named = [...html.matchAll(/"\/js\/([^"]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(named, page in PAGE_SCRIPTS ? scriptsOf(PAGE_SCRIPTS[page]) : [], `${page} loads or preloads exactly the scripts it uses: no more, no fewer`);
    assert.equal([...html.matchAll(/<script\b/g)].length, page in PAGE_SCRIPTS ? 1 : 0, `${page} runs one script, or none`);
  }
  const lookups = {};
  const owned = new Set();
  for (const [page, entry] of Object.entries(PAGE_SCRIPTS)) {
    const html = read(page);
    assert.match(html, new RegExp(`<script type="module" src="/js/${entry.replace(".", "\\.")}"></script>`));
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    assert.equal(ids.size, [...html.matchAll(/\bid="([^"]+)"/g)].length, `${page}: no id is used twice`);
    for (const id of ids) assert.ok(id.startsWith("tbz-"), `${page} #${id}: page ids start with tbz-, so a track's own link can never collide with one`);
    lookups[page] = 0;
    for (const file of scriptsOf(entry)) {
      owned.add(`js/${file}`);
      for (const m of read(`js/${file}`).matchAll(/\$\("([^"]+)"\)/g)) { lookups[page]++; assert.ok(ids.has(m[1]), `${file} looks up #${m[1]}, which is not in ${page}`); }
    }
  }
  assert.deepEqual([...owned].sort(), [...JS].sort(), "every script in public/js belongs to a page");
  assert.ok(lookups["index.html"] >= 40, `checked ${lookups["index.html"]} element lookups in index.html`);
  assert.ok(lookups["select.html"] >= 15, `checked ${lookups["select.html"]} element lookups in select.html`);
  assert.ok(lookups["booth.html"] >= 20, `checked ${lookups["booth.html"]} element lookups in booth.html`);
  assert.ok(lookups["track.html"] >= 22, `checked ${lookups["track.html"]} element lookups in track.html`);
  assert.ok(lookups["listen.html"] >= 9, `checked ${lookups["listen.html"]} element lookups in listen.html`);
  // No page loads anything of another page's own: each pair shares exactly what SHARED says.
  const entries = Object.values(PAGE_SCRIPTS);
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [a, b] = [entries[i], entries[j]].sort();
      const shared = scriptsOf(a).filter((f) => scriptsOf(b).includes(f));
      assert.ok(`${a}+${b}` in SHARED, `SHARED names the pair ${a}+${b}`);
      assert.deepEqual(shared, SHARED[`${a}+${b}`], `${a} and ${b} share exactly these, and nothing else`);
    }
  }
  assert.equal(Object.keys(SHARED).length, (entries.length * (entries.length - 1)) / 2, "every pair is named");
  assert.deepEqual([...new Set([...scriptsOf("app.js"), ...scriptsOf("select.js")])].sort(), VOTE_SCRIPTS, "the vote's two pages still run exactly the eleven scripts they did");
  assert.deepEqual([...new Set([...scriptsOf("booth.js"), ...scriptsOf("track.js"), ...scriptsOf("listen.js")])].filter((f) => !VOTE_SCRIPTS.includes(f)).sort(), BOOTH_ONLY_SCRIPTS, "and these belong only to the booth's pages");
  assert.deepEqual([...VOTE_SCRIPTS, ...BOOTH_ONLY_SCRIPTS].sort(), [...JS].map((f) => f.replace(/^js\//, "")).sort(), "the two lists are every script there is");
});

test("safety: text is never written as markup, nothing runs inline, and the page loads only its own files and Giphy's GIFs", () => {
  for (const file of JS) {
    const js = read(file);
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/.test(js), `${file}: comments and labels go in as text, never as HTML`);
  }
  for (const page of HTML) {
    const html = read(page);
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), `${page}: no inline script`);
    assert.ok(!/<style\b|\sstyle="/.test(html), `${page}: no inline style`);
    assert.ok(!/\son[a-z]+="/.test(html), `${page}: no inline handlers`);
    assert.ok(!/(?:src|href)="https?:\/\/(?!www\.topbarz\.xyz\/|www\.instagram\.com\/topbarz\.xyz|voting\.topbarz\.xyz\/)/.test(html), `${page}: nothing is loaded from another site`);
  }
  const headers = read("_headers");
  const csp = /Content-Security-Policy: (.+)/.exec(headers)?.[1] ?? "";
  for (const rule of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' https://*.giphy.com", "media-src 'self'", "connect-src 'self'", "frame-ancestors 'none'"]) {
    assert.ok(csp.split("; ").includes(rule), `the policy says: ${rule}`);
  }
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
});

test("weight: no libraries, and the whole page is small", () => {
  const size = (rel) => fs.statSync(path.join(PUBLIC, rel)).size;
  const pageJs = (entry) => scriptsOf(entry).reduce((n, f) => n + size(`js/${f}`), 0);
  const js = pageJs("app.js");
  const fonts = fs.readdirSync(path.join(PUBLIC, "fonts")).reduce((n, f) => n + size(`fonts/${f}`), 0);
  assert.ok(js < 110_000, `the voting page's scripts are ${js} bytes before compression`);
  assert.ok(pageJs("select.js") < 60_000, `the select page's scripts are ${pageJs("select.js")} bytes before compression`);
  const voteJs = VOTE_SCRIPTS.reduce((n, f) => n + size(`js/${f}`), 0);
  const boothJs = BOOTH_ONLY_SCRIPTS.reduce((n, f) => n + size(`js/${f}`), 0);
  assert.ok(voteJs < 120_000, `the scripts of the voting and select pages together are ${voteJs} bytes (the same eleven files as before the booth)`);
  assert.ok(boothJs < 31_000, `the scripts belonging only to booth/track/listen are ${boothJs} bytes together (29,143 on 4 Oct 2026; was < 30_000 for booth/track alone: the listen page and the share added listen.js, listen-copy.js and the share rules)`);
  assert.equal(voteJs + boothJs, JS.reduce((n, f) => n + size(f), 0), "and the two together are every script in public/js");
  assert.ok(pageJs("track.js") < 60_000, `the rapper's page's scripts are ${pageJs("track.js")} bytes before compression`);
  assert.ok(pageJs("booth.js") < 20_000, `the engineer's page's scripts are ${pageJs("booth.js")} bytes before compression`);
  assert.ok(pageJs("listen.js") < 60_000, `the listen page's scripts are ${pageJs("listen.js")} bytes before compression`);
  assert.ok(size("css/site.css") < 40_000);
  assert.ok(size("index.html") < 20_000);
  assert.ok(size("select.html") < 8_000);
  assert.ok(size("booth.html") < 8_000);
  assert.ok(size("track.html") < 8_000);
  assert.ok(size("listen.html") < 8_000);
  assert.ok(size("track-qr.html") < 8_000);
  assert.ok(size("img/track-qr.svg") < 20_000);
  assert.ok(fonts < 60_000, `fonts are ${fonts} bytes`);
  assert.ok(size("img/logo.png") < 30_000);
  for (const file of [...HTML, ...JS]) assert.ok(!/\bcdn\.|unpkg|jsdelivr|googleapis|gstatic|jquery|\breact\b/i.test(read(file)), `${file}: no library, no CDN`);
});
