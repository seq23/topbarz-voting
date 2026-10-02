// Email verification: the 6-digit code at the gate. Numbers live in config.js (VERIFICATION).
//   · the code comes from crypto randomness and only an HMAC of it is stored (VOTER_TOKEN_SECRET);
//   · mail goes out through Resend (env RESEND_API_KEY; the key never reaches a browser or a log);
//   · before any send, the domain must be able to receive mail (one DNS-over-HTTPS lookup, cached
//     per domain in D1), which keeps bounces off the shared mail account;
//   · every send is a row in email_sends, so the daily budget, the per-email hourly cap and the
//     resend cooldown are counted over true rolling windows.
// The rules about who gets a token are in functions/api/voters.js and functions/api/voters/verify.js.
import { VERIFICATION } from "./config.js";

const enc = new TextEncoder();
const toHex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

// Six digits, every value equally likely (values past the last whole million are thrown away).
export function newCode() {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < 4_294_000_000) return String(buf[0] % 1_000_000).padStart(6, "0");
  }
}

// The code is bound to its voter and can never be confused with a voter token ("v1.<id>").
const codePayload = (voterId, code) => enc.encode(`email-code|${voterId}|${code}`);
const hmacKey = (env) => crypto.subtle.importKey("raw", enc.encode(env.VOTER_TOKEN_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

export async function codeHmac(env, voterId, code) {
  return toHex(await crypto.subtle.sign("HMAC", await hmacKey(env), codePayload(voterId, code)));
}
// Constant-time (crypto.subtle.verify).
export async function codeMatches(env, voterId, code, storedHex) {
  if (typeof storedHex !== "string" || !/^[0-9a-f]{64}$/.test(storedHex)) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(env), fromHex(storedHex), codePayload(voterId, code));
}

export function codeEmail(code) {
  const minutes = Math.round(VERIFICATION.codeTtl / 60);
  const works = `It works for ${minutes} minutes. Enter it on the voting page to count your vote.`;
  const ignore = "If you did not ask for this code, ignore this email.";
  return {
    subject: `${code} is your Top Barz voting code`,
    text: `Your Top Barz voting code is ${code}\n\n${works}\n\n${ignore}\n`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#111111">
<p style="margin:0 0 8px">Your Top Barz voting code is</p>
<p style="margin:0 0 16px;font-size:32px;font-weight:700;letter-spacing:6px">${code}</p>
<p style="margin:0 0 16px">${works}</p>
<p style="margin:0;font-size:14px;color:#555555">${ignore}</p>
</div>`,
  };
}

// → { ok: true } or { ok: false, sent: "no" | "unknown" }. "no" = the service answered and refused
// (4xx, 429 included): nothing went out, so the send is not counted against the budget. "unknown"
// = a 5xx, a timeout or a network error: it may have gone out, so it stays counted.
export async function sendCode(env, to, code) {
  const mail = codeEmail(code);
  let res;
  try {
    res = await fetch(env.RESEND_ENDPOINT || VERIFICATION.resendEndpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: VERIFICATION.from, to: [to], subject: mail.subject, text: mail.text, html: mail.html }),
      signal: AbortSignal.timeout(VERIFICATION.sendTimeoutMs),
    });
  } catch (err) {
    console.error("code email: mail service unreachable", err?.name ?? "error");
    return { ok: false, sent: "unknown" };
  }
  if (res.ok) return { ok: true };
  console.error("code email: mail service answered", res.status);
  return { ok: false, sent: res.status >= 500 ? "unknown" : "no" };
}

// One DNS question → { nx, answers } or null when the lookup itself failed.
async function ask(env, name, type) {
  const url = new URL(env.DOH_ENDPOINT || VERIFICATION.dohEndpoint);
  url.searchParams.set("name", name);
  url.searchParams.set("type", type);
  const res = await fetch(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(VERIFICATION.dnsTimeoutMs) });
  if (!res.ok) return null;
  const data = await res.json();
  if (data?.Status === 3) return { nx: true, answers: [] };
  if (data?.Status !== 0) return null;
  return { nx: false, answers: Array.isArray(data.Answer) ? data.Answer : [] };
}

// → true (has an MX, or an A record to fall back on), false (the domain does not exist, has
// neither, or publishes a "null MX": it takes no mail), or null (the lookup failed: unknown).
// One lookup; the A question is asked only when there is no MX at all.
async function lookUpMail(env, domain) {
  try {
    const mx = await ask(env, domain, "MX");
    if (!mx) return null;
    if (mx.nx) return false;
    const records = mx.answers.filter((a) => a?.type === 15);
    if (records.length) return records.some((r) => !/^\d+\s+\.?$/.test(String(r.data ?? "").trim()));
    const a = await ask(env, domain, "A");
    if (!a) return null;
    return a.answers.some((r) => r?.type === 1);
  } catch {
    return null;
  }
}

// Can this domain receive mail? true / false, or null = unknown. A failed lookup never blocks a
// voter and is never cached.
export async function domainReceivesMail(env, domain, nowS) {
  const db = env.DB;
  const cached = await db.prepare("SELECT receives, checked_at FROM mail_domains WHERE domain = ?1").bind(domain).first();
  if (cached && nowS - cached.checked_at < (cached.receives ? VERIFICATION.domainOkTtl : VERIFICATION.domainBadTtl)) return cached.receives === 1;
  const answer = await lookUpMail(env, domain);
  if (answer === null) return cached?.receives === 1 ? true : null;
  await db
    .prepare("INSERT INTO mail_domains (domain, receives, checked_at) VALUES (?1, ?2, ?3) ON CONFLICT (domain) DO UPDATE SET receives = excluded.receives, checked_at = excluded.checked_at")
    .bind(domain, answer ? 1 : 0, nowS)
    .run();
  return answer;
}

// Reads the send counters and takes one send from the budget in ONE transaction, so two requests
// racing can never both send, and a refusal always knows its true reason.
export async function takeSendSlot(db, voterId, nowS) {
  const V = VERIFICATION;
  const [statsRes, codeRes, slotRes] = await db.batch([
    db.prepare(
      `SELECT
        (SELECT COUNT(*) FROM email_sends WHERE counted = 1 AND sent_at > ?2) AS day,
        (SELECT COUNT(*) FROM email_sends WHERE counted = 1 AND voter_id = ?1 AND sent_at > ?3) AS hour,
        (SELECT MIN(sent_at) FROM email_sends WHERE counted = 1 AND voter_id = ?1 AND sent_at > ?3) AS hour_first,
        (SELECT MAX(sent_at) FROM email_sends WHERE counted = 1 AND voter_id = ?1) AS last`,
    ).bind(voterId, nowS - 86400, nowS - 3600),
    db.prepare("SELECT expires_at, attempts FROM email_codes WHERE voter_id = ?1").bind(voterId),
    db.prepare(
      `INSERT INTO email_sends (voter_id, sent_at) SELECT ?1, ?2 WHERE
        (SELECT COUNT(*) FROM email_sends WHERE counted = 1 AND sent_at > ?3) < ?4
        AND (SELECT COUNT(*) FROM email_sends WHERE counted = 1 AND voter_id = ?1 AND sent_at > ?5) < ?6
        AND NOT EXISTS (SELECT 1 FROM email_sends WHERE counted = 1 AND voter_id = ?1 AND sent_at > ?7)
       RETURNING id`,
    ).bind(voterId, nowS, nowS - 86400, V.dailySendBudget, nowS - 3600, V.sendsPerEmailPerHour, nowS - V.resendCooldown),
  ]);
  const stats = statsRes.results[0];
  const code = codeRes.results[0] ?? null;
  const slot = slotRes.results[0] ?? null;
  if (slot) return { slot: slot.id };
  const sinceLast = stats.last === null ? Infinity : nowS - stats.last;
  if (sinceLast < V.resendCooldown) {
    const live = code && code.expires_at > nowS && code.attempts < V.maxTries;
    return { refused: "cooldown", wait: V.resendCooldown - sinceLast, liveFor: live ? code.expires_at - nowS : 0 };
  }
  if (stats.hour >= V.sendsPerEmailPerHour) return { refused: "hourly", wait: Math.max(1, stats.hour_first + 3600 - nowS) };
  return { refused: "budget" };
}

export const releaseSendSlot = (db, slotId) => db.prepare("UPDATE email_sends SET counted = 0 WHERE id = ?1").bind(slotId).run();

export async function storeCode(env, db, voterId, code, nowS) {
  await db
    .prepare(
      `INSERT INTO email_codes (voter_id, code_hmac, expires_at, attempts) VALUES (?1, ?2, ?3, 0)
       ON CONFLICT (voter_id) DO UPDATE SET code_hmac = excluded.code_hmac, expires_at = excluded.expires_at, attempts = 0`,
    )
    .bind(voterId, await codeHmac(env, voterId, code), nowS + VERIFICATION.codeTtl)
    .run();
}

// Old sends, dead codes and stale domain answers are dead weight (about 1 request in 50).
export function maybePruneVerification(context, nowS) {
  if (Math.random() > 0.02) return;
  const db = context.env.DB;
  context.waitUntil?.(
    db.batch([
      db.prepare("DELETE FROM email_sends WHERE sent_at < ?1").bind(nowS - 2 * 86400),
      db.prepare("DELETE FROM email_codes WHERE expires_at < ?1").bind(nowS - 86400),
      db.prepare("DELETE FROM mail_domains WHERE checked_at < ?1").bind(nowS - 30 * 86400),
    ]).catch(() => {}),
  );
}
