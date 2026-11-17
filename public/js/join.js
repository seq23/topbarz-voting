// The QR sign-up (/join; Scooter, 17 Nov 2026, with his preview notes the same day). One person
// starts, says how many of them are going in the booth, and hands the phone around: each person
// fills their own slot (name, number, email, city, Instagram), one at a time, so nobody types into
// someone else's. They go in line as one group, and the team moves the group with one tap.
// After that the page shows the group's place and refreshes it, so they can wait inside.
// One active place per person: an email already in line is refused with what is happening, and
// once a group's song is uploaded the same people can get back in line.
// The phone keeps ONE thing, the group's key (localStorage tbz.party.guest), so a reload shows the
// place again; never anyone's details. The slots live in the page only until they are sent.
import { api } from "./api.js";
import { $, h } from "./dom.js";
import { festive } from "./festive.js";
import { HOLIDAY } from "./party-copy.js";
import { COPY } from "./join-copy.js";
import { GROUP_MAX, GUEST_KEY, GUEST_POLL_MS, groupLabel, isGuestKey, joinPayload, placeWords, slotProblem } from "./party-rules.js";

const els = {
  loading: $("tbz-join-loading"), off: $("tbz-join-off"), offTitle: $("tbz-join-off-title"), offNote: $("tbz-join-off-note"),
  intro: $("tbz-join-intro"), headline: $("tbz-join-headline"), lede: $("tbz-join-lede"),
  form: $("tbz-join-form"), size: $("tbz-join-size"), sizeNote: $("tbz-join-size-note"), filled: $("tbz-join-done-slots"), slotTitle: $("tbz-join-slot-title"), slotNote: $("tbz-join-slot-note"),
  name: $("tbz-join-name"), phone: $("tbz-join-phone"), mail: $("tbz-join-email"), city: $("tbz-join-city"), instagram: $("tbz-join-instagram"),
  website: $("tbz-join-website"), error: $("tbz-join-error"), send: $("tbz-join-send"), back: $("tbz-join-back"),
  done: $("tbz-join-done"), doneTitle: $("tbz-join-done-title"), hello: $("tbz-join-hello"), place: $("tbz-join-place"), groupTitle: $("tbz-join-group-title"), names: $("tbz-join-names"),
  refresh: $("tbz-join-refresh"), again: $("tbz-join-again"), forget: $("tbz-join-forget"),
};
const fields = { name: els.name, phone: els.phone, email: els.mail, city: els.city, instagram: els.instagram };
const app = { key: null, view: null, timer: null, busy: false, size: 1, slots: [{}], at: 0 };

// ── The words
document.title = `${COPY.headline} | Top Barz`;
els.offTitle.textContent = HOLIDAY.off;
els.offNote.textContent = HOLIDAY.offNote;
els.headline.textContent = COPY.headline;
els.lede.textContent = COPY.intro;
for (const [id, key] of [["tbz-join-size-label", "sizeLabel"], ["tbz-join-name-label", "nameLabel"], ["tbz-join-phone-label", "phoneLabel"], ["tbz-join-email-label", "emailLabel"], ["tbz-join-city-label", "cityLabel"], ["tbz-join-instagram-label", "instagramLabel"]]) $(id).textContent = COPY[key];
els.sizeNote.textContent = COPY.sizeNote;
els.size.replaceChildren(...Array.from({ length: GROUP_MAX }, (_, i) => h("option", { value: String(i + 1), text: i === 0 ? COPY.sizeOne : COPY.sizeMany.replace("{n}", String(i + 1)) })));
els.doneTitle.textContent = COPY.doneTitle;
els.groupTitle.textContent = COPY.groupTitle;
els.again.textContent = COPY.again;
els.forget.textContent = COPY.forget;

// ── The one thing kept: the group's key
const savedKey = () => { try { const k = localStorage.getItem(GUEST_KEY); return isGuestKey(k) ? k : null; } catch { return null; } };
const saveKey = (k) => { try { localStorage.setItem(GUEST_KEY, k); } catch {} };
const dropKey = () => { try { localStorage.removeItem(GUEST_KEY); } catch {} };

function show(which) {
  els.loading.hidden = which !== "loading";
  els.off.hidden = which !== "off";
  els.intro.hidden = which !== "form";
  els.form.hidden = which !== "form";
  els.done.hidden = which !== "done";
}
function sayError(text, field) {
  els.error.textContent = text || "";
  els.error.hidden = !text;
  for (const input of Object.values(fields)) input.removeAttribute("aria-invalid");
  if (field && fields[field]) { fields[field].setAttribute("aria-invalid", "true"); fields[field].focus(); }
}

// ── The slots: one person at a time on the one phone
const read = () => ({ name: els.name.value, phone: els.phone.value, email: els.mail.value, city: els.city.value, instagram: els.instagram.value });
function fill(slot) {
  els.name.value = slot.name ?? ""; els.phone.value = slot.phone ?? ""; els.mail.value = slot.email ?? ""; els.city.value = slot.city ?? ""; els.instagram.value = slot.instagram ?? "";
}
const sendWords = () => (app.at === app.size - 1 ? (app.size > 1 ? COPY.sendGroup : COPY.send) : COPY.next.replace("{n}", String(app.at + 2)));
function drawSlot({ focus = false } = {}) {
  const n = app.at + 1;
  const total = app.size;
  els.size.disabled = app.at > 0;
  els.slotTitle.textContent = total === 1 ? COPY.slotTitleOne : COPY.slotTitle.replace("{n}", String(n)).replace("{total}", String(total));
  els.slotNote.textContent = total === 1 ? "" : app.at === 0 ? COPY.slotFirst : COPY.slotPass.replace("{n}", String(n));
  els.slotNote.hidden = total === 1;
  els.send.textContent = sendWords();
  els.back.hidden = app.at === 0;
  els.back.textContent = COPY.back.replace("{n}", String(n - 1));
  // Who is already in, by first name only: the next person sees that they're there, not what they typed.
  const done = app.slots.slice(0, app.at);
  els.filled.hidden = done.length === 0;
  els.filled.replaceChildren(...done.map((s, i) => h("li", {}, h("span", { text: COPY.filled.replace("{name}", String(s.name).trim().split(" ")[0] || `Person ${i + 1}`) }), h("button", { type: "button", class: "link-btn", text: COPY.edit, "aria-label": `${COPY.edit} person ${i + 1}`, onclick: () => goTo(i) }))));
  fill(app.slots[app.at] ?? {});
  sayError("");
  if (focus) { els.slotTitle.focus({ preventScroll: true }); els.slotTitle.scrollIntoView({ block: "start" }); }
}
function goTo(i) {
  app.slots[app.at] = read();
  app.at = i;
  drawSlot({ focus: true });
}
function resetForm() {
  app.size = 1; app.slots = [{}]; app.at = 0;
  els.size.value = "1";
  els.website.value = "";
  drawSlot();
}
els.size.addEventListener("change", () => {
  app.size = Math.min(GROUP_MAX, Math.max(1, Number(els.size.value) || 1));
  app.slots = Array.from({ length: app.size }, (_, i) => app.slots[i] ?? {});
  drawSlot();
});
els.back.addEventListener("click", () => goTo(Math.max(0, app.at - 1)));

// ── After sign-up: the place and the group
function draw(view) {
  app.view = view;
  const s = view.session;
  els.hello.textContent = s.size > 1 ? COPY.helloGroup.replace("{names}", groupLabel(s.names)) : COPY.hello.replace("{name}", view.you.first_name);
  els.place.textContent = placeWords(COPY, s);
  els.place.dataset.status = s.status;
  els.groupTitle.hidden = s.size < 2;
  els.names.hidden = s.size < 2;
  els.names.textContent = groupLabel(s.names);
  els.again.hidden = s.status !== "done";
}
async function refresh() {
  clearTimeout(app.timer);
  if (!app.key || document.hidden) { app.timer = setTimeout(refresh, GUEST_POLL_MS); return; }
  try {
    const { data } = await api("/api/party/me", { method: "POST", body: { guest_key: app.key }, timeout: 10000 });
    els.refresh.hidden = true;
    draw(data);
  } catch (err) {
    if (err?.code === "no_guest") { dropKey(); app.key = null; resetForm(); show("form"); return; }
    els.refresh.textContent = COPY.refreshFailed;
    els.refresh.hidden = false;
  }
  app.timer = setTimeout(refresh, GUEST_POLL_MS);
}
function signedUp(view, key) {
  app.key = key;
  saveKey(key);
  draw(view);
  show("done");
  els.doneTitle.focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
  app.timer = setTimeout(refresh, GUEST_POLL_MS);
}

// ── The form: Next moves to the following person; the last one sends the whole group
els.form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (app.busy) return;
  app.slots[app.at] = read();
  const problem = slotProblem(joinPayload([app.slots[app.at]]).body.guests[0]);
  if (problem) { sayError(COPY[problem.key], problem.field); return; }
  if (app.at < app.size - 1) { app.at += 1; drawSlot({ focus: true }); return; }
  const { body, problem: groupProblem } = joinPayload(app.slots, els.website.value);
  if (groupProblem) { app.at = groupProblem.slot; drawSlot(); sayError(COPY[groupProblem.key], groupProblem.field); return; }
  sayError("");
  app.busy = true;
  els.send.disabled = true;
  els.send.textContent = COPY.sending;
  try {
    const { data } = await api("/api/party/join", { method: "POST", body, timeout: 12000 });
    resetForm();
    signedUp(data, data.guest_key);
  } catch (err) {
    // The server names the slot it refused (an email already in line, a bad field): go to it.
    const slot = Number.isInteger(err?.extra?.slot) ? err.extra.slot : app.at;
    if (slot !== app.at && slot < app.size) { app.at = slot; drawSlot(); }
    sayError(err?.message || COPY.failed, err?.extra?.field);
  } finally {
    app.busy = false;
    els.send.disabled = false;
    els.send.textContent = sendWords();
  }
});
function newSignUp() {
  clearTimeout(app.timer);
  dropKey();
  app.key = null;
  resetForm();
  show("form");
  els.size.focus();
}
els.again.addEventListener("click", newSignUp);
els.forget.addEventListener("click", newSignUp);
document.addEventListener("visibilitychange", () => { if (!document.hidden && app.key) refresh(); });

// ── On load: is the party on? Then either this phone's place, or the form.
show("loading");
resetForm();
if (!(await festive())) {
  show("off");
} else {
  const key = savedKey();
  // A phone that signed up before: its place again. No connection: say so and try again by itself.
  const resume = async () => {
    try {
      const { data } = await api("/api/party/me", { method: "POST", body: { guest_key: key }, timeout: 10000 });
      signedUp(data, key);
    } catch (err) {
      if (err?.code === "no_guest") { dropKey(); show("form"); return; }
      els.loading.textContent = COPY.refreshFailed;
      setTimeout(resume, GUEST_POLL_MS);
    }
  };
  if (key) await resume(); else show("form");
}
