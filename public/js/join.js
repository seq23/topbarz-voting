// The QR sign-up (/join; Scooter, 17 Nov 2026): one person, one phone, one form (name, phone,
// email, city, Instagram). The first of a group gets a 4-letter group code to share; friends type
// it (or open the shared link, /join?group=JXQP) and join that group. After that the page shows
// the guest's place in line and refreshes it, so they can wait inside until they're up.
// The phone keeps ONE thing, the guest's own key (localStorage tbz.party.guest), so a reload
// shows their place again and they can move to a friend's group; never their details.
import { api } from "./api.js";
import { $ } from "./dom.js";
import { festive } from "./festive.js";
import { HOLIDAY } from "./party-copy.js";
import { COPY } from "./join-copy.js";
import { GUEST_KEY, GUEST_POLL_MS, groupFromSearch, groupLabel, isGuestKey, joinLink, joinPayload, placeWords, sessionCodeFrom } from "./party-rules.js";
import { detectPlatform, smsHref } from "./logic.js";

const els = {
  loading: $("tbz-join-loading"), off: $("tbz-join-off"), offTitle: $("tbz-join-off-title"), offNote: $("tbz-join-off-note"),
  intro: $("tbz-join-intro"), headline: $("tbz-join-headline"), lede: $("tbz-join-lede"),
  form: $("tbz-join-form"), name: $("tbz-join-name"), phone: $("tbz-join-phone"), mail: $("tbz-join-email"), city: $("tbz-join-city"), instagram: $("tbz-join-instagram"),
  withGroup: $("tbz-join-with-group"), codeRow: $("tbz-join-code-row"), code: $("tbz-join-code"), website: $("tbz-join-website"), error: $("tbz-join-error"), send: $("tbz-join-send"),
  done: $("tbz-join-done"), doneTitle: $("tbz-join-done-title"), hello: $("tbz-join-hello"), place: $("tbz-join-place"), groupTitle: $("tbz-join-group-title"), names: $("tbz-join-names"),
  codeIntro: $("tbz-join-code-intro"), session: $("tbz-join-session"), share: $("tbz-join-share"), shareMsg: $("tbz-join-share-msg"),
  move: $("tbz-join-move"), moveCode: $("tbz-join-move-code"), moveGo: $("tbz-join-move-go"), leave: $("tbz-join-leave"), moveMsg: $("tbz-join-move-msg"), refresh: $("tbz-join-refresh"), forget: $("tbz-join-forget"),
};
const fields = { name: els.name, phone: els.phone, email: els.mail, city: els.city, instagram: els.instagram, code: els.code, session_code: els.code };
const app = { key: null, view: null, timer: null, busy: false, platform: detectPlatform(navigator) };

// ── The words
document.title = `${COPY.headline} | Top Barz`;
els.offTitle.textContent = HOLIDAY.off;
els.offNote.textContent = HOLIDAY.offNote;
els.headline.textContent = COPY.headline;
els.lede.textContent = COPY.intro;
for (const [id, key] of [["tbz-join-name-label", "nameLabel"], ["tbz-join-phone-label", "phoneLabel"], ["tbz-join-email-label", "emailLabel"], ["tbz-join-city-label", "cityLabel"], ["tbz-join-instagram-label", "instagramLabel"], ["tbz-join-with-group-label", "withGroupLabel"], ["tbz-join-code-label", "codeLabel"], ["tbz-join-move-label", "moveLabel"]]) $(id).textContent = COPY[key];
els.send.textContent = COPY.send;
els.doneTitle.textContent = COPY.doneTitle;
els.groupTitle.textContent = COPY.groupTitle;
els.codeIntro.textContent = COPY.codeIntro;
els.share.textContent = COPY.share;
els.moveGo.textContent = COPY.move;
els.leave.textContent = COPY.leave;
els.forget.textContent = COPY.forget;

// ── The one thing kept: the guest's own key
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

// ── After sign-up: the place, the group, the code to share
function draw(view) {
  app.view = view;
  const s = view.session;
  els.hello.textContent = COPY.hello.replace("{name}", view.you.first_name);
  els.place.textContent = placeWords(COPY, s);
  els.place.dataset.status = s.status;
  els.names.textContent = groupLabel(s.names);
  els.session.textContent = s.code;
  const waiting = s.status === "waiting";
  els.move.hidden = !waiting;
  els.leave.hidden = !waiting || s.size < 2;
  els.share.hidden = !waiting;
  els.codeIntro.hidden = !waiting;
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

// ── The form
els.withGroup.addEventListener("change", () => { els.codeRow.hidden = !els.withGroup.checked; if (els.withGroup.checked) els.code.focus(); });
for (const input of [els.code, els.moveCode]) input.addEventListener("input", () => { const c = sessionCodeFrom(input.value); if (input.value !== c) input.value = c; });
els.form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (app.busy) return;
  const { body, problem } = joinPayload({ name: els.name.value, phone: els.phone.value, email: els.mail.value, city: els.city.value, instagram: els.instagram.value, withGroup: els.withGroup.checked, code: els.code.value, website: els.website.value });
  if (problem) { sayError(COPY[problem.key], problem.field); return; }
  sayError("");
  app.busy = true;
  els.send.disabled = true;
  els.send.textContent = COPY.sending;
  try {
    const { data } = await api("/api/party/join", { method: "POST", body, timeout: 12000 });
    signedUp(data, data.guest_key);
  } catch (err) {
    sayError(err?.message || COPY.failed, err?.extra?.field);
  } finally {
    app.busy = false;
    els.send.disabled = false;
    els.send.textContent = COPY.send;
  }
});

// ── Share the group's link: the share sheet, else a text, else the clipboard
els.share.addEventListener("click", async () => {
  const code = app.view?.session.code;
  if (!code) return;
  const link = joinLink(location.origin, code);
  els.shareMsg.hidden = true;
  if (typeof navigator.share === "function") {
    try { await navigator.share({ text: `${COPY.shareMessage} ${code}`, url: link }); return; } catch (err) { if (err?.name === "AbortError") return; }
  }
  const href = smsHref(app.platform, `${COPY.shareMessage} ${link}`);
  if (href) { location.href = href; return; }
  try { await navigator.clipboard.writeText(link); els.shareMsg.textContent = COPY.copied; } catch { els.shareMsg.textContent = COPY.copyFailed; }
  els.shareMsg.hidden = false;
});

// ── Move: a friend's group, or a place of your own
async function moveTo(code) {
  if (app.busy || !app.key) return;
  app.busy = true;
  els.moveMsg.hidden = true;
  els.moveGo.disabled = true;
  els.leave.disabled = true;
  try {
    const { data } = await api("/api/party/move", { method: "POST", body: { guest_key: app.key, session_code: code }, timeout: 12000 });
    draw(data);
    els.moveCode.value = "";
  } catch (err) {
    els.moveMsg.textContent = err?.message || COPY.failed;
    els.moveMsg.hidden = false;
  } finally {
    app.busy = false;
    els.moveGo.disabled = false;
    els.leave.disabled = false;
  }
}
els.move.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const code = sessionCodeFrom(els.moveCode.value);
  if (code.length !== 4) { els.moveMsg.textContent = COPY.needCode; els.moveMsg.hidden = false; els.moveCode.focus(); return; }
  moveTo(code);
});
els.leave.addEventListener("click", () => moveTo(null));
els.forget.addEventListener("click", () => {
  clearTimeout(app.timer);
  dropKey();
  app.key = null;
  els.form.reset();
  els.codeRow.hidden = true;
  show("form");
  els.name.focus();
});
document.addEventListener("visibilitychange", () => { if (!document.hidden && app.key) refresh(); });

// ── On load: is the party on? Then either this phone's place, or the form (a shared link fills the code).
show("loading");
if (!(await festive())) {
  show("off");
} else {
  const group = groupFromSearch(location.search);
  if (group) { els.withGroup.checked = true; els.codeRow.hidden = false; els.code.value = group; }
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
