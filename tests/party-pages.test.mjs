// The holiday party's pages (Scooter, 17 Nov 2026, and his consolidated revision list of 18 Nov
// 2026): /join (one person each), /team (four lanes, the takes, the re-point), the song on /track
// (access for everyone with the code, the controls for everyone on the song, who last changed the entry, the three square buttons), the upload station on /booth, the gallery GIFs, the festive look with the partners' logos, the QR sign and the draft rules.
// Their pure rules (public/js/party-rules.js, imported as the browser imports it) and what the
// shipped files keep, show and refuse.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { joinQrSvg, JOIN_URL } from "../scripts/make-join-qr.mjs";
import {
  GUEST_KEY, LINE_POLL_MS, STATUS, TEAM_KEY, UNDO_MS, accessLine, andList, cleanContest, contestLine, flagWords, groupLabel, groupSmsHref, isTeamToken, joinPayload, moves, nextTwo, placeWords, recordings, songQuestion,
} from "../public/js/party-rules.js";
import { LANES } from "../functions/_lib/party.js";
import { COPY as JOIN } from "../public/js/join-copy.js";
import { COPY as TEAM } from "../public/js/team-copy.js";
import { COPY as TRACK } from "../public/js/track-copy.js";
import { HOLIDAY } from "../public/js/party-copy.js";
import { ROOT } from "./helpers.mjs";

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("individual sign-up (Scooter, 18 Nov 2026): one person, on their own phone, no codes, no group setup; every field checked; back in line with one tap once their song is up", () => {
  const ok = { name: " Jay ", phone: "555 010 2030", email: " Jay@Example.com ", city: "Brooklyn", instagram: "" };
  const one = joinPayload(ok);
  assert.equal(one.problem, null);
  assert.deepEqual(one.body, { name: "Jay", phone: "555 010 2030", email: "jay@example.com", city: "Brooklyn", instagram: "", website: "" });
  for (const [field, patch] of [["name", { name: "" }], ["phone", { phone: "12" }], ["email", { email: "jay" }], ["city", { city: "" }]]) {
    const { problem } = joinPayload({ ...ok, ...patch });
    assert.equal(problem.field, field);
    assert.ok(JOIN[problem.key], `${problem.key} has words`);
  }
  assert.equal(joinPayload(ok, "bot.example").body.website, "bot.example", "the honeypot goes to the server");
  const join = read("public/js/join.js");
  const html = read("public/join.html");
  assert.ok(!/session_code|group code|\?group=|tbz-join-code|tbz-join-move|tbz-join-size|Pass the phone/i.test(join + html + JSON.stringify(JOIN)), "no group codes and no group setup anywhere on the sign-up");
  for (const [f, ac] of [["name", "name"], ["phone", "tel"], ["email", "email"], ["city", "address-level2"]]) assert.match(html, new RegExp(`id="tbz-join-${f}"[^>]*autocomplete="${ac}"`), `${f}: the person's own phone fills in their own details`);
  // After a session ends, one tap puts the same person back in line, and the page says so.
  assert.match(html, /<button type="button" id="tbz-join-again" class="btn" hidden><\/button>/);
  assert.match(join, /els\.again\.hidden = s\.status !== "done";/, "Get back in line shows once their song is done");
  assert.match(join, /api\("\/api\/party\/rejoin", \{ method: "POST", body: \{ guest_key: app\.key \}/);
  assert.equal(JOIN.again, "Get back in line");
});

test("the group's place, the team's four lanes and the two at the top of the line", () => {
  assert.deepEqual(Object.keys(STATUS), LANES, "the page and the server have the same lanes");
  assert.equal(placeWords(JOIN, { status: "booth" }), JOIN.placeNow);
  assert.equal(placeWords(JOIN, { status: "waiting", place: 1 }), "You're next. Stay close.");
  assert.equal(placeWords(JOIN, { status: "waiting", place: 4 }), "You're number 4 in line.");
  assert.equal(placeWords(JOIN, { status: "upload" }), JOIN.placeUpload);
  assert.equal(placeWords(JOIN, { status: "done" }), JOIN.placeDone);
  assert.deepEqual(moves("waiting"), ["booth"]);
  assert.deepEqual(moves("booth"), ["upload", "waiting"], "red takes a person out of the booth to the upload station");
  assert.deepEqual(moves("upload"), ["done", "booth"]);
  assert.deepEqual(moves("done"), ["upload"], "a group marked done by mistake goes back to the upload station");
  const s = (id, status) => ({ id, status });
  const { next, after, inBooth } = nextTwo([s(1, "booth"), s(5, "upload"), s(2, "waiting"), s(3, "waiting"), s(4, "waiting")]);
  assert.deepEqual([next.id, after.id, inBooth.map((x) => x.id)], [2, 3, [1]], "a group at the upload station is not in the booth");
  assert.equal(groupLabel(["Jay", "Mo", "Kim"]), "Jay, Mo & Kim");
  assert.ok(LINE_POLL_MS <= 5000, "the line refreshes at least every 5 s");
  assert.equal(UNDO_MS, 10000, "Undo stays for 10 s");
  const team = read("public/js/team.js");
  assert.match(team, /els\.upload\.replaceChildren\(\s*\.\.\.station\.map\(\(x, i\) => takeCard\(x\.t, x\.people, \{ title: i === 0 \? COPY\.nextUpload : COPY\.laterUpload, contact: true, open: !x\.t\.closed \}\)\),/, "the upload station shows each recording whole, the engineer's next one first, with contacts to check");
  // The recordings (Scooter, 19 Nov 2026: one after another is still one song) and the green tap's question.
  const g = (first_name) => ({ first_name });
  const sess = (id, status, take_id, name) => ({ id, status, take_id, guests: [g(name)] });
  const takes = [{ id: 7, opened_at: "2026-12-14T02:00:00Z", closed: false, uploaded: false }, { id: 6, opened_at: "2026-12-14T01:00:00Z", closed: true, uploaded: false }, { id: 5, opened_at: "2026-12-14T00:00:00Z", closed: true, uploaded: true }];
  const line = [sess(1, "upload", 7, "Carlos"), sess(2, "booth", 7, "Scooter"), sess(3, "upload", 6, "Ana"), sess(4, "done", 5, "Old"), sess(9, "waiting", null, "Next")];
  assert.deepEqual(recordings(takes, line).map((r) => [r.t.id, r.people.map((x) => x.id), r.inBooth]), [[6, [3], false], [7, [1, 2], true]], "oldest first; one being recorded (someone in the booth), one at the station; uploaded ones are gone");
  assert.equal(songQuestion(takes, line), "", "someone of the open recording is in the booth: the next person joins it, no question");
  const allOut = line.map((x) => (x.id === 2 ? { ...x, status: "upload" } : x));
  assert.equal(songQuestion(takes, allOut), "Carlos & Scooter", "everyone of it out, not uploaded: same song or new?");
  assert.equal(songQuestion([{ ...takes[0], closed: true }, ...takes.slice(1)], allOut), "", "an ended recording takes nobody else: no question");
  assert.equal(songQuestion([], []), "");
  assert.match(read("public/team.html"), /<ol id="tbz-team-upload" class="line"><\/ol>/);
  assert.match(read("public/team.html"), /<ol id="tbz-team-booth" class="line"><\/ol>/, "the booth is its own lane");
  assert.equal(andList(["Jeff", "John", "Scooter"]), "Jeff, John and Scooter");
  assert.equal(flagWords(TEAM, ["test", "stale"]), `${TEAM.flagTest} · ${TEAM.flagStale}`);
  assert.equal(flagWords(TEAM, []), "");
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

test("the song on /track (Scooter, 18 and 19 Nov 2026): everyone with the code sees who has access; everyone on the song has the controls; the line says who last entered or withdrew it; no group confirmation; a song that cannot go in says so in neutral words", () => {
  const c = cleanContest({ on: true, rules_url: "https://evil.example", title: "Sleigh", entered: false, closed: false, ticked: false, ticked_by: null, step: "not_entered", manager: "Jeff", you: { performer: true, manager: false, can_manage: true, signed_up: true }, access: ["Jeff", "John", "Scooter"], people: [{ first_name: "Jeff", email: "x@y.co" }, { first_name: "John", you: true }], blocked: "nope", vote_url: "https://evil.example/" });
  assert.equal(c.rules_url, "/holiday-rules", "the rules link is always our own page");
  assert.equal(c.vote_url, "/", "View Contest only ever opens this site's voting page");
  assert.equal(cleanContest({ on: true, vote_url: "/#sleigh-bars" }).vote_url, "/#sleigh-bars", "at the song, when it is in");
  assert.equal(cleanContest({ on: true, vote_url: "//evil.example" }).vote_url, "/");
  assert.equal(c.blocked, null);
  assert.ok(!("manager" in c) && !("manager" in c.you), "no manager: the controls are everyone's on the song");
  assert.ok(!JSON.stringify(c).includes("@"), "no email gets through");
  assert.ok(!("confirmed" in c) && !("group" in c), "no group confirmation any more");
  assert.equal(accessLine(TRACK, c.access), "Jeff, John and Scooter have access to this song.");
  assert.equal(accessLine(TRACK, ["Jeff"]), "Jeff has access to this song.");
  assert.equal(accessLine(TRACK, []), TRACK.accessNobody);
  // Who last changed it, with the time in the phone's own clock.
  const clock = () => "9:42 PM";
  const at = "2026-12-14T02:42:00.000Z";
  assert.equal(contestLine(TRACK, cleanContest({ on: true, entered: true, ticked: true, ticked_by: "Carlos", changed: { action: "entered", by: "Carlos", at } }), clock), "Entered by Carlos at 9:42 PM: it's in the vote.");
  assert.equal(contestLine(TRACK, cleanContest({ on: true, changed: { action: "withdrawn", by: "Ken", at } }), clock), "Withdrawn by Ken at 9:42 PM. Anyone on the song can enter it again, and its votes are kept.");
  assert.equal(contestLine(TRACK, cleanContest({ on: true, changed: { action: "sideways", by: "Ken", at } }), clock), TRACK.contestNotYet, "an unknown change is not shown");
  assert.equal(contestLine(TRACK, c), TRACK.contestNotYet);
  assert.equal(contestLine(TRACK, { ...c, entered: true, ticked: true, ticked_by: "Jeff" }), "Entered by Jeff: it's in the vote.");
  // Neutral words, never policy framing (Scooter, 18 Nov 2026).
  assert.equal(contestLine(TRACK, cleanContest({ on: true, blocked: "scooter_taylor" })), "This song was recorded as a test entry for this preview, so it is not eligible for the vote.");
  assert.equal(contestLine(TRACK, cleanContest({ on: true, blocked: "test_file_in_production", production: true })), TRACK.notEligible);
  assert.equal(contestLine(TRACK, { ...c, blocked: "pulled_by_team" }), TRACK.contestPulled);
  for (const v of Object.values(TRACK)) assert.ok(!/standing|rule says|policy|Scooter Taylor/i.test(String(v)), `no policy framing: ${v}`);
  assert.equal(cleanContest({ on: false }), null, "no contest, no box");
  assert.equal(cleanContest(undefined), null);
  const html = read("public/track.html");
  assert.match(html, /<input type="checkbox" id="tbz-contest-box">/);
  assert.ok(!/id="tbz-contest-box"[^>]*checked/.test(html), "unticked by default");
  assert.ok(!/tbz-confirm-(row|box)/.test(html), "the confirmed-with-your-group box is gone");
  assert.match(html, /id="tbz-access"/);
  assert.match(html, /id="tbz-on-song"/);
  assert.match(html, /<a id="tbz-view-contest" class="btn" href="\/" hidden><\/a>/, "View Contest, hidden until the party is on");
  const js = read("public/js/track.js");
  assert.match(js, /h\("a", \{ href: "\/holiday-rules", target: "_blank", rel: "noopener", text: COPY\.contestRules \}\)/);
  assert.match(js, /els\.access\.textContent = c \? accessLine\(COPY, c\.access\) : "";/, "the access list is shown to everyone with the code");
  assert.match(js, /els\.contestBox\.closest\("\.contest-check"\)\.hidden = !manages;/, "everyone on the song gets the box (a listener does not)");
  // The three buttons (Scooter, 19 Nov 2026): small and square while the party is on; off, the page as before.
  assert.match(js, /els\.actions\.classList\.toggle\("is-square", Boolean\(c\)\);/);
  assert.match(js, /els\.download\.textContent = c \? COPY\.downloadSong : COPY\.download;/);
  assert.match(js, /els\.share\.textContent = c \? COPY\.shareSong : COPY\.share;/);
  assert.match(js, /els\.viewContest\.hidden = !c;\s*if \(c\) els\.viewContest\.href = c\.vote_url;/);
  assert.deepEqual([TRACK.downloadSong, TRACK.shareSong, TRACK.viewContest], ["Download Song", "Share Song", "View Contest"], "his labels");
  assert.match(read("public/css/site.css"), /\.found-actions\.is-square \.btn \{[^}]*border-radius: 0;/, "square, not ovals");
  assert.match(js, /els\.artRow\.hidden = Boolean\(c\) && !manages;/, "and the artwork");
  assert.match(js, /els\.titleForm\.hidden = !\(manages && c\.ticked\);/, "the title comes up once Enter is ticked");
  assert.match(js, /const flipContest = \(\) => sendContest\(els\.contestBox\.checked \? \{ enter: true, agree: true \} : \{ enter: false \}, els\.contestBox\);/, "a tick sends the rules agreement");
  assert.ok(!/group_confirmed|confirmBox/.test(js));
  assert.match(js, /for \(const el of \[els\.publicRow, els\.publicNote, els\.publicGroup, els\.voteRow, els\.voteNote\]\) el\.hidden = Boolean\(c\);/, "while the party is on, no Make public switch and no vote switch");
  assert.match(js, /els\.listenOnly\.hidden = !c \|\| performer;/, "a listener is told they can hear and download");
  assert.ok(!/guest_key|GUEST_KEY|ownKey/.test(js), "the entry does not need the sign-up phone's key");
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

test("the team's page: every change asks first and can be undone; no swipe can change anything; the upload goes to the recording the ambassador's taps made", () => {
  const team = read("public/js/team.js");
  assert.ok(!/touchstart|touchend|touchmove|pointerdown|swipe/i.test(team), "no gestures on the team's page");
  assert.match(team, /onclick: \(\) => ask\(s, to\)/, "a status button only asks");
  assert.match(team, /els\.confirmYes\.addEventListener\("click", \(\) => \{\s*const p = app\.pending;\s*closeModal\(els\.confirm\);\s*if \(p\?\.song\) pullSong\(p\.song, p\.pulled, \{ undoable: true \}\);\s*else if \(p\) change\(p\.s, p\.s\.status, p\.to, \{ undoable: true, song: p\.asked \? "same" : null \}\);\s*\}\);/, "Yes makes the change (a person's status, on the same song when that was the question, or a song in or out of the vote with Undo)");
  assert.match(team, /els\.confirmAlt\.addEventListener\("click", \(\) => \{\s*const p = app\.pending;\s*closeModal\(els\.confirm\);\s*if \(p\?\.s\) change\(p\.s, p\.s\.status, p\.to, \{ undoable: true, song: "new" \}\);\s*\}\);/, "New song starts the next recording");
  assert.match(team, /if \(err\?\.code === "which_song" && typeof err\.extra\?\.names === "string"\) \{ app\.pending = null; ask\(s, to, err\.extra\.names\); return; \}/, "a phone that had not seen the booth empty is asked by the server, never guessed for");
  assert.match(read("public/team.html"), /id="tbz-team-confirm-alt" class="btn btn-status btn-wait" hidden/);
  assert.match(team, /const flagText = flagged\.map\(\(g\) => COPY\.confirmFlagged/, "a flagged sign-up is named with its email and phone before it moves");
  assert.match(team, /onclick: \(\) => openRepoint\(s\)/, "Change who's on it opens the re-point, which asks for a note");
  assert.ok(!/askAssign|askRemove|assignGroup|removePerson/.test(team), "no picking a group at upload and no per-person remove: the re-point replaces them");
  // The booth sends the recording it showed; a page that went stale is refused, never mis-attached.
  const boothJs = read("public/js/booth.js");
  // The engineer confirms the names first (Scooter, 19 Nov 2026), and the upload carries what was confirmed.
  assert.match(boothJs, /if \(party\) xhr\.setRequestHeader\("x-party-take", confirmed\);/);
  assert.match(boothJs, /if \(party && !confirmed\) \{ askFirst\(file\); return; \}/, "nothing goes up before the engineer answers on the page");
  assert.match(boothJs, /app\.asking = next \? \{ key: next\.key, sig: stationSig\(next\) \} : \{ key: "none", sig: "" \};/, "the key as it was when asked");
  // A stale page is refused by the server and the file is HELD, never sent again by itself.
  assert.match(boothJs, /else if \(body\.error === "take_changed"\) \{ app\.busy = false; hold\(file, null, COPY\.sessionGone\); loadGroups\(\); \}/);
  // "Wait for the names" / "Not them" hold the file (Scooter, 20 Nov 2026), and a held file is only ever ASKED about again.
  assert.match(boothJs, /if \(file\) hold\(file, refused, notThem \? COPY\.confirmGroupHeld : COPY\.walkUpHeld\);/);
  assert.match(boothJs, /if \(askAboutHeld\(app\.held, next, \{ busy: app\.busy, asking: app\.state === "walkup" \}\)\) askFirst\(app\.held\.file, \{ again: true \}\);/);
  assert.equal((boothJs.match(/upload\(file, \{ confirmed: key \}\)/g) ?? []).length, 1, "one place sends a confirmed upload: the Yes button");
  assert.ok(!/upload\(app\.held/.test(boothJs), "a held file is never uploaded without the engineer's Yes");
  assert.match(boothJs, /els\.walkupText\.textContent = next \? `\$\{lead\}\$\{COPY\.confirmGroup\.replace\("\{file\}", file\.name\)\.replace\("\{names\}", next\.names\)\} \$\{COPY\.confirmGroupNote\}` : COPY\.walkUpConfirm;/, "the names to confirm, or with nobody at the station the walk-up question, on the page");
  assert.match(boothJs, /els\.walkupGo\.addEventListener\("click", \(\) => \{ const file = app\.lastFile; const key = app\.asking\?\.key \?\? "none"; app\.asking = null; app\.lastFile = null; upload\(file, \{ confirmed: key \}\); \}\);/);
  assert.match(read("public/booth.html"), /<div id="tbz-walkup" class="walkup" role="alert" hidden>[\s\S]*id="tbz-walkup-pick"[\s\S]*id="tbz-walkup-go"/);
  for (const f of ["booth.js", "track.js", "team.js", "join.js", "app.js"]) assert.ok(!/window\.(confirm|alert|prompt)\(/.test(read(`public/js/${f}`)), `${f}: no browser pop-up`);
  assert.match(team, /els\.undo\.addEventListener\("click", \(\) => \{\s*const u = app\.undo;\s*if \(u\?\.song\) pullSong\(u\.song, u\.pulled, \{ undoable: false \}\);\s*else if \(u\) change\(u\.s, u\.from, u\.to, \{ undoable: false \}\);\s*\}\);/);
  assert.match(team, /onclick: \(\) => askSong\(s, true\)/, "Take out of the vote only asks");
  assert.match(team, /onclick: \(\) => askSong\(s, false\)/, "Put back only asks");
  assert.match(team, /els\.confirmNo\.focus\(\);/, "the keyboard lands on Cancel, so Enter never changes a status by mistake");
  for (const k of ["empty", "unreachable", "loading", "intro", "headline"]) assert.ok(TEAM[k], k);
  assert.equal(TEAM.empty, "Nobody in line yet. Put the QR sign up and the first sign-up shows here.");
  assert.match(read("public/team.html"), /<meta name="robots" content="noindex">/);
});

test("the partners: white marks made from the files Scooter sent, named with \"&\", one row under the Top Barz logo, each sized by weight within 20 to 46 px; the prize reads \"Prize details TBD\"; the rules page is a DRAFT, 21 and over, preview only", async () => {
  assert.deepEqual(HOLIDAY.partners.map((p) => p.name), ["Flow Music", "Dick & Jane's", "Blitz & Bubbles"]);
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
  assert.equal(HOLIDAY.prize, "Prize details TBD", "Scooter's words until he confirms the terms (19 Nov 2026)");
  assert.ok(!/bar tab/i.test(JSON.stringify(HOLIDAY)), "no promised prize anywhere");
  assert.match(festive, /prize\.textContent = HOLIDAY\.prize;/, "the page writes it in place of CultureCon's prize");
  assert.match(read("functions/index.js"), /\.on\('section\[aria-labelledby="tbz-prize-title"\] p', text\(HOLIDAY\.prize\)\)/, "and so does the server, before any script runs");
  assert.ok(!/Dick and Jane|Blitz and Bubbles/.test(JSON.stringify(HOLIDAY) + read("public/holiday-rules.html") + read("functions/_lib/party-privacy.js")), "the names are written with \"&\"");
  const rules = read("public/holiday-rules.html");
  assert.match(rules, /<meta name="robots" content="noindex">/);
  assert.match(rules, /<p class="draft-banner" role="note">DRAFT\./);
  assert.match(rules, /21 years of age or older/);
  assert.match(rules, /No purchase is necessary/);
  assert.match(rules, /\[Open: whether the participant who enters a song agrees for everyone on it/, "the waiver question is marked open in the draft");
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
  // Scooter, 18 Nov 2026: "The front-page GIFs scroll slowly and continuously". A seamless loop that
  // holds for a finger, the pointer or the keyboard, and never moves with motion turned off.
  assert.match(gallery, /const DRIFT_PX_PER_S = \d+;/);
  assert.match(gallery, /strip\.addEventListener\("pointerenter", hold\);/);
  assert.match(gallery, /strip\.addEventListener\("touchstart", hold, \{ passive: true \}\);/);
  assert.match(gallery, /strip\.addEventListener\("focusin", hold\);/);
  assert.match(gallery, /if \(!held && !document\.hidden\)/);
  assert.match(read("public/css/site.css"), /\.strip\.is-drifting/);
});

test("the party's dates: Sunday, December 13 (18 Nov 2026); voting closes Friday, November 27 at 11:59 PM Eastern, shown with the countdown (19 Nov 2026)", async () => {
  assert.deepEqual(HOLIDAY.dates, { party: "Sunday, December 13", zone: "America/New_York" });
  const all = JSON.stringify(HOLIDAY) + read("public/holiday-rules.html") + read("functions/index.js") + read("public/js/app.js") + read("public/js/festive.js");
  assert.ok(!/December 18|Dec(ember)?\.? 18|2026-12-1[89]/.test(all), "the December 18 placeholder is gone everywhere");
  assert.ok(HOLIDAY.home.lede.includes(HOLIDAY.dates.party), "the party's day is on the voting page");
  assert.ok(HOLIDAY.home.notOpenRefusal.includes(HOLIDAY.dates.party), "before voting opens, the page names the party night");
  const rules = read("public/holiday-rules.html");
  assert.ok(rules.includes("Sunday, December 13, 2026"), "the rules draft carries the party day");
  assert.ok(rules.includes("Voting closes Friday, November 27, 2026 at 11:59 PM Eastern Time."), "and the cutoff");
  assert.ok(!/\[Open: the date and exact time voting ends/.test(rules), "the end is no longer marked open");
  const { PARTY_VOTING_ENDS_AT } = await import("../functions/_lib/config.js");
  const { formatEndsLine } = await import("../public/js/logic.js");
  assert.equal(formatEndsLine(Date.parse(PARTY_VOTING_ENDS_AT), HOLIDAY.dates.zone), "Friday, November 27 at 11:59 PM EST", "the moment in code is 11:59 PM Eastern on the 27th");
  const app = read("public/js/app.js");
  assert.match(app, /const endsWords = \(\) => formatEndsLine\(app\.endMs, app\.holiday \? HOLIDAY\.dates\.zone : undefined\);/, "the page says it in Eastern time while the party is on");
  const index = read("functions/index.js");
  assert.match(index, /\.on\("#tbz-ends", text\(ends\)\)/, "the server writes the end line before any script runs");
  assert.match(index, /\.on\("#tbz-countdown-row", ends \? \{\} : hide\)/, "and keeps the countdown row");
});
