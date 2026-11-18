// The holiday party's pages (Scooter, 17 Nov 2026, with his preview notes): /join (a group on one
// phone, handed around), /team (four lanes), the contest entry on /track, the upload-station picker
// on /booth, the gallery GIFs, the festive look with the partners' logos, the QR sign and the draft rules.
// Their pure rules (public/js/party-rules.js, imported as the browser imports it) and what the
// shipped files keep, show and refuse.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { joinQrSvg, JOIN_URL } from "../scripts/make-join-qr.mjs";
import {
  GROUP_MAX, GUEST_KEY, LINE_POLL_MS, STATUS, TEAM_KEY, UNDO_MS, cleanContest, contestLine, groupLabel, groupSmsHref, isTeamToken, joinPayload, moves, nextTwo, placeWords,
} from "../public/js/party-rules.js";
import { GROUP_MAX as SERVER_GROUP_MAX, LANES } from "../functions/_lib/party.js";
import { COPY as JOIN } from "../public/js/join-copy.js";
import { COPY as TEAM } from "../public/js/team-copy.js";
import { COPY as TRACK } from "../public/js/track-copy.js";
import { HOLIDAY } from "../public/js/party-copy.js";
import { ROOT } from "./helpers.mjs";

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("group sign-up on one phone: no codes; the page and the server allow the same group size; every slot is checked, with the slot and the field to fix", () => {
  assert.equal(GROUP_MAX, SERVER_GROUP_MAX);
  const ok = { name: " Jay ", phone: "555 010 2030", email: " Jay@Example.com ", city: "Brooklyn", instagram: "" };
  const one = joinPayload([ok]);
  assert.equal(one.problem, null);
  assert.deepEqual(one.body, { guests: [{ name: "Jay", phone: "555 010 2030", email: "jay@example.com", city: "Brooklyn", instagram: "" }], website: "" });
  for (const [field, patch] of [["name", { name: "" }], ["phone", { phone: "12" }], ["email", { email: "jay" }], ["city", { city: "" }]]) {
    const { problem } = joinPayload([ok, { ...ok, email: "mo@example.com", ...patch }]);
    assert.deepEqual([problem.slot, problem.field], [1, field]);
    assert.ok(JOIN[problem.key], `${problem.key} has words`);
  }
  assert.deepEqual(joinPayload([ok, { ...ok, email: "JAY@example.com" }]).problem, { slot: 1, field: "email", key: "sameEmail" });
  const join = read("public/js/join.js");
  const html = read("public/join.html");
  assert.ok(!/session_code|group code|\?group=|tbz-join-code|tbz-join-move/i.test(join + html + JSON.stringify(JOIN)), "no group codes anywhere on the sign-up");
  assert.match(html, /<select id="tbz-join-size"><\/select>/, "how many of you, first");
  assert.match(join, /if \(app\.at < app\.size - 1\) \{ app\.at \+= 1; drawSlot\(\{ focus: true \}\); return; \}/, "Next moves to the next person; only the last one sends");
  assert.match(join, /const slot = Number\.isInteger\(err\?\.extra\?\.slot\) \? err\.extra\.slot : app\.at;/, "a refusal goes to the slot it is about");
  assert.match(JOIN.slotPass, /Pass the phone/);
  for (const f of ["name", "phone", "email", "city"]) assert.match(html, new RegExp(`id="tbz-join-${f}"[^>]*autocomplete="off"`), `${f}: the phone's autofill would put the first person's details in a friend's slot`);
});

test("the group's place, the team's four lanes and the two at the top of the line", () => {
  assert.deepEqual(Object.keys(STATUS), LANES, "the page and the server have the same lanes");
  assert.equal(placeWords(JOIN, { status: "booth" }), JOIN.placeNow);
  assert.equal(placeWords(JOIN, { status: "waiting", place: 1 }), "You're next. Stay close.");
  assert.equal(placeWords(JOIN, { status: "waiting", place: 4 }), "You're number 4 in line.");
  assert.equal(placeWords(JOIN, { status: "upload" }), JOIN.placeUpload);
  assert.equal(placeWords(JOIN, { status: "done" }), JOIN.placeDone);
  assert.deepEqual(moves("waiting"), ["booth"]);
  assert.deepEqual(moves("booth"), ["upload", "waiting"], "red takes a group out of the booth to the upload station");
  assert.deepEqual(moves("upload"), ["done", "booth"]);
  assert.deepEqual(moves("done"), ["upload"], "a group marked done by mistake goes back to the upload station");
  const s = (id, status) => ({ id, status });
  const { next, after, inBooth } = nextTwo([s(1, "booth"), s(5, "upload"), s(2, "waiting"), s(3, "waiting"), s(4, "waiting")]);
  assert.deepEqual([next.id, after.id, inBooth.map((x) => x.id)], [2, 3, [1]], "a group at the upload station is not in the booth");
  assert.equal(groupLabel(["Jay", "Mo", "Kim"]), "Jay, Mo & Kim");
  assert.ok(LINE_POLL_MS <= 5000, "the line refreshes at least every 5 s");
  assert.equal(UNDO_MS, 10000, "Undo stays for 10 s");
  const team = read("public/js/team.js");
  assert.match(team, /const upload = app\.sessions\.filter\(\(s\) => s\.status === "upload"\);[\s\S]*els\.upload\.replaceChildren\(\.\.\.upload\.map\(card\)\);/, "the upload station is its own lane on the page, apart from the line");
  assert.match(read("public/team.html"), /<ol id="tbz-team-upload" class="line"><\/ol>/);
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

test("the contest entry: one line everyone on the song sees the same, naming who ticked and who confirmed; listeners hear and download only; nothing else passes", () => {
  const c = cleanContest({ on: true, rules_url: "https://evil.example", title: "Sleigh", entered: false, closed: false, group: true, ticked: true, ticked_by: "Jay", confirmed: false, step: "needs_group", you: { performer: true, signed_up: true }, people: [{ first_name: "Jay", you: true, email: "x@y.co" }, { first_name: "Kim" }], blocked: "nope" });
  assert.equal(c.rules_url, "/holiday-rules", "the rules link is always our own page");
  assert.equal(c.blocked, null);
  assert.ok(!JSON.stringify(c).includes("@"), "no email gets through");
  assert.equal(contestLine(TRACK, c), "Jay ticked Enter. It goes in the vote once someone on the song confirms it with the group.");
  assert.equal(contestLine(TRACK, { ...c, entered: true, confirmed: true, confirmed_by: "Kim" }), "Entered by Jay, confirmed with the group by Kim: it's in the vote for Jay & Kim.");
  assert.equal(contestLine(TRACK, { ...c, group: false, entered: true }), "Entered by Jay: it's in the vote.");
  assert.equal(contestLine(TRACK, { ...c, ticked: false, ticked_by: null }), TRACK.contestNotYet);
  // A song that cannot go in says why, never a bare "cannot" (Scooter, 18 Nov 2026).
  for (const [where, why] of [["file", TRACK.blockedScooterFile], ["title", TRACK.blockedScooterTitle], ["person", TRACK.blockedScooterPerson], [undefined, TRACK.blockedScooterAny]]) {
    const line = contestLine(TRACK, cleanContest({ on: true, people: [], blocked: "scooter_taylor", blocked_where: where }));
    assert.equal(line, `${TRACK.contestBlocked} ${why} ${TRACK.blockedScooterRule}`);
  }
  assert.equal(contestLine(TRACK, cleanContest({ on: true, people: [], blocked: "test_file_in_production" })), `${TRACK.contestBlocked} ${TRACK.blockedTest}`);
  assert.equal(cleanContest({ on: true, blocked: "pulled_by_team", blocked_where: "file" }).blocked_where, null, "the where is only Scooter Taylor's rule");
  assert.equal(contestLine(TRACK, { ...c, blocked: "pulled_by_team" }), TRACK.contestPulled);
  assert.equal(cleanContest({ on: false }), null, "no contest, no box");
  assert.equal(cleanContest(undefined), null);
  // On the page: Enter starts unticked and links the rules in a new tab; the title and the group
  // confirmation come up after it; there is no Make public switch; a listener sees a plain line.
  const html = read("public/track.html");
  assert.match(html, /<input type="checkbox" id="tbz-contest-box">/);
  assert.ok(!/id="tbz-(contest|confirm)-box"[^>]*checked/.test(html), "unticked by default");
  assert.match(html, /<form id="tbz-title-form" class="code-form" novalidate hidden>/);
  assert.match(html, /<div id="tbz-confirm-row" class="check contest-check" hidden><input type="checkbox" id="tbz-confirm-box">/);
  const js = read("public/js/track.js");
  assert.match(js, /h\("a", \{ href: "\/holiday-rules", target: "_blank", rel: "noopener", text: COPY\.contestRules \}\)/);
  assert.match(js, /els\.titleForm\.hidden = !c\.ticked;/, "the title comes up once Enter is ticked");
  assert.match(js, /els\.confirmRow\.hidden = !\(c\.group && c\.ticked\);/, "Confirmed with your group only on a group song, after Enter");
  assert.match(js, /const flipContest = \(\) => sendContest\(els\.contestBox\.checked \? \{ enter: true, agree: true \} : \{ enter: false \}, els\.contestBox\);/, "a tick sends the rules agreement");
  assert.match(js, /const flipConfirm = \(\) => sendContest\(\{ enter: true, agree: true, group_confirmed: els\.confirmBox\.checked \}, els\.confirmBox\);/);
  assert.match(js, /for \(const el of \[els\.publicRow, els\.publicNote, els\.publicGroup, els\.voteRow, els\.voteNote\]\) el\.hidden = Boolean\(c\);/, "while the party is on, no Make public switch and no vote switch");
  assert.match(js, /els\.contest\.hidden = !performer;/, "only the song's own people see the entry");
  assert.match(js, /els\.listenOnly\.hidden = !c \|\| performer;/, "a listener is told they can hear and download");
  assert.ok(!/guest_key|GUEST_KEY|ownKey/.test(js), "the entry no longer needs the sign-up phone's key");
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
  assert.match(team, /els\.confirmYes\.addEventListener\("click", \(\) => \{\s*const p = app\.pending;\s*closeModal\(els\.confirm\);\s*if \(p\?\.group\) assignGroup\(p\.song, p\.group\);\s*else if \(p\?\.person\) removePerson\(p\.song, p\.person\);\s*else if \(p\?\.song\) pullSong\(p\.song, p\.pulled, \{ undoable: true \}\);\s*else if \(p\) change\(p\.s, p\.s\.status, p\.to, \{ undoable: true \}\);\s*\}\);/, "Yes makes the change (a group's status, a song in or out of the vote with Undo, a person off a song, or a group put on a song with nobody on it)");
  assert.match(team, /onclick: \(\) => askRemove\(song, p\)/, "Remove from this song only asks");
  assert.match(team, /onclick: \(\) => askAssign\(song, /, "Put this group on it only asks");
  // While the party is on, an upload with no group picked is asked first, ON the page (Scooter, 18
  // Nov 2026: the browser's pop-up was easy to miss), and nothing goes up until a button is tapped.
  const boothJs = read("public/js/booth.js");
  assert.match(boothJs, /if \(!els\.groups\.hidden && !app\.group && !walkUpOk\) \{ app\.lastFile = file; show\("walkup"\); els\.walkupPick\.focus\(\); return; \}/);
  assert.match(boothJs, /els\.walkupGo\.addEventListener\("click", \(\) => \{ const file = app\.lastFile; app\.lastFile = null; upload\(file, \{ walkUpOk: true \}\); \}\);/);
  assert.match(read("public/booth.html"), /<div id="tbz-walkup" class="walkup" role="alert" hidden>[\s\S]*id="tbz-walkup-pick"[\s\S]*id="tbz-walkup-go"/);
  for (const f of ["booth.js", "track.js", "team.js", "join.js", "app.js"]) assert.ok(!/window\.(confirm|alert|prompt)\(/.test(read(`public/js/${f}`)), `${f}: no browser pop-up`);
  assert.match(team, /p\.in \? null : h\("button"/, "no Remove button for a person who ticked");
  assert.match(team, /els\.undo\.addEventListener\("click", \(\) => \{\s*const u = app\.undo;\s*if \(u\?\.song\) pullSong\(u\.song, u\.pulled, \{ undoable: false \}\);\s*else if \(u\) change\(u\.s, u\.from, u\.to, \{ undoable: false \}\);\s*\}\);/);
  assert.match(team, /onclick: \(\) => askSong\(s, true\)/, "Take out of the vote only asks");
  assert.match(team, /onclick: \(\) => askSong\(s, false\)/, "Put back only asks");
  assert.match(team, /els\.confirmNo\.focus\(\);/, "the keyboard lands on Cancel, so Enter never changes a status by mistake");
  for (const k of ["empty", "unreachable", "loading", "intro", "headline"]) assert.ok(TEAM[k], k);
  assert.equal(TEAM.empty, "Nobody in line yet. Put the QR sign up and the first sign-up shows here.");
  assert.match(read("public/team.html"), /<meta name="robots" content="noindex">/);
});

test("the partners: white marks made from the files Scooter sent, one row under the Top Barz logo, each sized by weight within 20 to 46 px; the prize is a marked placeholder; the rules page is a DRAFT, 21 and over, preview only", async () => {
  assert.deepEqual(HOLIDAY.partners.map((p) => p.name), ["Flow Music", "Dick and Jane's", "Blitz and Bubbles"]);
  for (const p of HOLIDAY.partners) {
    assert.ok(p.desktop >= 20 && p.desktop <= 46 && p.mobile >= 20 && p.mobile <= 46, `${p.name}: ${p.mobile}/${p.desktop} px`);
    assert.ok(fs.existsSync(path.join(ROOT, "public", p.src)), p.src);
  }
  assert.ok(new Set(HOLIDAY.partners.map((p) => p.desktop)).size > 1, "by visual weight, not one matching height");
  // White marks: every pixel white (no inverted image), the mark carried by transparency.
  const sharp = (await import("sharp")).default;
  const { LOGOS } = await import("../scripts/make-partner-logos.mjs");
  for (const l of LOGOS) {
    const file = path.join(ROOT, "public/img/partners", `${l.name}.png`);
    const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.channels, 4);
    let opaque = 0;
    for (let i = 0; i < data.length; i += 4) { assert.ok(data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255, `${l.name}: white only`); if (data[i + 3] > 128) opaque++; }
    assert.ok(opaque > 1000, `${l.name}: the mark is there`);
    const shown = HOLIDAY.partners.find((p) => p.src === `/img/partners/${l.name}.png`);
    assert.deepEqual([shown.width, shown.height], [info.width, info.height], `${l.name}: the page reserves the mark's real size`);
  }
  // Scooter, 19:44Z 17 Nov 2026: "use this Blitz & Bubbles logo instead of the one in my last email.
  // It's already white". The committed mark is that file (wide, 782 x 270), never the first one.
  assert.equal(LOGOS.find((l) => l.name === "blitz-and-bubbles").ink, "white");
  const { checkSource, REPLACED } = await import("../scripts/make-partner-logos.mjs");
  const blitz = LOGOS.find((l) => l.name === "blitz-and-bubbles");
  assert.equal(blitz.sha1, "0007630642b891488423bb0b4d39a8a686cd16fc", "made from the 19:44Z file");
  assert.ok(REPLACED["blitz-and-bubbles"].includes("a11f567a4d9634309c8499162b06c1abf80e7a19"), "the first file is named as replaced");
  for (const l of LOGOS) assert.match(l.sha1, /^[0-9a-f]{40}$/, `${l.name}: its source is pinned`);
  assert.throws(() => checkSource(blitz, Buffer.from("not his file")), /REFUSED blitz-and-bubbles/, "any other bytes are refused");
  assert.deepEqual((({ width, height }) => [width, height])(await sharp(path.join(ROOT, "public/img/partners/blitz-and-bubbles.png")).metadata()), [782, 270]);
  const festive = read("public/js/festive.js");
  assert.match(festive, /top\.querySelector\("\.logo"\)\?\.after\(partnerRow\(\)\);/, "the row sits under the Top Barz logo");
  assert.match(festive, /if \(on\) dressUp\(\);/, "off, the page is exactly as it was");
  const css = read("public/css/site.css");
  assert.match(css, /\.partners-row img \{ display: block; height: var\(--h-phone\); width: auto; opacity: 0\.9; \}/);
  assert.match(css, /\.logo img \{ width: 116px; \}/, "the Top Barz logo keeps its size (116 px wide, about 102 px tall)");
  assert.ok(!/culturecon/i.test(JSON.stringify(HOLIDAY)), "no CultureCon in the party's words");
  assert.match(HOLIDAY.home.lede, /JUMP IN THE BOOTH/);
  assert.equal(HOLIDAY.prize, "The winner wins a bar tab at Dick and Jane's.");
  assert.match(festive, /h\("span", \{ class: "stand-in-mark", text: `\(\$\{HOLIDAY\.prizeMark\}\)` \}\)/, "the prize always shows with its placeholder mark");
  const rules = read("public/holiday-rules.html");
  assert.match(rules, /<meta name="robots" content="noindex">/);
  assert.match(rules, /<p class="draft-banner" role="note">DRAFT\./);
  assert.match(rules, /21 years of age or older/);
  assert.match(rules, /No purchase is necessary/);
  assert.match(rules, /\[Open: Top Barz is still deciding whether one participant may confirm for the group/, "the waiver question is marked open in the draft");
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

test("the gallery: the team's GIFs replace the photos while there are any, with Giphy's mark", () => {
  const gallery = read("public/js/gallery.js");
  assert.match(gallery, /const list = gifList\.length \? gifList : photoList;/, "the picked GIFs take the photos' place (Scooter, 17 Nov 2026)");
  assert.match(gallery, /url: safeGifUrl\(g\?\.url\)/, "a GIF is shown only from Giphy's own https address");
  assert.match(gallery, /by\.hidden = gifList\.length === 0;/);
  assert.match(read("public/index.html"), /<p id="tbz-gallery-by" class="gif-by gallery-by" hidden>Powered by GIPHY<\/p>/);
  assert.match(read("public/js/app.js"), /gallery\.update\(state\.photos, state\.gifs\);/);
});

test("the party's dates (Scooter, 18 Nov 2026): Sunday, December 13 and voting ends Friday, December 18, with no cutoff time shown as set", () => {
  assert.deepEqual(HOLIDAY.dates, { party: "Sunday, December 13", votingEnds: "Friday, December 18", timeMark: "exact time to be confirmed" });
  assert.equal(HOLIDAY.home.endsPending, "Friday, December 18 (exact time to be confirmed)");
  assert.equal(HOLIDAY.home.ruleEndsPending, "Voting ends Friday, December 18 (exact time to be confirmed).");
  assert.ok(HOLIDAY.home.lede.includes(HOLIDAY.dates.party), "the party's day is on the voting page");
  assert.ok(!/\b\d{1,2}(:\d{2})?\s*(AM|PM)\b/i.test(HOLIDAY.home.endsPending + HOLIDAY.home.ruleEndsPending), "no time of day while the cutoff is unset");
  const rules = read("public/holiday-rules.html");
  for (const day of ["Sunday, December 13, 2026", "Friday, December 18, 2026"]) assert.ok(rules.includes(day), `the rules draft carries ${day}`);
  assert.ok(!/the event date, the voting window/.test(rules), "the dates are no longer listed as unknown");
});
