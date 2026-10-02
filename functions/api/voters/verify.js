// POST /api/voters/verify — body { email, code }. The second half of the gate when email
// verification is on: the 6-digit code that POST /api/voters emailed. A correct code marks the
// voter verified and returns what the gate used to: { token, voter: { first_name }, liked,
// returning, verification: "verified" }.
// Errors: 400 invalid_code (not 6 digits; no try used), 400 wrong_code (with tries_left),
// 410 code_exhausted (too many wrong tries: the code is dead), 410 code_expired (also: no code was
// ever sent to that email — the answer never says whether an email is known), 409
// verification_off, 429 rate_limited. Every try, right or wrong, is taken atomically, so racing
// requests cannot buy extra guesses.
import { LIMITS, VERIFICATION, verificationStatus } from "../../_lib/config.js";
import { HttpError, ipHash, json, readJson, route } from "../../_lib/http.js";
import { assertUnderLimit, limitStatement } from "../../_lib/ratelimit.js";
import { signVoterToken } from "../../_lib/token.js";
import { parseEmail } from "../../_lib/validate.js";
import { codeMatches } from "../../_lib/verify.js";
import { openSession } from "../voters.js";

const expired = () => new HttpError(410, "code_expired", "That code has expired. Ask for a new one.");
const exhausted = () => new HttpError(410, "code_exhausted", "Too many wrong tries. Ask for a new code.");

export const onRequest = route({
  async POST(context) {
    const { request, env } = context;
    const body = await readJson(request);
    if (!verificationStatus(env).available) {
      throw new HttpError(409, "verification_off", "Codes are not in use right now. Enter your details again to continue.");
    }
    const parsed = parseEmail(body.email);
    if (parsed.error) throw new HttpError(400, "invalid_fields", parsed.error, { fields: { email: parsed.error } });
    const code = typeof body.code === "string" ? body.code.replace(/[\s-]/g, "") : "";
    if (!/^[0-9]{6}$/.test(code)) throw new HttpError(400, "invalid_code", "Enter the 6-digit code from the email.");

    await signVoterToken(env, 1);
    const nowMs = Date.now();
    const nowS = Math.floor(nowMs / 1000);
    const db = env.DB;
    const [ipLimit, voterRes] = await db.batch([
      limitStatement(db, `verify:ip:${await ipHash(request, env)}`, LIMITS.verifyPerIp, nowMs),
      db.prepare("SELECT id, name, verified, unverified_reason FROM voters WHERE email_key = ?1").bind(parsed.emailKey),
    ]);
    assertUnderLimit(ipLimit, LIMITS.verifyPerIp, "tries");
    const voter = voterRes.results[0];
    if (!voter) throw expired();

    const tried = await db
      .prepare("UPDATE email_codes SET attempts = attempts + 1 WHERE voter_id = ?1 AND attempts < ?2 AND expires_at > ?3 RETURNING code_hmac, attempts")
      .bind(voter.id, VERIFICATION.maxTries, nowS)
      .first();
    if (!tried) {
      const dead = await db.prepare("SELECT attempts, expires_at FROM email_codes WHERE voter_id = ?1").bind(voter.id).first();
      throw dead && dead.expires_at > nowS ? exhausted() : expired();
    }
    if (!(await codeMatches(env, voter.id, code, tried.code_hmac))) {
      const left = VERIFICATION.maxTries - tried.attempts;
      if (left <= 0) throw exhausted();
      throw new HttpError(400, "wrong_code", `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.`, { tries_left: left });
    }

    await db.batch([
      db.prepare("UPDATE voters SET verified = 1, verified_at = COALESCE(verified_at, ?2), unverified_reason = NULL WHERE id = ?1").bind(voter.id, new Date(nowMs).toISOString()),
      db.prepare("DELETE FROM email_codes WHERE voter_id = ?1").bind(voter.id),
    ]);
    // "Returning" = this voter had been let in before (verified earlier, or let in without a code).
    const returning = voter.verified === 1 || voter.unverified_reason !== "pending";
    return json({ ...(await openSession(env, voter, returning)), verification: "verified" });
  },
});
