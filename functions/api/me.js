// GET /api/me — Authorization: Bearer <token>. What a returning visitor needs to draw their own
// state: their first name and the slugs they currently like. 401 means: show the gate again.
import { HttpError, json, route } from "../_lib/http.js";
import { requireVoter } from "../_lib/token.js";
import { firstName } from "../_lib/validate.js";
import { LIKED_SLUGS_SQL } from "./voters.js";

export const onRequest = route({
  async GET({ request, env }) {
    const voterId = await requireVoter(request, env);
    const [voterRes, likedRes] = await env.DB.batch([
      env.DB.prepare("SELECT name FROM voters WHERE id = ?1").bind(voterId),
      env.DB.prepare(LIKED_SLUGS_SQL).bind(voterId),
    ]);
    const voter = voterRes.results[0];
    if (!voter) throw new HttpError(401, "invalid_token", "Sign in again to continue.");
    return json({ voter: { first_name: firstName(voter.name) }, liked: likedRes.results.map((r) => r.slug) });
  },
});
