// The rules of the contest entry page (/entry) with no screen in them: what each field has to be,
// the order the page checks them in, and the words for a refusal. The server checks every one of
// these again (functions/_lib/entries.js parseEntry; tests/entry.test.mjs pins that the two agree).
// Unit-tested; entry.js imports it as it is.
import { cleanEmail, refuseFile } from "./booth-rules.js";

export const MAX_MEMBERS = 10;
export const NAME_MAX = 80;
export const INSTAGRAM_MAX = 120;
export const TITLE_MAX = 120;

export function cleanText(raw, max = NAME_MAX) {
  if (typeof raw !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

// A phone number as the server keeps it: digits with a leading + if there was one; 7 to 15 digits;
// spaces, dots, dashes and brackets are accepted and dropped. Anything else → "".
export function cleanPhone(raw) {
  if (typeof raw !== "string") return "";
  const t = raw.trim();
  if (!t || t.length > 40 || /[^0-9+()\-.\s]/.test(t) || t.indexOf("+") > 0 || (t.match(/\+/g) ?? []).length > 1) return "";
  const digits = t.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return "";
  return (t.startsWith("+") ? "+" : "") + digits;
}

// values: { first_name, last_name, city, email, phone, in_group: true|false|null, members: [{ first_name,
// last_name, email }], agree, file } → null when it can be sent, else { field, message } for the
// first thing wrong (the page puts the keyboard there).
export function checkEntry(values, copy) {
  const v = values ?? {};
  const need = copy.need;
  if (!cleanText(v.first_name)) return { field: "first_name", message: need.first_name };
  if (!cleanText(v.last_name)) return { field: "last_name", message: need.last_name };
  if (!cleanText(v.city, 80)) return { field: "city", message: need.city };
  if (!cleanEmail(v.email)) return { field: "email", message: need.email };
  if (!cleanPhone(v.phone)) return { field: "phone", message: need.phone };
  if (typeof v.in_group !== "boolean") return { field: "in_group", message: need.in_group };
  if (v.in_group) {
    const members = Array.isArray(v.members) ? v.members : [];
    if (members.length < 1) return { field: "members", message: need.members };
    for (const [i, m] of members.entries()) {
      if (!cleanText(m?.first_name) || !cleanText(m?.last_name) || !cleanEmail(m?.email)) return { field: `members.${i}`, message: need.member.replace("{n}", String(i + 1)) };
    }
  }
  if (!v.file) return { field: "track", message: need.track };
  const why = refuseFile(v.file);
  if (why) return { field: "track", message: why === "not_audio" ? copy.notAudio : why === "too_big" ? copy.tooBig : copy.empty };
  if (v.agree !== true) return { field: "agree", message: need.agree };
  return null;
}

// The JSON body of POST /api/entries (the fields, the one-time upload id, the empty honeypot).
export function entryBody(values, uploadId, honeypot = "") {
  const inGroup = values.in_group === true;
  return {
    first_name: cleanText(values.first_name),
    last_name: cleanText(values.last_name),
    city: cleanText(values.city, 80),
    email: cleanEmail(values.email),
    phone: cleanPhone(values.phone),
    instagram: cleanText(values.instagram, INSTAGRAM_MAX),
    track_title: cleanText(values.track_title, TITLE_MAX),
    in_group: inGroup,
    members: inGroup ? values.members.map((m) => ({ first_name: cleanText(m.first_name), last_name: cleanText(m.last_name), email: cleanEmail(m.email) })) : [],
    agree: values.agree === true,
    upload_id: uploadId,
    website: honeypot,
  };
}

// The line shown for a refusal: the page's own words for the cases it knows, else the server's
// message, else a plain line.
export function failureWords(copy, { code, status, message } = {}) {
  if (code === "entries_closed") return copy.closed;
  if (code === "daily_limit") return copy.dailyLimit;
  if (code === "rate_limited" || status === 429) return copy.rateLimited;
  if (code === "not_audio") return copy.notAudio;
  if (code === "bad_size" || status === 413) return copy.tooBig;
  if (typeof message === "string" && message.trim()) return message.trim();
  return copy.failed;
}
