// The holiday look (Scooter, 17 Nov 2026, with his preview notes): string lights across the top,
// the Top Barz logo at its usual size, and under it "in partnership with" and one row of the three
// partners' logos (white versions of their marks on the black, sized by visual weight), on the guest
// pages, only while the party is switched on (GET /api/party). On the voting page it also swaps the
// CultureCon words for the party's (party-copy.js). Off, every page is exactly as it was. The lights
// are drawn in CSS and stand still for anyone who turns motion off.
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

// The "in partnership with" row: each logo at its own height (a CSS variable per logo, desktop and
// phone), so the row reads even.
export function partnerRow() {
  return h("div", { class: "partners" },
    h("p", { class: "partners-with", text: HOLIDAY.partnersWith }),
    h("ul", { class: "partners-row" }, ...HOLIDAY.partners.map((p) => {
      const li = h("li", {}, h("img", { src: p.src, alt: p.name, width: p.width, height: p.height, decoding: "async" }));
      // Through the CSSOM: the page's policy allows no inline style attribute.
      li.style.setProperty("--h", `${p.desktop}px`);
      li.style.setProperty("--h-phone", `${p.mobile}px`);
      return li;
    })));
}

// The voting page's words while the party is on: no CultureCon anywhere.
function dressHome() {
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  const lede = document.querySelector(".intro .lede");
  if (!lede || !document.getElementById("tbz-tracks-title")) return;
  // The server already wrote the party's words into the page (functions/index.js).
  if (document.documentElement.dataset.dressed === "server") return;
  const H = HOLIDAY.home;
  document.title = H.pageTitle;
  lede.textContent = H.lede;
  lede.after(h("p", { class: "prize-line" }, h("span", { text: `${HOLIDAY.prize} ` }), h("span", { class: "stand-in-mark", text: `(${HOLIDAY.prizeMark})` })));
  set("tbz-tracks-title", H.tracksTitle);
  set("tbz-notopen-note", H.notOpen);
  const empty = document.querySelector("#tbz-empty p:not(.empty-title)");
  if (empty) empty.textContent = H.emptyNote;
  for (const id of ["tbz-gallery", "tbz-strip", "tbz-lightbox"]) document.getElementById(id)?.setAttribute("aria-label", H.galleryLabel);
  const prize = document.getElementById("tbz-prize-title")?.nextElementSibling;
  if (prize) prize.replaceChildren(h("span", { text: `${HOLIDAY.prize} ` }), h("span", { class: "stand-in-mark", text: `(${HOLIDAY.prizeMark})` }));
  for (const el of document.querySelectorAll(".foot-mark")) el.textContent = H.footMark;
}

export function dressUp() {
  document.documentElement.classList.add("is-holiday");
  const top = document.querySelector(".top");
  if (!top || top.querySelector(".lights")) return;
  const bulbs = Array.from({ length: 24 }, (_, i) => h("span", { class: `bulb bulb-${i % 4}` }));
  top.prepend(h("div", { class: "lights", "aria-hidden": "true" }, bulbs));
  top.querySelector(".logo")?.after(partnerRow());
  dressHome();
}

// Ask once; dress the page up if the party is on. → whether it is.
export async function festive() {
  const on = await partyOn();
  if (on) dressUp();
  return on;
}
