// The QR sign-up (/join; Scooter, 17 Nov 2026, and his revision list of 18 Nov: "Each person signs
// up on their own - name, email, phone, city, Instagram - and holds one active place in line. No
// group setup on the guest side."). One person, on their own phone; friends each sign up on theirs,
// and the team taps them into the booth together. After that the page shows the person's place and
// refreshes it, so they can wait inside. One active place per person: an email already in line is
// refused with what is happening, and once their song is uploaded one tap puts them back in line.
// The phone keeps ONE thing, the person's key (localStorage tbz.party.guest), so a reload shows the
// place again; never their details (the browser's own autofill fills the form).
import { api } from "./api.js";
import { $ } from "./dom.js";
import { festive } from "./festive.js";
import { HOLIDAY } from "./party-copy.js";
import { COPY } from "./join-copy.js";
import { GUEST_KEY, GUEST_POLL_MS, isGuestKey, joinPayload, placeWords } from "./party-rules.js";

const els = {
  loading: $("tbz-join-loading"), off: $("tbz-join-off"), offTitle: $("tbz-join-off-title"), offNote: $("tbz-join-off-note"),
  intro: $("tbz-join-intro"), headline: $("tbz-join-headline"), lede: $("tbz-join-lede"),
  form: $("tbz-join-form"), slotTitle: $("tbz-join-slot-title"),
  name: $("tbz-join-name"), phone: $("tbz-join-phone"), mail: $("tbz-join-email"), city: $("tbz-join-city"), instagram: $("tbz-join-instagram"),
  website: $("tbz-join-website"), error: $("tbz-join-error"), send: $("tbz-join-send"),
  done: $("tbz-join-done"), doneTitle: $("tbz-join-done-title"), hello: $("tbz-join-hello"), place: $("tbz-join-place"), next: $("tbz-join-next"),
  refresh: $("tbz-join-refresh"), again: $("tbz-join-again"), forget: $("tbz-join-forget"),
};
const fields = { name: els.name, phone: els.phone, email: els.mail, city: els.city, instagram: els.instagram };
const app = { key: null, view: null, timer: null, busy: false };

// ── The words
document.title = `${COPY.headline} | Top Barz`;
els.offTitle.textContent = HOLIDAY.off;
els.offNote.textContent = HOLIDAY.offNote;
els.headline.textContent = COPY.headline;
els.lede.textContent = COPY.intro;
els.slotTitle.textContent = COPY.slotTitle;
for (const [id, key] of [["tbz-join-name-label", "nameLabel"], ["tbz-join-phone-label", "phoneLabel"], ["tbz-join-email-label", "emailLabel"], ["tbz-join-city-label", "cityLabel"], ["tbz-join-instagram-label", "instagramLabel"]]) $(id).textContent = COPY[key];
els.send.textContent = COPY.send;
els.doneTitle.textContent = COPY.doneTitle;
els.again.textContent = COPY.again;
els.forget.textContent = COPY.forget;

// ── The one thing kept: the person's key
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
const read = () => ({ name: els.name.value, phone: els.phone.value, email: els.mail.value, city: els.city.value, instagram: els.instagram.value });

// ── After sign-up: the place, and what happens next
function draw(view) {
  app.view = view;
  const s = view.session;
  els.hello.textContent = COPY.hello.replace("{name}", view.you.first_name);
  els.place.textContent = placeWords(COPY, s);
  els.place.dataset.status = s.status;
  els.next.textContent = s.status === "done" ? COPY.nextDone : s.status === "waiting" ? COPY.nextWaiting : "";
  els.next.hidden = !els.next.textContent;
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
    if (err?.code === "no_guest") { dropKey(); app.key = null; show("form"); return; }
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

// ── The form: one person
els.form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (app.busy) return;
  const { body, problem } = joinPayload(read(), els.website.value);
  if (problem) { sayError(COPY[problem.key], problem.field); return; }
  sayError("");
  app.busy = true;
  els.send.disabled = true;
  els.send.textContent = COPY.sending;
  try {
    const { data } = await api("/api/party/join", { method: "POST", body, timeout: 12000 });
    els.form.reset();
    signedUp(data, data.guest_key);
  } catch (err) {
    sayError(err?.message || COPY.failed, err?.extra?.field);
  } finally {
    app.busy = false;
    els.send.disabled = false;
    els.send.textContent = COPY.send;
  }
});
// Back in line: one tap, the same person with the details they gave (POST /api/party/rejoin). If
// they are somehow still in line, the server says where, in words.
els.again.addEventListener("click", async () => {
  if (app.busy || !app.key) return;
  app.busy = true;
  els.again.disabled = true;
  try {
    const { data } = await api("/api/party/rejoin", { method: "POST", body: { guest_key: app.key }, timeout: 12000 });
    clearTimeout(app.timer);
    signedUp(data, data.guest_key);
  } catch (err) {
    if (err?.code === "no_guest") { dropKey(); app.key = null; show("form"); return; }
    els.refresh.textContent = err?.message || COPY.failed;
    els.refresh.hidden = false;
  } finally {
    app.busy = false;
    els.again.disabled = false;
  }
});
els.forget.addEventListener("click", () => {
  clearTimeout(app.timer);
  dropKey();
  app.key = null;
  els.form.reset();
  show("form");
  els.name.focus();
});
document.addEventListener("visibilitychange", () => { if (!document.hidden && app.key) refresh(); });

// ── On load: is the party on? Then either this phone's place, or the form.
show("loading");
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
