// The holiday party's rules with no screen in them (Scooter, 17 Nov 2026, and his preview notes the
// same day), shared by /join, /team, /track and the festive look, unit-tested in
// tests/party-pages.test.mjs: a group's sign-up on one phone, where a group is in line, the team's
// four lanes, the "Text them" link, and the contest box on /track.
export const SESSION_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // the server's own (functions/_lib/party.js)
export const GUEST_KEY = "tbz.party.guest"; // the guest's own key, on their own phone: nothing else is kept
export const TEAM_KEY = "tbz.team"; // the team token, on that team member's phone
export const LINE_POLL_MS = 5000;
export const GUEST_POLL_MS = 15000;
export const UNDO_MS = 10000;

export const isGuestKey = (s) => typeof s === "string" && /^[0-9a-f]{24}$/.test(s);
export const isTeamToken = (s) => typeof s === "string" && /^t1\.[1-9][0-9]{0,9}\.[0-9]{10}\.[0-9a-f]{64}$/.test(s);
export const GROUP_MAX = 10; // the server's own (functions/_lib/party.js)

// "Jay" · "Jay & Mo" · "Jay, Mo & Kim"
export function groupLabel(names) {
  const n = (names ?? []).filter(Boolean);
  if (n.length <= 1) return n[0] ?? "";
  return `${n.slice(0, -1).join(", ")} & ${n[n.length - 1]}`;
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

// The sign-up as it is sent: every slot of the group, each person's own (one phone, handed
// around), with the first problem found ({ slot, field, key }) or null. The server checks it all again.
export function joinPayload(slots, website = "") {
  const t = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
  const guests = (slots ?? []).map((f) => ({ name: t(f.name), phone: t(f.phone), email: t(f.email).toLowerCase(), city: t(f.city), instagram: t(f.instagram) }));
  const problem = guests.map(slotProblem).map((p, slot) => (p ? { slot, ...p } : null)).find(Boolean)
    ?? guests.map((g, i) => (guests.findIndex((o) => o.email === g.email) < i ? { slot: i, field: "email", key: "sameEmail" } : null)).find(Boolean)
    ?? null;
  return { body: { guests, website }, problem };
}
// One slot's first problem, or null.
export function slotProblem(g) {
  if (!g.name) return { field: "name", key: "needName" };
  if (String(g.phone).replace(/\D/g, "").length < 7) return { field: "phone", key: "needPhone" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(g.email)) return { field: "email", key: "needEmail" };
  if (!g.city) return { field: "city", key: "needCity" };
  return null;
}

// ── The contest box on /track ────────────────────────────────────────────────────────────────
// The server's contest view → what the page draws, or null (no contest here). First names only.
const BLOCKS = ["scooter_taylor", "test_file_in_production", "pulled_by_team"];
const STEPS = ["not_entered", "needs_group", "in"];
export function cleanContest(c) {
  if (!c || typeof c !== "object" || c.on !== true) return null;
  const name = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 30) : null);
  return {
    rules_url: "/holiday-rules",
    title: typeof c.title === "string" ? c.title.slice(0, 60) : "",
    entered: c.entered === true,
    closed: c.closed === true,
    group: c.group === true,
    ticked: c.ticked === true,
    confirmed: c.confirmed === true,
    ticked_by: name(c.ticked_by),
    confirmed_by: name(c.confirmed_by),
    step: STEPS.includes(c.step) ? c.step : null,
    you: { performer: c.you?.performer === true, signed_up: c.you?.signed_up === true },
    people: (Array.isArray(c.people) ? c.people : []).slice(0, 50).map((p) => ({ first_name: name(p?.first_name), you: p?.you === true })),
    blocked: BLOCKS.includes(c.blocked) ? c.blocked : null,
  };
}
// The one line under the box that everyone on the song sees the same way: in or not, and who did
// what, by first name, so nobody's tick speaks for the group in silence.
export function contestLine(COPY, c) {
  if (!c) return "";
  if (c.blocked === "pulled_by_team") return COPY.contestPulled;
  if (c.blocked) return COPY.contestBlocked;
  const who = (n) => n || COPY.contestSomeone;
  const group = groupLabel(c.people.map((p) => p.first_name).filter(Boolean));
  if (c.entered && c.group) return COPY.contestEnteredGroup.replace("{ticked}", who(c.ticked_by)).replace("{confirmed}", who(c.confirmed_by)).replace("{group}", group);
  if (c.entered) return COPY.contestEntered.replace("{ticked}", who(c.ticked_by));
  if (c.closed) return COPY.contestClosed;
  if (c.ticked && c.group) return COPY.contestNeedsGroup.replace("{ticked}", who(c.ticked_by));
  return COPY.contestNotYet;
}
