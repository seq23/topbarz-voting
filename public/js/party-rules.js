// The holiday party's rules with no screen in them (Scooter, 17 Nov 2026, and his consolidated
// revision list of 18 Nov 2026), shared by /join, /team, /track, /booth and the festive look,
// unit-tested in tests/party-pages.test.mjs: one person's sign-up, where they are in line, the
// team's four lanes and the takes they make, the "Text them" link, and the song on /track.
export const SESSION_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // the server's own (functions/_lib/party.js)
export const GUEST_KEY = "tbz.party.guest"; // the guest's own key, on their own phone: nothing else is kept
export const TEAM_KEY = "tbz.team"; // the team token, on that team member's phone
export const LINE_POLL_MS = 5000;
export const GUEST_POLL_MS = 15000;
export const UNDO_MS = 10000;

export const isGuestKey = (s) => typeof s === "string" && /^[0-9a-f]{24}$/.test(s);
export const isTeamToken = (s) => typeof s === "string" && /^t1\.[1-9][0-9]{0,9}\.[0-9]{10}\.[0-9a-f]{64}$/.test(s);

// "Jay" · "Jay & Mo" · "Jay, Mo & Kim"
export function groupLabel(names) {
  const n = (names ?? []).filter(Boolean);
  if (n.length <= 1) return n[0] ?? "";
  return `${n.slice(0, -1).join(", ")} & ${n[n.length - 1]}`;
}
// "Jeff" · "Jeff and John" · "Jeff, John and Scooter": a sentence's list (Scooter's own wording).
export function andList(names) {
  const n = (names ?? []).filter(Boolean);
  if (n.length <= 1) return n[0] ?? "";
  return `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}
// Who has access to a song, in one line everyone with the code sees: "Jeff, John and Scooter have
// access to this song" (Scooter, 18 Nov 2026).
export function accessLine(COPY, names) {
  const n = (names ?? []).filter(Boolean);
  if (!n.length) return COPY.accessNobody;
  return (n.length === 1 ? COPY.accessOne : COPY.accessMany).replace("{names}", andList(n));
}
// A sign-up the team should look at twice (the server's guestFlags): its words, or "".
export function flagWords(COPY, flags) {
  const f = Array.isArray(flags) ? flags : [];
  return [f.includes("test") ? COPY.flagTest : null, f.includes("stale") ? COPY.flagStale : null].filter(Boolean).join(" · ");
}

// Where a group is, in words: up now, next, number N, just out (song being saved), done.
export function placeWords(COPY, session) {
  if (!session) return "";
  if (session.status === "booth") return COPY.placeNow;
  if (session.status === "upload") return COPY.placeUpload;
  if (session.status === "done") return COPY.placeDone;
  if (session.place === 1) return COPY.placeNext;
  if (Number.isInteger(session.place) && session.place > 1) return COPY.placeN.replace("{n}", String(session.place));
  return COPY.placeUnknown;
}

// The team's four lanes (Scooter, 17 Nov 2026): what each is called, its colour, and the buttons it
// offers. Green puts a group in the booth; red takes it out to the upload station, where it waits
// apart from whoever is in the booth now until the engineer uploads its song (or the team marks it
// done).
export const STATUS = {
  waiting: { word: "Waiting", tone: "wait" },
  booth: { word: "In the booth", tone: "go" },
  upload: { word: "At the upload station", tone: "stop" },
  done: { word: "Done", tone: "done" },
};
export function moves(status) {
  if (status === "waiting") return ["booth"];
  if (status === "booth") return ["upload", "waiting"];
  if (status === "upload") return ["done", "booth"];
  return ["upload"];
}

// The recordings not uploaded yet, each with its people still on it (in the booth or out, waiting
// on the upload) and whether any of them is in the booth: one being recorded, or at the upload
// station once everyone of it is out (the oldest first). A group often records one verse at a time,
// so a recording stays open after the booth empties (Scooter, 19 Nov 2026).
export function recordings(takes, sessions) {
  return (takes ?? []).filter((t) => !t.uploaded)
    .map((t) => {
      const people = (sessions ?? []).filter((s) => s.take_id === t.id && (s.status === "booth" || s.status === "upload"));
      return { t, people, inBooth: people.some((s) => s.status === "booth") };
    })
    .filter((r) => r.people.length)
    .sort((a, b) => Date.parse(a.t.opened_at) - Date.parse(b.t.opened_at) || a.t.id - b.t.id);
}
// Before a green tap: the first names of the open recording when it must be asked "same song or new?"
// (it is not ended, nobody of it is in the booth, its song is not uploaded), else "" (no question:
// someone of it is in the booth, so the person joins it; or none is open, so it is a new one).
export function songQuestion(takes, sessions) {
  const open = recordings(takes, sessions).filter((r) => !r.t.closed);
  const last = open[open.length - 1];
  if (!last || last.inBooth) return "";
  return groupLabel(last.people.flatMap((s) => (s.guests ?? []).map((g) => g.first_name)));
}

// The two at the top of the team's line: "Next up" and "After that" (after any group in the booth).
export function nextTwo(sessions) {
  const waiting = (sessions ?? []).filter((s) => s.status === "waiting");
  return { next: waiting[0] ?? null, after: waiting[1] ?? null, inBooth: (sessions ?? []).filter((s) => s.status === "booth") };
}

// The "Text them" link: Messages on the team member's own phone, every number in the group, the
// words already in. The person taps send (texts are sent by a person, from their own phone).
// iPhone takes several numbers as sms:/open?addresses=a,b&body=…; Android as sms:a,b?body=…;
// a computer has no Messages to open (null: the page shows the numbers to copy instead).
export function groupSmsHref(platform, phones, message) {
  const nums = (phones ?? []).map((p) => String(p).replace(/[^0-9+]/g, "")).filter((p) => /^\+?[0-9]{7,15}$/.test(p));
  if (!nums.length) return null;
  const body = encodeURIComponent(message);
  if (platform === "ios") return nums.length === 1 ? `sms:${nums[0]}&body=${body}` : `sms:/open?addresses=${nums.join(",")}&body=${body}`;
  if (platform === "android") return `sms:${nums.join(",")}?body=${body}`;
  return null;
}

// "9:42 PM" in the phone's own time zone, from an ISO time the server gave.
export function clockWords(iso, locale) {
  const ms = Date.parse(iso ?? "");
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

// The sign-up as it is sent: ONE person, on their own phone (Scooter, 18 Nov 2026), with the first
// problem found ({ field, key }) or null. The server checks it all again.
export function joinPayload(fields, website = "") {
  const t = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
  const f = fields ?? {};
  const body = { name: t(f.name), phone: t(f.phone), email: t(f.email).toLowerCase(), city: t(f.city), instagram: t(f.instagram), website };
  return { body, problem: slotProblem(body) };
}
// One slot's first problem, or null.
export function slotProblem(g) {
  if (!g.name) return { field: "name", key: "needName" };
  if (String(g.phone).replace(/\D/g, "").length < 7) return { field: "phone", key: "needPhone" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(g.email)) return { field: "email", key: "needEmail" };
  if (!g.city) return { field: "city", key: "needCity" };
  return null;
}

// ── The song on /track ───────────────────────────────────────────────────────────────────────
// The server's contest view → what the page draws, or null (no contest here). First names only.
const BLOCKS = ["scooter_taylor", "test_file_in_production", "pulled_by_team"];
const STEPS = ["not_entered", "in"];
// The voting page, or one song on it ("/#<slug>"): nothing else is followed from the server.
const voteUrl = (u) => (typeof u === "string" && /^\/(#[a-z0-9-]{1,60})?$/.test(u) ? u : "/");
export function cleanContest(c) {
  if (!c || typeof c !== "object" || c.on !== true) return null;
  const name = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 30) : null);
  const ch = c.changed && typeof c.changed === "object" && ["entered", "withdrawn"].includes(c.changed.action) && Number.isFinite(Date.parse(c.changed.at))
    ? { action: c.changed.action, by: name(c.changed.by), at: c.changed.at } : null;
  return {
    rules_url: "/holiday-rules",
    title: typeof c.title === "string" ? c.title.slice(0, 60) : "",
    entered: c.entered === true,
    closed: c.closed === true,
    ticked: c.ticked === true,
    ticked_by: name(c.ticked_by),
    changed: ch,
    step: STEPS.includes(c.step) ? c.step : null,
    you: { performer: c.you?.performer === true, can_manage: c.you?.can_manage === true, signed_up: c.you?.signed_up === true },
    nobody: c.nobody === true,
    access: (Array.isArray(c.access) ? c.access : []).slice(0, 50).map(name).filter(Boolean),
    people: (Array.isArray(c.people) ? c.people : []).slice(0, 50).map((p) => ({ first_name: name(p?.first_name), you: p?.you === true })),
    blocked: BLOCKS.includes(c.blocked) ? c.blocked : null,
    production: c.production === true,
    vote_url: voteUrl(c.vote_url),
  };
}
// The one line under the box that everyone with the code sees the same way: in or not, and who last
// entered or withdrew it, and when (Scooter, 19 Nov 2026: "Show who last changed it"). A song that
// cannot go in says why in neutral words (Scooter, 18 Nov 2026: "This song was recorded as a test
// entry for this preview, so it is not eligible for the vote." No policy framing, and nothing about
// who can or cannot enter). `clock` turns the server's time into the phone's "9:42 PM".
export function contestLine(COPY, c, clock = clockWords) {
  if (!c) return "";
  if (c.blocked === "pulled_by_team") return COPY.contestPulled;
  if (c.blocked === "scooter_taylor" || c.blocked === "test_file_in_production") return c.production ? COPY.notEligible : COPY.testEntry;
  if (c.blocked) return COPY.notEligible;
  const ch = c.changed;
  const time = ch ? clock(ch.at) : "";
  const fill = (line, who) => line.replace("{who}", who || COPY.contestSomeone).replace("{time}", time);
  if (c.entered) return ch?.action === "entered" && time ? fill(COPY.contestEnteredAt, ch.by) : fill(COPY.contestEntered, c.ticked_by);
  if (c.closed) return COPY.contestClosed;
  if (ch?.action === "withdrawn" && time) return fill(COPY.contestWithdrawn, ch.by);
  return COPY.contestNotYet;
}
