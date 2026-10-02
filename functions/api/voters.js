// POST /api/voters — the gate. Body: { name, email, city, marketing_opt_in?, website? }.
// `website` is the honeypot: a person never sees it, so anything in it is a bot.
// Returns { token, voter: { first_name }, liked: [slug…], returning }. The token is what likes
// and comments are sent with. The same email again is the same voter (and gets their likes back).
import { LIMITS, NAME_MAX_CHARS } from "../_lib/config.js";
import { HttpError, ipHash, json, readJson, route } from "../_lib/http.js";
import { assertUnderLimit, limitStatement, maybePrune } from "../_lib/ratelimit.js";
import { signVoterToken } from "../_lib/token.js";
import { cleanText, firstName, parseEmail } from "../_lib/validate.js";

export const LIKED_SLUGS_SQL = `
SELECT t.slug FROM tracks t WHERE t.active = 1 AND
  (SELECT e.action FROM like_events e WHERE e.voter_id = ?1 AND e.track_id = t.id ORDER BY e.id DESC LIMIT 1) = 'like'
ORDER BY t.sort, t.label, t.id`;

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

    const ip = await ipHash(request, env);
    const now = new Date().toISOString();
    const db = env.DB;
    const [ipLimit, emailLimit] = await db.batch([
      limitStatement(db, `gate:ip:${ip}`, LIMITS.gatePerIp),
      limitStatement(db, `gate:email:${parsed.emailKey}`, LIMITS.gatePerEmail),
    ]);
    assertUnderLimit(ipLimit, LIMITS.gatePerIp, "sign-ups");
    assertUnderLimit(emailLimit, LIMITS.gatePerEmail, "sign-ups");

    // One row per mailbox. A second visit keeps the first name, email and city on file, and can
    // only ever turn the marketing opt-in ON.
    const voter = await db
      .prepare(
        `INSERT INTO voters (name, email, email_key, city, marketing_opt_in, created_at, ip_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (email_key) DO UPDATE SET marketing_opt_in = MAX(marketing_opt_in, excluded.marketing_opt_in)
         RETURNING id, name, created_at`,
      )
      .bind(name, parsed.email, parsed.emailKey, city, optIn, now, ip)
      .first();

    const liked = (await db.prepare(LIKED_SLUGS_SQL).bind(voter.id).all()).results.map((r) => r.slug);
    maybePrune(context);
    return json({
      token: await signVoterToken(env, voter.id),
      voter: { first_name: firstName(voter.name) },
      liked,
      returning: voter.created_at !== now,
    });
  },
});
