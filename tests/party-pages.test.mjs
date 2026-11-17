// The holiday party's pages (Scooter, 17 Nov 2026): /join, /team, the contest box on /track, the
// group picker on /booth, the gallery GIFs, the festive look, the QR sign and the draft rules.
// Their pure rules (public/js/party-rules.js, imported as the browser imports it) and what the
// shipped files keep, show and refuse.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { joinQrSvg, JOIN_URL } from "../scripts/make-join-qr.mjs";
import {
  GUEST_KEY, LINE_POLL_MS, TEAM_KEY, UNDO_MS, cleanContest, contestLine, contestPerson, groupFromSearch, groupLabel, groupSmsHref, isSessionCode, isTeamToken, joinLink, joinPayload, moves, nextTwo, placeWords, sessionCodeFrom,
} from "../public/js/party-rules.js";
import { SESSION_LETTERS } from "../functions/_lib/party.js";
import { COPY as JOIN } from "../public/js/join-copy.js";
import { COPY as TEAM } from "../public/js/team-copy.js";
import { COPY as TRACK } from "../public/js/track-copy.js";
import { HOLIDAY } from "../public/js/party-copy.js";
import { ROOT } from "./helpers.mjs";

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("group codes: the page and the server use the same letters; a shared link fills the code in", async () => {
  assert.equal((await import("../public/js/party-rules.js")).SESSION_LETTERS, SESSION_LETTERS);
  assert.equal(sessionCodeFrom("jx-q p9"), "JXQP");
  assert.ok(isSessionCode("JXQP") && !isSessionCode("JXQO"));
  assert.equal(groupFromSearch("?group=jxqp"), "JXQP");
  assert.equal(groupFromSearch("?group=nope1"), "");
  assert.equal(joinLink("https://voting.topbarz.xyz", "JXQP"), "https://voting.topbarz.xyz/join?group=JXQP");
});

test("sign-up form: every required field is asked for in plain words, with the field to fix", () => {
  const ok = { name: " Jay ", phone: "555 010 2030", email: " Jay@Example.com ", city: "Brooklyn", instagram: "", withGroup: false, code: "", website: "" };
  assert.equal(joinPayload(ok).problem, null);
  assert.equal(joinPayload(ok).body.email, "jay@example.com");
  assert.equal(joinPayload(ok).body.session_code, null);
  for (const [field, patch] of [["name", { name: "" }], ["phone", { phone: "12" }], ["email", { email: "jay" }], ["city", { city: "" }], ["code", { withGroup: true, code: "JX" }]]) {
    const { problem } = joinPayload({ ...ok, ...patch });
    assert.equal(problem.field, field);
    assert.ok(JOIN[problem.key], `${problem.key} has words`);
  }
  assert.equal(joinPayload({ ...ok, withGroup: true, code: "jxqp" }).body.session_code, "JXQP");
});

test("the guest's place, the team's statuses and the two at the top of the line", () => {
  assert.equal(placeWords(JOIN, { status: "booth" }), JOIN.placeNow);
  assert.equal(placeWords(JOIN, { status: "waiting", place: 1 }), "You're next. Stay close.");
  assert.equal(placeWords(JOIN, { status: "waiting", place: 4 }), "You're number 4 in line.");
  assert.equal(placeWords(JOIN, { status: "out" }), JOIN.placeDone);
  assert.deepEqual(moves("waiting"), ["booth", "out"]);
  assert.deepEqual(moves("booth"), ["out", "waiting"]);
  assert.deepEqual(moves("out"), ["waiting"], "a group marked out by mistake can be put back");
  const s = (id, status) => ({ id, status });
  const { next, after, inBooth } = nextTwo([s(1, "booth"), s(2, "waiting"), s(3, "waiting"), s(4, "waiting")]);
  assert.deepEqual([next.id, after.id, inBooth.map((x) => x.id)], [2, 3, [1]]);
  assert.equal(groupLabel(["Jay", "Mo", "Kim"]), "Jay, Mo & Kim");
  assert.ok(LINE_POLL_MS <= 5000, "the line refreshes at least every 5 s");
  assert.equal(UNDO_MS, 10000, "Undo stays for 10 s");
});

test("Text them: every number in the group, the words filled in, Messages on the team's own phone; a computer gets none", () => {
  const phones = ["+1 (555) 010-2030", "5550104050"];
  const ios = groupSmsHref("ios", phones, TEAM.textMessage);
  assert.equal(ios, `sms:/open?addresses=+15550102030,5550104050&body=${encodeURIComponent(TEAM.textMessage)}`);
  assert.equal(groupSmsHref("ios", [phones[0]], "Hi"), "sms:+15550102030&body=Hi");
  assert.equal(groupSmsHref("android", phones, "Hi"), "sms:+15550102030,5550104050?body=Hi");
  assert.equal(groupSmsHref("desktop", phones, "Hi"), null);
  assert.equal(groupSmsHref("ios", ["call me"], "Hi"), null);
  assert.equal(TEAM.textMessage, "You're up at the Top Barz booth! Come on in.");
});

test("the contest box: first names with in or waiting, one line everyone sees the same, nothing else passes", () => {
  const c = cleanContest({ on: true, rules_url: "https://evil.example", title: "Sleigh", entered: false, closed: false, you: { in: true, signed_up: true }, people: [{ first_name: "Jay", in: true, you: true, email: "x@y.co" }, { first_name: "Kim", in: false }, { first_name: null, in: false }], waiting_on: ["Kim"], blocked: "nope" });
  assert.equal(c.rules_url, "/holiday-rules", "the rules link is always our own page");
  assert.equal(c.blocked, null);
  assert.ok(!JSON.stringify(c).includes("@"), "no email gets through");
  assert.equal(contestLine(TRACK, c), "Not entered yet: waiting on Kim");
  assert.equal(contestLine(TRACK, { ...c, entered: true }), TRACK.contestEntered);
  assert.equal(contestLine(TRACK, { ...c, blocked: "scooter_taylor" }), TRACK.contestBlocked);
  assert.deepEqual(c.people.map((p) => contestPerson(TRACK, p)), ["Jay (you): in ✓", "Kim: waiting", "Someone not signed up yet: waiting"]);
  assert.equal(cleanContest({ on: false }), null, "no contest, no box");
  assert.equal(cleanContest(undefined), null);
  // On the page: the box starts unticked, its label links the rules in a new tab, and it replaces the old switch.
  const html = read("public/track.html");
  assert.match(html, /<input type="checkbox" id="tbz-contest-box">/);
  assert.ok(!/id="tbz-contest-box"[^>]*checked/.test(html), "unticked by default");
  const js = read("public/js/track.js");
  assert.match(js, /h\("a", \{ href: "\/holiday-rules", target: "_blank", rel: "noopener", text: COPY\.contestRules \}\)/);
  assert.match(js, /body: \{ email: track\.you\.email, enter, agree: enter, \.\.\.\(enter \? \{ guest_key: ownKey\(\) \} : \{\}\) \}/, "a tick sends the rules agreement and this phone's own sign-up key with it");
  assert.match(js, /const ownKey = \(\) => \{ try \{ const k = localStorage\.getItem\(GUEST_KEY\); return isGuestKey\(k\) \? k : null; \} catch \{ return null; \} \};/, "the key is read from this phone only, never written here");
  assert.match(js, /if \(voteRow\) voteRow\.hidden = Boolean\(c\);/, "while the party is on the box takes the place of the public-vote switch");
  assert.match(js, /app\.contestTimer = setTimeout\(refreshContest, LINE_POLL_MS\);/, "and the status refreshes by itself");
});

test("what each page keeps on the phone: the guest's key, the team's token and its own email; never a guest's details", () => {
  assert.equal(GUEST_KEY, "tbz.party.guest");
  assert.equal(TEAM_KEY, "tbz.team");
  const join = read("public/js/join.js");
  assert.deepEqual([...join.matchAll(/localStorage\.(\w+)\(([^)]*)\)/g)].map((m) => `${m[1]}(${m[2]})`), ["getItem(GUEST_KEY)", "setItem(GUEST_KEY, k)", "removeItem(GUEST_KEY)"]);
  const team = read("public/js/team.js");
  assert.deepEqual([...team.matchAll(/localStorage\.(\w+)\(([^)]*?)\)(?=[;) ,])/g)].map((m) => m[1]), ["getItem", "setItem", "removeItem"]);
  assert.match(team, /localStorage\.setItem\(TEAM_KEY, JSON\.stringify\(\{ token, email: me \}\)\)/, "the token and the member's own email");
  for (const js of [join, team]) assert.ok(!/sessionStorage|document\.cookie|indexedDB/.test(js));
  assert.ok(isTeamToken(`t1.12.${"1".repeat(10)}.${"a".repeat(64)}`) && !isTeamToken("v1.12.abc"));
});

test("the team's page: every status change asks first and can be undone; no swipe can change anything", () => {
  const team = read("public/js/team.js");
  assert.ok(!/touchstart|touchend|touchmove|pointerdown|swipe/i.test(team), "no gestures on the team's page");
  assert.match(team, /onclick: \(\) => ask\(s, to\)/, "a status button only asks");
  assert.match(team, /els\.confirmYes\.addEventListener\("click", \(\) => \{\s*const p = app\.pending;\s*closeModal\(els\.confirm\);\s*if \(p\?\.song\) pullSong\(p\.song, p\.pulled, \{ undoable: true \}\);\s*else if \(p\) change\(p\.s, p\.s\.status, p\.to, \{ undoable: true \}\);\s*\}\);/, "Yes makes the change (a group's status, or a song in or out of the vote), with Undo");
  assert.match(team, /els\.undo\.addEventListener\("click", \(\) => \{\s*const u = app\.undo;\s*if \(u\?\.song\) pullSong\(u\.song, u\.pulled, \{ undoable: false \}\);\s*else if \(u\) change\(u\.s, u\.from, u\.to, \{ undoable: false \}\);\s*\}\);/);
  assert.match(team, /onclick: \(\) => askSong\(s, true\)/, "Take out of the vote only asks");
  assert.match(team, /onclick: \(\) => askSong\(s, false\)/, "Put back only asks");
  assert.match(team, /els\.confirmNo\.focus\(\);/, "the keyboard lands on Cancel, so Enter never changes a status by mistake");
  for (const k of ["empty", "unreachable", "loading", "intro", "headline"]) assert.ok(TEAM[k], k);
  assert.equal(TEAM.empty, "Nobody in line yet. Put the QR sign up and the first sign-up shows here.");
  assert.match(read("public/team.html"), /<meta name="robots" content="noindex">/);
});

test("stand-ins are marked, never promises; the rules page is a DRAFT, 21 and over, preview only", () => {
  for (const k of ["partnerName", "logo", "eventDate", "prize"]) assert.equal(HOLIDAY[k], "", `${k} waits for Scooter`);
  assert.equal(HOLIDAY.standIn.mark, "Stand-in");
  const festive = read("public/js/festive.js");
  assert.match(festive, /class: "stand-in", text: HOLIDAY\.standIn\[key\]/);
  assert.match(festive, /if \(on\) dressUp\(\);/, "off, the page is exactly as it was");
  const rules = read("public/holiday-rules.html");
  assert.match(rules, /<meta name="robots" content="noindex">/);
  assert.match(rules, /<p class="draft-banner" role="note">DRAFT\./);
  assert.match(rules, /21 years of age or older/);
  assert.match(rules, /No purchase is necessary/);
  assert.match(rules, /One person’s box does not enter the song for anyone else/);
  assert.match(read("functions/holiday-rules.js"), /if \(holidayOn\(context\.env\)\) return context\.next\(\);/, "served only where the party is on");
});

test("the QR sign encodes exactly the sign-up address, and the committed SVG is what the generator makes", async () => {
  assert.equal(JOIN_URL, "https://voting.topbarz.xyz/join");
  assert.equal(read("public/img/join-qr.svg"), await joinQrSvg());
  assert.match(read("public/join-qr.html"), /<img class="qr-code" src="\/img\/join-qr\.svg"/);
});

test("contrast: the team's green, red and waiting buttons carry dark text that passes; the lights are decoration", () => {
  const css = read("public/css/site.css");
  const tok = (name) => new RegExp(`--${name}: ([^;]+);`).exec(css)[1];
  const lum = (v) => {
    const m = /hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%/.exec(v);
    const [h, sat, l] = [Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100];
    const k = (n) => (n + h / 30) % 12;
    const a = sat * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(f(0)) + 0.7152 * lin(f(8)) + 0.0722 * lin(f(4));
  };
  const ratio = (a, b) => { const [x, y] = [lum(tok(a)), lum(tok(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const bg of ["color-go", "color-stop", "color-wait"]) assert.ok(ratio("color-status-ink", bg) >= 4.5, `text on ${bg}: ${ratio("color-status-ink", bg).toFixed(2)}`);
  assert.match(css, /\.bulb \{[^}]*animation: twinkle/, "the lights twinkle…");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ animation: none !important;/, "…and stand still for anyone who turns motion off");
  assert.match(read("public/js/festive.js"), /h\("div", \{ class: "lights", "aria-hidden": "true" \}/, "screen readers skip them");
});

test("the gallery shows the team's GIFs only until there are photos, with Giphy's mark", () => {
  const gallery = read("public/js/gallery.js");
  assert.match(gallery, /const gifList = photoList\.length \? \[\] :/, "photos first; GIFs only when there are none");
  assert.match(gallery, /url: safeGifUrl\(g\?\.url\)/, "a GIF is shown only from Giphy's own https address");
  assert.match(gallery, /by\.hidden = gifList\.length === 0;/);
  assert.match(read("public/index.html"), /<p id="tbz-gallery-by" class="gif-by gallery-by" hidden>Powered by GIPHY<\/p>/);
  assert.match(read("public/js/app.js"), /gallery\.update\(state\.photos, state\.gifs\);/);
});
