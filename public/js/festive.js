// The holiday look (Scooter, 17 Nov 2026): string lights across the top, the partner's logo beside
// the Top Barz one, and the contest's name, on the guest pages, only while the party is switched
// on (GET /api/party). Off, the page is exactly as it was. The lights are drawn in CSS and stand
// still for anyone who turns motion off. A value Scooter has not sent yet shows as a marked
// stand-in (party-copy.js), never as a promise.
import { h } from "./dom.js";
import { HOLIDAY } from "./party-copy.js";

export async function partyOn() {
  try {
    const res = await fetch("/api/party", { headers: { accept: "application/json" }, credentials: "same-origin" });
    return res.ok && (await res.json())?.on === true;
  } catch {
    return false;
  }
}

// A value, or its marked stand-in.
export function standIn(value, key) {
  if (value) return h("span", { text: value });
  return h("span", { class: "stand-in", text: HOLIDAY.standIn[key] }, h("span", { class: "stand-in-mark", text: ` (${HOLIDAY.standIn.mark})` }));
}

export function dressUp() {
  document.documentElement.classList.add("is-holiday");
  const top = document.querySelector(".top");
  if (!top || top.querySelector(".lights")) return;
  const bulbs = Array.from({ length: 24 }, (_, i) => h("span", { class: `bulb bulb-${i % 4}` }));
  const logo = HOLIDAY.logo
    ? h("img", { class: "partner-logo", src: HOLIDAY.logo, alt: HOLIDAY.partnerName || HOLIDAY.standIn.partnerName, width: 120, height: 120 })
    : h("span", { class: "partner-logo partner-slot stand-in", text: HOLIDAY.standIn.logo });
  top.prepend(h("div", { class: "lights", "aria-hidden": "true" }, bulbs));
  top.querySelector(".logo")?.after(h("div", { class: "partner" }, h("span", { class: "partner-x", "aria-hidden": "true", text: "×" }), logo));
  top.append(h("p", { class: "holiday-line" }, h("span", { text: `${HOLIDAY.title} · ` }), standIn(HOLIDAY.partnerName, "partnerName"), h("span", { text: " · " }), standIn(HOLIDAY.eventDate, "eventDate")));
}

// Ask once; dress the page up if the party is on. → whether it is.
export async function festive() {
  const on = await partyOn();
  if (on) dressUp();
  return on;
}
