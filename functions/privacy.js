// /privacy. While the holiday party is on (preview until Scooter says go live), the note carries the
// party's words: what /join collects (phone and Instagram included), that the signed-in team sees it
// to text people, and that it never leaves this site. It is marked DRAFT like /holiday-rules. Not one
// "CultureCon" is left in it (tests/smoke.mjs). Off (production), the page is served untouched.
import { holidayOn } from "./_lib/party.js";
import { PARTY_PRIVACY } from "./_lib/party-privacy.js";

export function dressPrivacyPage(response) {
  const P = PARTY_PRIVACY;
  return new HTMLRewriter()
    .on("html", { element(el) { el.setAttribute("data-dressed", "server"); } })
    .on("title", { element(el) { el.setInnerContent(P.pageTitle); } })
    .on('meta[name="description"]', { element(el) { el.setAttribute("content", P.description); } })
    .on("main.doc", { element(el) { el.setInnerContent(P.html, { html: true }); } })
    .transform(response);
}

export async function onRequest(context) {
  const res = await context.next();
  if (!holidayOn(context.env) || !(res.headers.get("content-type") ?? "").includes("text/html")) return res;
  const dressed = dressPrivacyPage(res);
  const headers = new Headers(dressed.headers);
  headers.delete("content-length");
  headers.delete("etag");
  headers.set("cache-control", "no-cache");
  return new Response(dressed.body, { status: dressed.status, headers });
}
