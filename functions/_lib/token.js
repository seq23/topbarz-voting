// The voter token: "v1.<voter id>.<HMAC-SHA256 of 'v1.<voter id>'>", signed with VOTER_TOKEN_SECRET.
// Likes and comments act on the id inside a token we signed, never on an email the browser sends,
// so nobody can vote as someone else by typing their address into a request.
import { HttpError } from "./http.js";

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function fromB64url(text) {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function key(env) {
  const secret = env?.VOTER_TOKEN_SECRET;
  if (!secret) throw new HttpError(503, "token_secret_missing", "Voting is not switched on yet (the server has no signing secret).");
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signVoterToken(env, voterId) {
  const payload = `v1.${voterId}`;
  const sig = await crypto.subtle.sign("HMAC", await key(env), enc.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

// → voter id (number) or null. Constant-time via crypto.subtle.verify.
export async function verifyVoterToken(env, token) {
  const k = await key(env);
  if (typeof token !== "string" || token.length > 200) return null;
  const m = /^v1\.([1-9][0-9]{0,14})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  let sig;
  try { sig = fromB64url(m[2]); } catch { return null; }
  const ok = await crypto.subtle.verify("HMAC", k, sig, enc.encode(`v1.${m[1]}`));
  return ok ? Number(m[1]) : null;
}

export function bearer(request) {
  const h = request.headers.get("authorization") || "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : null;
}

// The voter a request acts as: a valid token AND a row that still exists. Otherwise 401, and the
// front end shows the gate again.
export async function requireVoter(request, env, bodyToken) {
  const id = await verifyVoterToken(env, bearer(request) ?? bodyToken);
  if (!id) throw new HttpError(401, "invalid_token", "Sign in again to continue.");
  return id;
}
