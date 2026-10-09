// The contest entry's rules with no request in them (functions/api/entries.js,
// functions/api/entries/upload.js and scripts/promote-entry.mjs): what a name, a city and a phone
// number are, what a group is, which file is accepted (the booth's rules, from booth.js), how an
// upload id is made, and the promotion's verdict. Entries are their own data (the `entries`,
// `entry_members` and `entry_uploads` tables, R2 keys under entries/): never tracks, never in the
// vote (tests/entry.test.mjs). Nothing here ever leaves the tables: no route answers a name, an
// email or a phone number.
import { cleanEmail } from "./booth.js";
import { isScooterTaylor, isTestName } from "./exclusions.js";

export { audioExtension, audioType, cleanFileName, uploadSize } from "./booth.js";
export const ENTRY_MAX_MEMBERS = 10;
export const ENTRY_NAME_MAX = 80;
export const ENTRY_CITY_MAX = 80;
export const ENTRY_UPLOAD_DAY_KEY = "entry-uploads-day"; // the one site-wide counter in rate_limits
export const isUploadId = (s) => typeof s === "string" && /^[0-9a-f]{24}$/.test(s);

// 24 random hex characters from the platform's random source: the upload id, and the R2 key's name.
export function uploadId(random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  return [...random(12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const entryKey = (id, ext) => `entries/${id}.${ext}`;

// A name or a city as it is kept: control characters out, runs of spaces made one, trimmed, at
// most `max` characters. Empty in → "" (the caller refuses).
export function cleanText(raw, max = ENTRY_NAME_MAX) {
  if (typeof raw !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

// A phone number as it is kept: digits, with a leading + if there was one. Spaces, dots, dashes
// and brackets as people type them are accepted and dropped; anything else, or fewer than 7 or
// more than 15 digits, → "" (the caller refuses).
export function cleanPhone(raw) {
  if (typeof raw !== "string") return "";
  const t = raw.trim();
  if (!t || t.length > 40 || /[^0-9+()\-.\s]/.test(t) || t.indexOf("+") > 0 || (t.match(/\+/g) ?? []).length > 1) return "";
  const digits = t.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return "";
  return (t.startsWith("+") ? "+" : "") + digits;
}

// The body of POST /api/entries → { ok: true, value } or { ok: false, field, error, message }.
// Every field is required. `in_group` must be a boolean. A group needs 1 to 10 members, each with
// a first name, a last name and an email; a non-group sends none. `agree` must be exactly true.
const refuse = (field, error, message) => ({ ok: false, field, error, message });
export function parseEntry(body) {
  const b = body && typeof body === "object" ? body : {};
  if (b.website !== undefined && b.website !== "") return refuse("website", "bad_request", "That did not go through.");
  const first = cleanText(b.first_name);
  if (!first) return refuse("first_name", "first_name_required", "Enter your first name.");
  const last = cleanText(b.last_name);
  if (!last) return refuse("last_name", "last_name_required", "Enter your last name.");
  const city = cleanText(b.city, ENTRY_CITY_MAX);
  if (!city) return refuse("city", "city_required", "Enter your city.");
  const email = cleanEmail(b.email);
  if (!email) return refuse("email", "bad_email", "Enter an email address that works.");
  const phone = cleanPhone(b.phone);
  if (!phone) return refuse("phone", "bad_phone", "Enter a phone number that works.");
  if (typeof b.in_group !== "boolean") return refuse("in_group", "group_required", "Say whether you recorded in a group.");
  const members = [];
  if (b.in_group) {
    const list = Array.isArray(b.members) ? b.members : [];
    if (list.length < 1) return refuse("members", "members_required", "Add the first name, last name and email of everyone in your group.");
    if (list.length > ENTRY_MAX_MEMBERS) return refuse("members", "too_many_members", `Add up to ${ENTRY_MAX_MEMBERS} people.`);
    for (const [i, m] of list.entries()) {
      const mf = cleanText(m?.first_name);
      const ml = cleanText(m?.last_name);
      const me = cleanEmail(m?.email);
      if (!mf || !ml || !me) return refuse(`members.${i}`, "bad_member", `Person ${i + 1} in your group needs a first name, a last name and an email address that works.`);
      members.push({ first_name: mf, last_name: ml, email: me });
    }
  } else if (Array.isArray(b.members) && b.members.length > 0) {
    return refuse("members", "members_without_group", "You said you did not record in a group.");
  }
  if (b.agree !== true) return refuse("agree", "agree_required", "Tick the box to agree to the official rules.");
  const id = typeof b.upload_id === "string" ? b.upload_id.trim() : "";
  if (!isUploadId(id)) return refuse("upload_id", "track_required", "Upload your track first.");
  return { ok: true, value: { first_name: first, last_name: last, city, email, phone, in_group: b.in_group, members, upload_id: id } };
}

// The label a promoted entry gets in the vote: the entrant's first name. A second "Jane" is
// handled by assignSlugs in scripts/lib/names.mjs, the way load-tracks does it.
export const entryLabel = (entry) => cleanText(entry?.first_name) || "Entry";

// The only door onto the vote (scripts/promote-entry.mjs): the verdict, pure. → { ok: true } or
// { ok: false, reason, message }, in this order: the entry exists; neither the entrant, the file
// nor any group member is Scooter Taylor (the loaders' rule); production takes no "Test …" file
// or entrant; the rules were agreed to.
export function promoteVerdict({ entry, members, env } = {}) {
  if (!entry || typeof entry !== "object" || !Number.isInteger(Number(entry.id))) return { ok: false, reason: "no_such_entry", message: "no entry has that number" };
  const file = String(entry.file_name ?? "");
  const full = `${entry.first_name ?? ""} ${entry.last_name ?? ""}`;
  const names = [full, file.replace(/\.[^.]+$/, ""), ...(Array.isArray(members) ? members : []).map((m) => `${m.first_name ?? ""} ${m.last_name ?? ""}`)];
  if (names.some((n) => isScooterTaylor(n))) return { ok: false, reason: "scooter_taylor", message: `entry ${entry.id} is Scooter Taylor's, which is never in the vote` };
  if (env === "production" && (isTestName(file) || isTestName(entry.first_name))) return { ok: false, reason: "test_file_in_production", message: `entry ${entry.id} is a test entry: test files go to preview only, never production` };
  if (!entry.rules_agreed_at) return { ok: false, reason: "rules_not_agreed", message: `entry ${entry.id} did not agree to the official rules` };
  return { ok: true, reason: "agreed", message: `entry ${entry.id} agreed to the official rules` };
}

export const INSERT_UPLOAD_SQL = "INSERT INTO entry_uploads (id, file_name, content_type, size, media_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)";
// The entry takes the file from the upload row itself, never from the request, and only while no
// entry has used that upload (UNIQUE (upload_id) settles two submissions racing).
export const INSERT_ENTRY_SQL = `INSERT INTO entries (first_name, last_name, city, email, phone, in_group, rules_agreed_at, upload_id, created_at)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, u.id, ?7 FROM entry_uploads u WHERE u.id = ?8 AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.upload_id = u.id) RETURNING id`;
export const INSERT_MEMBER_SQL = "INSERT INTO entry_members (entry_id, first_name, last_name, email) VALUES (?1, ?2, ?3, ?4)";
export const DROP_ENTRY_SQL = "DELETE FROM entries WHERE id = ?1";
