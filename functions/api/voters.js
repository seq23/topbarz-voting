// POST /api/voters — the gate. Body: { name, email, city, marketing_opt_in?, website? }.
// `website` is the honeypot: a person never sees it, so anything in it is a bot.
// The same email again is the same voter (and gets their likes back).
//
// With email verification OFF (config.js, verificationStatus) it returns
// { token, voter: { first_name }, liked: [slug…], returning } at once, as it always has.
//
// With it ON the voter is saved unverified, a 6-digit code is emailed, and the answer carries
// NO token: { verification: "code_sent", sent, email, resend_in_seconds, expires_in_seconds }.
// The token comes from POST /api/voters/verify. Asking again is this same call (a resend).
// A vote is never lost because of mail: when no code can be sent (the daily budget is spent, or
// the mail service fails) an email that has never been verified is let in at once
// ({ …token…, verification: "skipped", reason }). An email that IS verified never gets a token
// without a correct code: that answers 503 code_unavailable, so typing someone else's email can
// never act as them.
import { LIMITS, NAME_MAX_CHARS, VERIFICATION, verificationStatus } from "../_lib/config.js";
import { HttpError, ipHash, json, readJson, route } from "../_lib/http.js";
import { assertUnderLimit, limitStatement, maybePrune } from "../_lib/ratelimit.js";
import { signVoterToken } from "../_lib/token.js";
import { cleanText, firstName, parseEmail } from "../_lib/validate.js";
import { domainReceivesMail, maybePruneVerification, newCode, releaseSendSlot, sendCode, storeCode, takeSendSlot } from "../_lib/verify.js";

export const LIKED_SLUGS_SQL = `
SELECT t.slug FROM tracks t WHERE t.active = 1 AND
  (SELECT e.action FROM like_events e WHERE e.voter_id = ?1 AND e.track_id = t.id ORDER BY e.id DESC LIMIT 1) = 'like'
ORDER BY t.sort, t.label, t.id`;

// One row per mailbox. A second visit keeps the first name, email and city on file and can only
// ever turn the marketing opt-in ON — except for a row still `pending` (sent a code, never let in):
// nobody has proven that address, so the newest details replace it.
const PENDING = "voters.verified = 0 AND voters.unverified_reason = 'pending'";
const UPSERT_VOTER_SQL = `
INSERT INTO voters (name, email, email_key, city, marketing_opt_in, created_at, ip_hash, unverified_reason)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
ON CONFLICT (email_key) DO UPDATE SET
  name = CASE WHEN ${PENDING} THEN excluded.name ELSE voters.name END,
  email = CASE WHEN ${PENDING} THEN excluded.email ELSE voters.email END,
  city = CASE WHEN ${PENDING} THEN excluded.city ELSE voters.city END,
  ip_hash = CASE WHEN ${PENDING} THEN excluded.ip_hash ELSE voters.ip_hash END,
  marketing_opt_in = CASE WHEN ${PENDING} THEN excluded.marketing_opt_in ELSE MAX(voters.marketing_opt_in, excluded.marketing_opt_in) END,
  unverified_reason = CASE WHEN ${PENDING} THEN excluded.unverified_reason ELSE voters.unverified_reason END
RETURNING id, name, email, created_at, verified, unverified_reason`;

// THE place a gate answer gets its token (here and in voters/verify.js).
export async function openSession(env, voter, returning) {
  const liked = (await env.DB.prepare(LIKED_SLUGS_SQL).bind(voter.id).all()).results.map((r) => r.slug);
  return { token: await signVoterToken(env, voter.id), voter: { first_name: firstName(voter.name) }, liked, returning };
}

export const onRequest = route({
  async POST(context) {
    const { request, env } = context;
    const body = await readJson(request);

    if (typeof body.website === "string" && body.website.trim() !== "") throw new HttpError(400, "rejected", "That did not go through.");

    const fields = {};
    const name = cleanText(body.name, NAME_MAX_CHARS);
    const city = cleanText(body.city, NAME_MAX_CHARS);
    if (!name) fields.name = "Enter your name.";
    if (!city) fields.city = "Enter your city.";
    const parsed = parseEmail(body.email);
    if (parsed.error) fields.email = parsed.error;
    if (Object.keys(fields).length) {
      throw new HttpError(400, parsed.code ?? "invalid_fields", Object.values(fields)[0], { fields });
    }
    const optIn = body.marketing_opt_in === true ? 1 : 0;

    // Sign first: with no secret set this is a named 503, and nothing is written.
    await signVoterToken(env, 1);
    const verifying = verificationStatus(env).available;

    const ip = await ipHash(request, env);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const nowS = Math.floor(nowMs / 1000);
    const db = env.DB;
    const [ipLimit, emailLimit] = await db.batch([
      limitStatement(db, `gate:ip:${ip}`, LIMITS.gatePerIp),
      limitStatement(db, `gate:email:${parsed.emailKey}`, LIMITS.gatePerEmail),
    ]);
    assertUnderLimit(ipLimit, LIMITS.gatePerIp, "sign-ups");
    assertUnderLimit(emailLimit, LIMITS.gatePerEmail, "sign-ups");

    // A domain that cannot receive mail is refused before anything is saved or sent.
    if (verifying && (await domainReceivesMail(env, parsed.email.split("@")[1], nowS)) === false) {
      const message = "That email address cannot receive mail. Check the spelling and try again.";
      throw new HttpError(400, "undeliverable_email", message, { fields: { email: message } });
    }

    const voter = await db
      .prepare(UPSERT_VOTER_SQL)
      .bind(name, parsed.email, parsed.emailKey, city, optIn, now, ip, verifying ? "pending" : "verification_off")
      .first();
    // A row still `pending` has never been let in, however long ago its first code was asked for.
    const neverLetIn = verifying && voter.verified === 0 && voter.unverified_reason === "pending";
    const returning = voter.created_at !== now && !neverLetIn;
    maybePrune(context);

    if (!verifying) return json(await openSession(env, voter, returning));

    maybePruneVerification(context, nowS);
    // No code can be sent. Never-verified: let in at once, marked with why. Verified: refused.
    const withoutCode = async (reason) => {
      if (voter.verified) {
        throw new HttpError(503, "code_unavailable", "We could not send your code right now. Try again in a little while.");
      }
      await db.prepare("UPDATE voters SET unverified_reason = ?2 WHERE id = ?1 AND verified = 0").bind(voter.id, reason).run();
      return json({ ...(await openSession(env, voter, returning)), verification: "skipped", reason });
    };
    const codeSent = (sent, resendIn, expiresIn) =>
      json({ verification: "code_sent", sent, email: parsed.email, resend_in_seconds: resendIn, expires_in_seconds: expiresIn });

    const take = await takeSendSlot(env, voter.id, nowS);
    if (take.refused === "cooldown") {
      // The code already sent is still good: show the code step again, send nothing.
      if (take.liveFor > 0) return codeSent(false, take.wait, take.liveFor);
      throw new HttpError(429, "resend_cooldown", `You can ask for a new code in ${take.wait} seconds.`, { retry_after_seconds: take.wait });
    }
    if (take.refused === "hourly") {
      const minutes = Math.ceil(take.wait / 60);
      throw new HttpError(429, "code_limit", `We have sent ${VERIFICATION.sendsPerEmailPerHour} codes to this email in the last hour. Use the newest one, or try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`, { retry_after_seconds: take.wait });
    }
    if (take.refused === "budget") return withoutCode("mail_budget");

    const code = newCode();
    // To the address on file, never a look-alike typed later (jane+x@… is jane@…'s voter).
    const mail = await sendCode(env, voter.email, code);
    if (!mail.ok) {
      if (mail.sent === "no") await releaseSendSlot(db, take.slot);
      return withoutCode("mail_error");
    }
    await storeCode(env, db, voter.id, code, nowS);
    return codeSent(true, VERIFICATION.resendCooldown, VERIFICATION.codeTtl);
  },
});
