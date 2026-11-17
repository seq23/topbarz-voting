// The holiday party's rules with no screen in them (Scooter, 17 Nov 2026), shared by /join, /team
// and the festive look, unit-tested in tests/party-pages.test.mjs: what a group code is, where a
// guest is in line, the words for the team's statuses, and the "Text them" link.
export const SESSION_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // the server's own (functions/_lib/party.js)
export const GUEST_KEY = "tbz.party.guest"; // the guest's own key, on their own phone: nothing else is kept
export const TEAM_KEY = "tbz.team"; // the team token, on that team member's phone
export const LINE_POLL_MS = 5000;
export const GUEST_POLL_MS = 15000;
export const UNDO_MS = 10000;

export const sessionCodeFrom = (raw) => String(raw ?? "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
export const isSessionCode = (s) => typeof s === "string" && new RegExp(`^[${SESSION_LETTERS}]{4}$`).test(s);
export const isGuestKey = (s) => typeof s === "string" && /^[0-9a-f]{24}$/.test(s);
export const isTeamToken = (s) => typeof s === "string" && /^t1\.[1-9][0-9]{0,9}\.[0-9]{10}\.[0-9a-f]{64}$/.test(s);

// ?group=JXQP → "JXQP" (the link a guest shares with their friends), else "".
export function groupFromSearch(search) {
  try { const c = sessionCodeFrom(new URLSearchParams(search).get("group")); return isSessionCode(c) ? c : ""; } catch { return ""; }
}
export const joinLink = (origin, code) => `${origin}/join?group=${encodeURIComponent(code)}`;

// "Jay" · "Jay & Mo" · "Jay, Mo & Kim"
export function groupLabel(names) {
  const n = (names ?? []).filter(Boolean);
  if (n.length <= 1) return n[0] ?? "";
  return `${n.slice(0, -1).join(", ")} & ${n[n.length - 1]}`;
}

// Where a guest is, in words: up now, next, number N, been in, or not known yet.
export function placeWords(COPY, session) {
  if (!session) return "";
  if (session.status === "booth") return COPY.placeNow;
  if (session.status === "out") return COPY.placeDone;
  if (session.place === 1) return COPY.placeNext;
  if (Number.isInteger(session.place) && session.place > 1) return COPY.placeN.replace("{n}", String(session.place));
  return COPY.placeUnknown;
}

// The team's three statuses: what each is called, its colour, and the buttons it offers.
export const STATUS = {
  waiting: { word: "Waiting", tone: "wait" },
  booth: { word: "In the booth", tone: "go" },
  out: { word: "Out", tone: "stop" },
};
export function moves(status) {
  if (status === "waiting") return ["booth", "out"];
  if (status === "booth") return ["out", "waiting"];
  return ["waiting"];
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

// The sign-up form as it is sent, with the first problem found (or null). The server checks it all again.
export function joinPayload(f) {
  const t = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
  const body = { name: t(f.name), phone: t(f.phone), email: t(f.email).toLowerCase(), city: t(f.city), instagram: t(f.instagram), session_code: f.withGroup ? sessionCodeFrom(f.code) : null, website: f.website ?? "" };
  let problem = null;
  if (!body.name) problem = { field: "name", key: "needName" };
  else if (body.phone.replace(/\D/g, "").length < 7) problem = { field: "phone", key: "needPhone" };
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) problem = { field: "email", key: "needEmail" };
  else if (!body.city) problem = { field: "city", key: "needCity" };
  else if (f.withGroup && !isSessionCode(body.session_code)) problem = { field: "code", key: "needCode" };
  return { body, problem };
}

// ── The contest box on /track ────────────────────────────────────────────────────────────────
// The server's contest view → what the page draws, or null (no contest here). First names only;
// a person who has not signed up yet has none.
const BLOCKS = ["scooter_taylor", "test_file_in_production", "pulled_by_team"];
export function cleanContest(c) {
  if (!c || typeof c !== "object" || c.on !== true) return null;
  const name = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 30) : null);
  return {
    rules_url: "/holiday-rules",
    title: typeof c.title === "string" ? c.title.slice(0, 60) : "",
    entered: c.entered === true,
    closed: c.closed === true,
    you: { in: c.you?.in === true, signed_up: c.you?.signed_up === true },
    people: (Array.isArray(c.people) ? c.people : []).slice(0, 50).map((p) => ({ first_name: name(p?.first_name), in: p?.in === true, you: p?.you === true })),
    waiting_on: (Array.isArray(c.waiting_on) ? c.waiting_on : []).map(name).filter(Boolean).slice(0, 50),
    blocked: BLOCKS.includes(c.blocked) ? c.blocked : null,
  };
}
// The one line under the box that everyone on the song sees the same way.
export function contestLine(COPY, c) {
  if (!c) return "";
  if (c.blocked === "pulled_by_team") return COPY.contestPulled;
  if (c.blocked) return COPY.contestBlocked;
  if (c.entered) return COPY.contestEntered;
  if (c.closed) return COPY.contestClosed;
  if (c.waiting_on.length) return COPY.contestWaiting.replace("{names}", groupLabel(c.waiting_on));
  return COPY.contestNotYet;
}
// "Jay: in ✓" · "Kim: waiting" · "Someone (not signed up): waiting"
export const contestPerson = (COPY, p) => `${p.first_name ?? COPY.contestUnknown}${p.you ? ` (${COPY.contestYou})` : ""}: ${p.in ? COPY.contestIn : COPY.contestOut}`;
