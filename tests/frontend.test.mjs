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
  assert.match(gate, /We use your email to count your vote and to send contest results\.[^<]*<a href="\/privacy"/, "one line on what the email is for, and the privacy note");
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
  assert.match(gate, /<p id="tbz-gate-code-help" class="code-help">It works for 10 minutes\./);
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
  const gate = createGate({
    onVoter: (data) => seen.voters.push(data),
    runHeld: async (action) => { seen.held.push(action); return { ok: true, done: "Vote counted" }; },
    heldLine: (action) => (action ? `held:${action.type}:${action.slug}` : "nothing held"),
    codesOn: () => true,
  });
  const $ = (id) => { const el = doc.getElementById(`tbz-gate${id ? `-${id}` : ""}`); assert.ok(el, `#tbz-gate-${id} is in index.html`); return el; };
  function snapshot() {
    return { state: $("submit").dataset.state, disabled: $("submit").disabled, text: $("submit-text").textContent };
  }
  const fill = (email = "jane@example.com") => { $("email").value = email; $("name").value = "Jane Doe"; $("city").value = "Oakland"; };
  const type = async (digits) => { $("code").value = digits; await $("code").fire("input"); };
  const stored = () => (store.has("tbz.pending") ? JSON.parse(store.get("tbz.pending")) : null);
  return { gate, $, calls, seen, store, stored, fill, type, snapshot, doc, tick: (ms) => t.mock.timers.tick(ms) };
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
  assert.equal(h.doc.activeElement, h.$("code"));
  assert.equal(h.$("resend").textContent, "Send a new code in 60 s");

  // Expired, as the server says it…
  await h.type("444444");
  assert.equal(h.$("code-error").textContent, "That code has expired. Send a new one.");
  assert.equal(h.$("submit").disabled, true);
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
  assert.equal(h.doc.activeElement, h.$("resend"));
  assert.equal(h.calls.length, 1);
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
test("wiring: every file a page names exists; every element the scripts look up is in index.html", () => {
  for (const page of HTML) {
    const html = read(page);
    const local = [...html.matchAll(/\b(?:src|href)="(\/[^"#?]*)"/g)].map((m) => m[1]).filter((p) => p !== "/");
    assert.ok(local.length >= 5, `${page} names its files`);
    for (const p of local) {
      const file = path.join(PUBLIC, p);
      assert.ok(fs.existsSync(file) || fs.existsSync(`${file}.html`), `${page} names ${p}, which is not in public/`);
    }
  }
  const index = read("index.html");
  const ids = new Set([...index.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  assert.equal(ids.size, [...index.matchAll(/\bid="([^"]+)"/g)].length, "no id is used twice");
  let lookups = 0;
  for (const file of JS) {
    const js = read(file);
    for (const m of js.matchAll(/\$\("([^"]+)"\)/g)) { lookups++; assert.ok(ids.has(m[1]), `${file} looks up #${m[1]}, which is not in index.html`); }
    for (const m of js.matchAll(/from "(\.\/[^"]+)"/g)) assert.ok(fs.existsSync(path.join(PUBLIC, "js", m[1])), `${file} imports ${m[1]}`);
    assert.ok(index.includes(`"/js/${path.basename(file)}"`), `index.html loads or preloads ${file}`);
  }
  assert.ok(lookups >= 40, `checked ${lookups} element lookups`);
  for (const id of ids) assert.ok(id.startsWith("tbz-"), `#${id}: page ids start with tbz-, so a track's own link can never collide with one`);
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
  const js = JS.reduce((n, f) => n + size(f), 0);
  const fonts = fs.readdirSync(path.join(PUBLIC, "fonts")).reduce((n, f) => n + size(`fonts/${f}`), 0);
  assert.ok(js < 120_000, `scripts are ${js} bytes before compression`);
  assert.ok(size("css/site.css") < 40_000);
  assert.ok(size("index.html") < 20_000);
  assert.ok(fonts < 60_000, `fonts are ${fonts} bytes`);
  assert.ok(size("img/logo.png") < 30_000);
  for (const file of [...HTML, ...JS]) assert.ok(!/\bcdn\.|unpkg|jsdelivr|googleapis|gstatic|jquery|\breact\b/i.test(read(file)), `${file}: no library, no CDN`);
});
