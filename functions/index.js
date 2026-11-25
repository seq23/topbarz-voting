// GET / — the voting page. While the holiday party is on (HOLIDAY_EVENT, preview until Scooter says
// go live), the HTML itself carries the party's words: the title, the description and every link
// preview tag (link previews run no script), the gallery labels, the lede, the empty and not-open
// notes, the foot mark, the end of voting in Eastern time and "Prize details TBD" (Scooter, 19 Nov
// 2026) (the vote box's lighter words are public/js/gate.js's own). Not one "CultureCon" is left
// in what the server sends (tests/party.test.mjs). Off (production), the page is served untouched.
// The words come from public/js/party-copy.js, the same object the page's own script uses.
import { PARTY_VOTING_ENDS_AT } from "./_lib/config.js";
import { holidayOn } from "./_lib/party.js";
import { HOLIDAY } from "../public/js/party-copy.js";
import { formatEndsLine, rulesEndLine } from "../public/js/logic.js";

const text = (value) => ({ element(el) { el.setInnerContent(value); } });
const attr = (name, value) => ({ element(el) { el.setAttribute(name, value); } });
const hide = { element(el) { el.setAttribute("hidden", ""); } };
const blank = { element(el) { el.setAttribute("hidden", ""); el.setInnerContent(""); } };

export function dressVotingPage(response) {
  const H = HOLIDAY.home;
  const ends = PARTY_VOTING_ENDS_AT ? formatEndsLine(Date.parse(PARTY_VOTING_ENDS_AT), HOLIDAY.dates.zone) : "";
  return new HTMLRewriter()
    .on("html", { element(el) { el.setAttribute("class", "is-holiday"); el.setAttribute("data-dressed", "server"); } })
    .on("title", text(H.pageTitle))
    .on('meta[name="description"]', attr("content", H.description))
    .on('meta[property="og:title"]', attr("content", H.shareTitle))
    .on('meta[property="og:description"]', attr("content", H.shareDescription))
    .on('meta[property="og:image:alt"]', attr("content", H.imageAlt))
    .on('meta[name="twitter:title"]', attr("content", H.shareTitle))
    .on('meta[name="twitter:description"]', attr("content", H.shareDescription))
    .on("#tbz-gallery", attr("aria-label", H.galleryLabel))
    .on("#tbz-strip", attr("aria-label", H.galleryLabel))
    .on("#tbz-lightbox", attr("aria-label", H.galleryLabel))
    .on(".intro .lede", text(H.lede))
    // The party's end, in Eastern time, before the script runs (app.js keeps it in step with
    // /api/state and runs the countdown). No end set: those lines are hidden, their CultureCon words
    // gone too (hidden is not gone).
    .on("p.window", ends ? {} : hide)
    .on("#tbz-ends", text(ends))
    .on("#tbz-countdown-row", ends ? {} : hide)
    .on("#tbz-rule-ends", ends ? text(rulesEndLine(false, ends)) : blank)
    .on("#tbz-tracks-title", text(H.tracksTitle))
    .on("#tbz-notopen-note", text(H.notOpen))
    .on("#tbz-empty p:nth-of-type(2)", text(H.emptyNote))
    .on('section[aria-labelledby="tbz-prize-title"] p', text(HOLIDAY.prize))
    .on(".foot-mark", text(H.footMark))
    .transform(response);
}

export async function onRequest(context) {
  const res = await context.next();
  if (!holidayOn(context.env) || !(res.headers.get("content-type") ?? "").includes("text/html")) return res;
  const dressed = dressVotingPage(res);
  const headers = new Headers(dressed.headers);
  headers.delete("content-length");
  headers.delete("etag");
  headers.set("cache-control", "no-cache");
  return new Response(dressed.body, { status: dressed.status, headers });
}
