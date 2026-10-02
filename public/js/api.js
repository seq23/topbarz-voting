// The page's one way to the server, and the one place a voter is remembered.
import { isVoterToken, pruneOwn, readOwn, readPending, rememberOwn } from "./logic.js";

export class ApiError extends Error {
  constructor(code, message, status = 0, extra = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

// → { data, date } (date = the server's Date header). Throws ApiError with words to show:
// the server's own `message`, or a plain line for no connection / too slow.
export async function api(path, { method = "GET", body, token, timeout = 12000, signal } = {}) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeout);
  const cancel = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", cancel, { once: true });
  }
  try {
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(path, {
      method, headers, credentials: "same-origin", signal: ctrl.signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (err) { if (ctrl.signal.aborted) throw err; }
    if (!res.ok) {
      throw new ApiError(data?.error || `http_${res.status}`, data?.message || "Something went wrong on our side. Try again.", res.status, data);
    }
    if (data === null || typeof data !== "object") throw new ApiError("bad_response", "The server sent something we could not read. Try again.", res.status);
    return { data, date: res.headers.get("date") };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (signal?.aborted) throw new ApiError("cancelled", "Cancelled.");
    if (timedOut) throw new ApiError("timeout", "That is taking too long. Check your connection and try again.");
    throw new ApiError("network", "No connection. Check your signal and try again.");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", cancel);
  }
}

// ── The remembered voter: { token, first_name } in localStorage, and the token in a cookie ────
// (two places, so clearing one does not bring the form back). Never an email.
export const VOTER_KEY = "tbz.voter";
const COOKIE = "tbz_voter";
const COOKIE_DAYS = 90;

function readCookie() {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(document.cookie || "");
  return m ? decodeURIComponent(m[1]) : null;
}

function writeCookie(value, maxAge) {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${COOKIE}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; SameSite=Lax${secure}`;
}

export function loadVoter() {
  try {
    const raw = localStorage.getItem(VOTER_KEY);
    if (raw) {
      const rec = JSON.parse(raw);
      if (isVoterToken(rec?.token)) return { token: rec.token, first_name: typeof rec.first_name === "string" ? rec.first_name : "" };
    }
  } catch {}
  try {
    const token = readCookie();
    if (isVoterToken(token)) return { token, first_name: "" };
  } catch {}
  return null;
}

export function saveVoter(rec) {
  if (!isVoterToken(rec?.token)) return;
  const clean = { token: rec.token, first_name: rec.first_name || "" };
  try { localStorage.setItem(VOTER_KEY, JSON.stringify(clean)); } catch {}
  try { writeCookie(clean.token, COOKIE_DAYS * 86400); } catch {}
}

export function forgetVoter() {
  try { localStorage.removeItem(VOTER_KEY); } catch {}
  try { writeCookie("", 0); } catch {}
}

// ── A voter part-way through the email code ───────────────────────────────────────────────────
// What they typed at the gate and the code's timings (logic.js, pendingRecord), in localStorage
// only, so a refresh or a closed popup returns them to the code step. Never the code. Forgotten
// the moment they are let in or change the email, and after an hour whatever happens.
export const PENDING_KEY = "tbz.pending";

export function loadPending(now = Date.now()) {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const rec = readPending(JSON.parse(raw), now);
    if (!rec) localStorage.removeItem(PENDING_KEY);
    return rec;
  } catch {}
  return null;
}

export function savePending(rec, now = Date.now()) {
  const clean = readPending(rec, now);
  if (!clean) return;
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(clean)); } catch {}
}

export function forgetPending() {
  try { localStorage.removeItem(PENDING_KEY); } catch {}
}

// ── What this device itself just changed (logic.js, rememberOwn): counts only, for a minute ───
export const OWN_KEY = "tbz.own";

export function loadOwn(now = Date.now()) {
  try { return pruneOwn(JSON.parse(localStorage.getItem(OWN_KEY) || "null"), now); } catch {}
  return {};
}

export function saveOwn(own, now = Date.now()) {
  const clean = pruneOwn(own, now);
  try {
    if (Object.keys(clean).length) localStorage.setItem(OWN_KEY, JSON.stringify(clean));
    else localStorage.removeItem(OWN_KEY);
  } catch {}
}

// Keep the server's answer to this voter's own like or comment (`until`: logic.js, holdFrom).
export function keepOwn(slug, patch, until, now = Date.now()) {
  saveOwn(rememberOwn(loadOwn(now), slug, patch, until, now), now);
}

// The remembered counts for a track while a state built at `generatedAt` is older than they are.
export function ownCounts(stored, slug, generatedAt, now = Date.now()) {
  return readOwn(stored, slug, generatedAt, now);
}
