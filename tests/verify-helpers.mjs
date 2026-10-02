// Shared by tests/verify*.test.mjs: an env with email verification on, and a fetch stub that
// stands in for Resend and for the DNS resolver. No test ever reaches the real ones.
import { VERIFICATION } from "../functions/_lib/config.js";

export const RESEND_STUB = "https://resend.stub.test/emails";
export const TEST_MAIL_KEY = "re_test_key_not_a_real_one";
export const VERIFY_ENV = { EMAIL_VERIFICATION: "on", RESEND_API_KEY: TEST_MAIL_KEY, RESEND_ENDPOINT: RESEND_STUB };
// What a voter token looks like, anywhere in an answer.
export const TOKEN_RE = /v1\.[0-9]+\.[A-Za-z0-9_-]{43}/;

const dnsJson = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/dns-json" } });
export const dns = {
  mx: () => dnsJson({ Status: 0, Answer: [{ name: "example.com", type: 15, TTL: 300, data: "10 mx.example.net." }] }),
  nxdomain: () => dnsJson({ Status: 3 }),
  nodata: () => dnsJson({ Status: 0 }),
  nullMx: () => dnsJson({ Status: 0, Answer: [{ type: 15, data: "0 ." }] }),
  a: () => dnsJson({ Status: 0, Answer: [{ type: 1, data: "192.0.2.1" }] }),
  servfail: () => dnsJson({ Status: 2 }),
};

// mail.sent = emails Resend accepted (each with .to, .code, .body, .headers); mail.attempts = every
// call to Resend; mail.lookups = every DNS question. Set mail.resend / mail.lookup to change the
// stubs mid-test. Any other fetch is an error.
export function stubMail(t, { resend, lookup } = {}) {
  const mail = {
    sent: [], attempts: [], lookups: [],
    resend: resend ?? (() => new Response('{"id":"stub"}', { status: 200 })),
    lookup: lookup ?? (() => dns.mx()),
  };
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (String(input) === RESEND_STUB) {
      const body = JSON.parse(init.body);
      const entry = { method: init.method, headers: new Headers(init.headers), body, to: body.to[0], code: /\b([0-9]{6})\b/.exec(body.text)?.[1] };
      mail.attempts.push(entry);
      const res = await mail.resend(entry);
      if (res.ok) mail.sent.push(entry);
      return res;
    }
    if (url.origin + url.pathname === VERIFICATION.dohEndpoint) {
      const q = { name: url.searchParams.get("name"), type: url.searchParams.get("type") };
      mail.lookups.push(q);
      return mail.lookup(q.name, q.type);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  t.after(() => { globalThis.fetch = real; });
  return mail;
}

export const wrongCode = (code) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");
