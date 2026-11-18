// The team's sign-in for /team (Scooter, 17 Nov 2026): an emailed 6-digit code, the vote's own
// mail and its own daily budget, for an email on the team list (team_members) only. Entering the
// code gives a team token, good for 30 days on that device:
//   "t1.<member id>.<expires, epoch seconds>.<HMAC-SHA256 of 't1|<id>|<expires>'>"
// signed with VOTER_TOKEN_SECRET under its own prefix, so a team token can never pass as a voter
// token, nor a voter token as a team one. No password, so there is nothing to forget: "Send me a
// new code" is the way back in. A member taken off the list is refused at once, token or not.
import { VERIFICATION, sendBudget } from "./config.js";
import { HttpError } from "./http.js";
import { bearer } from "./token.js";
import { newCode } from "./verify.js";

export const TEAM_TOKEN_DAYS = 30;
const enc = new TextEncoder();
const toHex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

async function key(env) {
  if (!env?.VOTER_TOKEN_SECRET) throw new HttpError(503, "token_secret_missing", "Sign-in is not switched on yet (the server has no signing secret).");
  return crypto.subtle.importKey("raw", enc.encode(env.VOTER_TOKEN_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
const tokenPayload = (id, exp) => enc.encode(`t1|${id}|${exp}`);
const codePayload = (id, code) => enc.encode(`team-code|${id}|${code}`);

export async function signTeamToken(env, memberId, nowS) {
  const exp = nowS + TEAM_TOKEN_DAYS * 86400;
  return `t1.${memberId}.${exp}.${toHex(await crypto.subtle.sign("HMAC", await key(env), tokenPayload(memberId, exp)))}`;
}
// → member id or null (bad shape, bad signature, or expired). Constant-time.
export async function verifyTeamToken(env, token, nowS) {
  const k = await key(env);
  const m = /^t1\.([1-9][0-9]{0,9})\.([0-9]{10})\.([0-9a-f]{64})$/.exec(typeof token === "string" ? token : "");
  if (!m || Number(m[2]) <= nowS) return null;
  return (await crypto.subtle.verify("HMAC", k, fromHex(m[3]), tokenPayload(m[1], m[2]))) ? Number(m[1]) : null;
}

export const MEMBER_SQL = "SELECT id, email FROM team_members WHERE id = ?1 AND removed_at IS NULL";
export const MEMBER_BY_EMAIL_SQL = "SELECT id, email FROM team_members WHERE email = ?1 AND removed_at IS NULL";
// The team member a request acts as: a valid team token AND a member still on the list.
export async function requireMember(request, env, nowS = Math.floor(Date.now() / 1000)) {
  const id = await verifyTeamToken(env, bearer(request), nowS);
  const member = id ? await env.DB.prepare(MEMBER_SQL).bind(id).first() : null;
  if (!member) throw new HttpError(401, "team_sign_in", "Sign in to the team page again.");
  return member;
}

export const teamCodeHmac = async (env, id, code) => toHex(await crypto.subtle.sign("HMAC", await key(env), codePayload(id, code)));
export async function teamCodeMatches(env, id, code, storedHex) {
  if (typeof storedHex !== "string" || !/^[0-9a-f]{64}$/.test(storedHex)) return false;
  return crypto.subtle.verify("HMAC", await key(env), fromHex(storedHex), codePayload(id, code));
}
export { newCode };

export function teamCodeEmail(code) {
  const minutes = Math.round(VERIFICATION.codeTtl / 60);
  const works = `It works for ${minutes} minutes. Enter it on the team page to see the line.`;
  const ignore = "If you did not ask for this code, ignore this email.";
  return {
    subject: `${code} is your Top Barz team code`,
    text: `Your Top Barz team code is ${code}\n\n${works}\n\n${ignore}\n`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#111111">
<p style="margin:0 0 8px">Your Top Barz team code is</p>
<p style="margin:0 0 16px;font-size:32px;font-weight:700;letter-spacing:6px">${code}</p>
<p style="margin:0 0 16px">${works}</p>
<p style="margin:0;font-size:14px;color:#555555">${ignore}</p>
</div>`,
  };
}

// One send from the SAME daily budget the voters' codes use (both tables counted), the same 3 an
// hour per email and the same 60 s between sends, in one statement so two taps cannot both send.
// → { slot } or { refused: "cooldown" | "hourly" | "budget", wait }.
export async function takeTeamSlot(env, memberId, nowS) {
  const V = VERIFICATION;
  const db = env.DB;
  const day = "(SELECT COUNT(*) FROM email_sends WHERE counted = 1 AND sent_at > ?3) + (SELECT COUNT(*) FROM team_code_sends WHERE counted = 1 AND sent_at > ?3)";
  const [slotRes, statsRes] = await db.batch([
    db.prepare(
      `INSERT INTO team_code_sends (member_id, sent_at) SELECT ?1, ?2 WHERE ${day} < ?4
        AND (SELECT COUNT(*) FROM team_code_sends WHERE counted = 1 AND member_id = ?1 AND sent_at > ?5) < ?6
        AND NOT EXISTS (SELECT 1 FROM team_code_sends WHERE counted = 1 AND member_id = ?1 AND sent_at > ?7)
       RETURNING id`,
    ).bind(memberId, nowS, nowS - 86400, sendBudget(env), nowS - 3600, V.sendsPerEmailPerHour, nowS - V.resendCooldown),
    db.prepare("SELECT MAX(sent_at) AS last, COUNT(*) AS hour FROM team_code_sends WHERE counted = 1 AND member_id = ?1 AND sent_at > ?2").bind(memberId, nowS - 3600),
  ]);
  const slot = slotRes.results?.[0];
  if (slot) return { slot: slot.id };
  const stats = statsRes.results?.[0] ?? {};
  // The stats row was read after the insert was refused, so it describes the refusal.
  if (stats.last && nowS - stats.last < V.resendCooldown) return { refused: "cooldown", wait: V.resendCooldown - (nowS - stats.last) };
  if ((stats.hour ?? 0) >= V.sendsPerEmailPerHour) return { refused: "hourly", wait: 3600 };
  // The day's budget: say when the oldest counted send in the window rolls off, so the screen can
  // name a real wait instead of "a little while".
  const oldest = await db.prepare(
    "SELECT MIN(sent_at) AS t FROM (SELECT sent_at FROM email_sends WHERE counted = 1 AND sent_at > ?1 UNION ALL SELECT sent_at FROM team_code_sends WHERE counted = 1 AND sent_at > ?1)",
  ).bind(nowS - 86400).first();
  return { refused: "budget", wait: oldest?.t ? Math.max(60, oldest.t + 86400 - nowS) : 3600 };
}
export const releaseTeamSlot = (db, id) => db.prepare("UPDATE team_code_sends SET counted = 0 WHERE id = ?1").bind(id).run();
export const STORE_TEAM_CODE_SQL = `INSERT INTO team_codes (member_id, code_hmac, expires_at, attempts) VALUES (?1, ?2, ?3, 0)
  ON CONFLICT (member_id) DO UPDATE SET code_hmac = excluded.code_hmac, expires_at = excluded.expires_at, attempts = 0`;
