// The team's page (/team; Scooter, 17 Nov 2026, and his revision list of 18 Nov): sign in with an
// emailed code, then the line, live (every 5 s): one card per person, who is next and after that,
// big status buttons (green "In the booth", red "Out of the booth") that always ask first and can be
// undone for 10 s, a "Text them" button that opens Messages on this phone, and each person's details
// on a tap. The people in the booth together are one recording; when the last of them is out it
// waits at the upload station, whole, and the engineer's next upload goes to exactly them. A sign-up
// that looks like a test or an old one is flagged, with its email and phone, before anyone taps it
// in. Buttons only, no gestures. Below: the songs (Take out of the vote, and Change who's on it,
// kept with a note), the gallery's GIFs and who is on the team.
// The phone keeps the team token and the member's own email (localStorage tbz.team), nothing else.
import { ApiError, api } from "./api.js";
import { $, closeModal, h, showModal } from "./dom.js";
import { festive } from "./festive.js";
import { detectPlatform } from "./logic.js";
import { HOLIDAY } from "./party-copy.js";
import { LINE_POLL_MS, STATUS, TEAM_KEY, UNDO_MS, clockWords, flagWords, groupLabel, groupSmsHref, isTeamToken, moves, nextTwo, recordings, songQuestion } from "./party-rules.js";
import { COPY } from "./team-copy.js";

const els = Object.fromEntries([
  "headline", "intro", "loading", "off", "off-title", "off-note", "signin", "signin-title", "signin-intro", "email-form", "email", "email-label", "send", "code-form", "code-sent", "code", "code-label", "check", "resend", "change", "signin-error",
  "board", "who", "signout", "next-label", "next", "after-label", "after", "line-note", "line", "waiting-title", "booth-title", "booth-intro", "booth-none", "booth", "upload-title", "upload-intro", "upload-none", "upload", "done-title", "done",
  "songs-title", "songs-intro", "songs-none", "songs",
  "gifs-title", "gifs-intro", "gifs-chosen-title", "gifs-chosen", "gifs-none", "gif-search", "gif-search-label", "gif-status", "gif-results", "gif-by",
  "members-title", "members-intro", "members", "add-form", "add", "add-label", "add-go", "add-msg",
  "person", "person-title", "person-list", "person-close", "confirm", "confirm-title", "confirm-note", "confirm-yes", "confirm-alt", "confirm-no", "toast", "toast-text", "undo",
  "repoint", "repoint-title", "repoint-intro", "repoint-find", "repoint-find-label", "repoint-list", "repoint-note", "repoint-note-label", "repoint-msg", "repoint-save", "repoint-cancel",
].map((id) => [id.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), $(`tbz-team-${id}`)]));

const app = { token: null, me: "", sessions: [], takes: [], timer: null, pending: null, undo: null, undoTimer: null, resendTimer: null, platform: detectPlatform(navigator), gifs: [], gifTimer: null, songs: [], guests: [], repoint: null };

// ── The words
document.title = `${COPY.headline} | Top Barz`;
const words = { headline: "headline", intro: "intro", offNote: null, signinTitle: "signInTitle", signinIntro: "signInIntro", emailLabel: "emailLabel", send: "sendCode", codeLabel: "codeLabel", check: "check", change: "changeEmail", signout: "signOut", nextLabel: "nextUp", afterLabel: "afterThat", doneTitle: "doneTitle", waitingTitle: "waitingTitle", boothTitle: "boothTitle", boothIntro: "boothIntro", boothNone: "boothNone", uploadTitle: "uploadTitle", uploadIntro: "uploadIntro", uploadNone: "uploadNone", repointIntro: "repointIntro", repointFindLabel: "repointFind", repointNoteLabel: "repointNote", repointSave: "repointSave", repointCancel: "cancel", songsTitle: "songsTitle", songsIntro: "songsIntro", songsNone: "songsNone", gifsTitle: "gifsTitle", gifsIntro: "gifsIntro", gifsChosenTitle: "gifsChosen", gifsNone: "gifsNone", gifSearchLabel: "gifsSearch", gifBy: "poweredBy", membersTitle: "teamTitle", membersIntro: "teamIntro", addLabel: "addLabel", addGo: "add", personClose: "close", confirmYes: "yes", confirmNo: "cancel", undo: "undo" };
for (const [el, key] of Object.entries(words)) if (key) els[el].textContent = COPY[key];
els.offTitle.textContent = HOLIDAY.off;
els.offNote.textContent = HOLIDAY.offNote;
els.loading.textContent = COPY.loading;

// ── The kept sign-in
function saved() {
  try { const v = JSON.parse(localStorage.getItem(TEAM_KEY) ?? "null"); return v && isTeamToken(v.token) ? v : null; } catch { return null; }
}
const keep = (token, me) => { try { localStorage.setItem(TEAM_KEY, JSON.stringify({ token, email: me })); } catch {} };
const forget = () => { try { localStorage.removeItem(TEAM_KEY); } catch {} };
const call = (path, opts = {}) => api(path, { token: app.token, timeout: 10000, ...opts });

function view(which) {
  els.loading.hidden = which !== "loading";
  els.off.hidden = which !== "off";
  els.signin.hidden = which !== "signin";
  els.board.hidden = which !== "board";
}
const sayIn = (text) => { els.signinError.textContent = text || ""; els.signinError.hidden = !text; };

// ── Sign-in: email → code → token
function resendCountdown(seconds) {
  clearInterval(app.resendTimer);
  let left = seconds;
  const tick = () => {
    els.resend.disabled = left > 0;
    els.resend.textContent = left > 0 ? COPY.newCodeIn.replace("{s}", String(left)) : COPY.newCode;
    left -= 1;
    if (left < -1) clearInterval(app.resendTimer);
  };
  tick();
  app.resendTimer = setInterval(tick, 1000);
}
async function sendCode() {
  const email = els.email.value.trim().toLowerCase();
  if (!email) { sayIn(COPY.needEmail); els.email.focus(); return; }
  sayIn("");
  els.send.disabled = true;
  els.send.textContent = COPY.sending;
  try {
    const { data } = await api("/api/party/team/code", { method: "POST", body: { email }, timeout: 12000 });
    app.me = email;
    // sent: false = a code went to this email under a minute ago and no new one was sent: say so,
    // never "We sent a code" for an email that did not go out.
    els.codeSent.textContent = (data?.sent === false ? COPY.codeAlreadySent : COPY.codeSent).replace("{email}", email);
    els.emailForm.hidden = true;
    els.codeForm.hidden = false;
    els.code.value = "";
    els.code.focus();
    resendCountdown(data?.resend_in_seconds ?? 60);
  } catch (err) {
    sayIn(err?.message);
  } finally {
    els.send.disabled = false;
    els.send.textContent = COPY.sendCode;
  }
}
els.emailForm.addEventListener("submit", (ev) => { ev.preventDefault(); sendCode(); });
els.resend.addEventListener("click", () => { els.email.value = app.me; sendCode(); });
els.change.addEventListener("click", () => { els.codeForm.hidden = true; els.emailForm.hidden = false; sayIn(""); els.email.focus(); });
els.code.addEventListener("input", () => { const d = els.code.value.replace(/\D/g, "").slice(0, 6); if (els.code.value !== d) els.code.value = d; if (d.length === 6) els.codeForm.requestSubmit(); });
els.codeForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const code = els.code.value.replace(/\D/g, "");
  if (code.length !== 6) { sayIn(COPY.needCode); els.code.focus(); return; }
  els.check.disabled = true;
  els.check.textContent = COPY.checking;
  try {
    const { data } = await api("/api/party/team/verify", { method: "POST", body: { email: app.me, code }, timeout: 12000 });
    app.token = data.token;
    app.me = data.member.email;
    keep(app.token, app.me);
    sayIn("");
    openBoard();
  } catch (err) {
    sayIn(err?.message);
    els.code.focus();
  } finally {
    els.check.disabled = false;
    els.check.textContent = COPY.check;
  }
});
function signOut() {
  clearTimeout(app.timer);
  forget();
  app.token = null;
  els.codeForm.hidden = true;
  els.emailForm.hidden = false;
  view("signin");
  els.email.focus();
}
els.signout.addEventListener("click", signOut);
// A token the server no longer takes (30 days passed, or taken off the team): back to sign-in.
const signedOut = (err) => err instanceof ApiError && (err.status === 401 || err.code === "team_sign_in");

// ── The line: one card per person; the booth and the upload station by recording (take)
const namesOf = (s) => groupLabel(s.guests.map((g) => g.first_name));
function personDetails(g, s) {
  els.personTitle.textContent = COPY.detailsTitle.replace("{name}", g.name);
  const row = (k, v, href) => [h("dt", { text: COPY[k] }), h("dd", {}, href ? h("a", { href, text: v }) : (v || COPY.none))];
  const why = flagWords(COPY, g.flags);
  els.personList.replaceChildren(
    ...row("fName", g.name), ...row("fPhone", g.phone, `tel:${g.phone}`), ...row("fEmail", g.email, `mailto:${g.email}`), ...row("fCity", g.city),
    ...row("fInstagram", g.instagram, g.instagram ? `https://www.instagram.com/${encodeURIComponent(g.instagram.replace(/^@/, ""))}` : null),
    ...row("fGroup", STATUS[s.status]?.word ?? s.status), ...row("fJoined", clockWords(g.joined_at)),
    ...(why ? row("fFlags", why) : []),
  );
  showModal(els.person, () => closeModal(els.person));
  els.personClose.focus();
}
els.personClose.addEventListener("click", () => closeModal(els.person));
function textThem(s, note) {
  const href = groupSmsHref(app.platform, s.guests.map((g) => g.phone), COPY.textMessage);
  call(`/api/party/team/sessions/${s.id}/texted`, { method: "POST", body: {} }).then(({ data }) => { s.texted_at = data.texted_at; draw(); }).catch(() => {});
  if (href) { location.href = href; return; }
  note.textContent = COPY.textNoPhone.replace("{numbers}", s.guests.map((g) => g.phone).join(", "));
  note.hidden = false;
}
// The button that moves a person from one lane to another, in words.
function moveWords(from, to) {
  if (to === "booth") return from === "upload" ? COPY.backToBooth : COPY.toBooth;
  if (to === "upload") return from === "done" ? COPY.backToUpload : COPY.toUpload;
  if (to === "done") return COPY.toDone;
  return COPY.toWaiting;
}
// A flag, with the contact details, so a test or old sign-up is seen before it is tapped in.
const flagLine = (g) => h("p", { class: "flag-note", text: `${flagWords(COPY, g.flags)}: ${g.email} · ${g.phone}` });
function card(s, { contact = false } = {}) {
  const tone = STATUS[s.status].tone;
  const note = h("p", { class: "switch-note", role: "status", hidden: true });
  const actions = h("div", { class: "line-actions" },
    ...moves(s.status).map((to) => h("button", { type: "button", class: `btn btn-status btn-${STATUS[to].tone}`, text: moveWords(s.status, to), onclick: () => ask(s, to) })),
    s.status === "waiting" || s.status === "booth" ? h("button", { type: "button", class: "btn btn-small btn-ghost", text: COPY.textThem, onclick: () => textThem(s, note) }) : null);
  const meta = [COPY.joined.replace("{time}", clockWords(s.created_at)), s.texted_at ? COPY.texted.replace("{time}", clockWords(s.texted_at)) : null].filter(Boolean).join(" · ");
  return h("li", { class: `line-item is-${tone}`, "data-status": s.status },
    h("div", { class: "line-head" },
      h("span", { class: `pill pill-${tone}`, text: s.status === "upload" && app.sessions.some((o) => o.status === "booth" && o.take_id && o.take_id === s.take_id) ? COPY.outWaiting : STATUS[s.status].word }),
      s.place ? h("span", { class: "line-size", text: `#${s.place}` }) : null),
    h("ul", { class: "line-people" }, ...s.guests.map((g) => h("li", {}, h("button", { type: "button", class: "person-btn", text: g.name, onclick: () => personDetails(g, s) })))),
    ...s.guests.filter((g) => contact || g.flags?.length).map((g) => (g.flags?.length ? flagLine(g) : h("p", { class: "line-meta", text: `${g.email} · ${g.phone}` }))),
    h("p", { class: "line-meta", text: meta }),
    actions, note);
}
// One recording: its people, each with their own buttons.
function takeCard(take, people, { title, contact, open = false }) {
  return h("li", { class: "take" },
    h("p", { class: "next-label", text: title }),
    h("p", { class: "next-names", text: groupLabel(people.flatMap((s) => s.guests.map((g) => g.first_name))) }),
    open ? h("p", { class: "line-meta", text: COPY.stillOpen }) : null,
    h("ol", { class: "line" }, ...people.map((s) => card(s, { contact }))));
}
function draw() {
  const waiting = app.sessions.filter((s) => s.status === "waiting");
  const done = app.sessions.filter((s) => s.status === "done");
  // The booth: the recording someone is in the booth for, with anyone of it already out. The upload
  // station: every recording nobody is in the booth for, the oldest first.
  const recs = recordings(app.takes, app.sessions);
  const now = recs.filter((r) => r.inBooth);
  const station = recs.filter((r) => !r.inBooth);
  const onRec = new Set(recs.flatMap((r) => r.people.map((s) => s.id)));
  // In the booth or out with no recording (from before 18 Nov 2026): shown on their own.
  const loneBooth = app.sessions.filter((s) => s.status === "booth" && !onRec.has(s.id));
  const loose = app.sessions.filter((s) => s.status === "upload" && !onRec.has(s.id));
  const { next, after, inBooth } = nextTwo(app.sessions);
  els.nextLabel.textContent = inBooth.length ? COPY.inBooth : COPY.nextUp;
  const nameOf = (s) => (s ? namesOf(s) : COPY.nobodyNext);
  els.next.textContent = inBooth.length ? groupLabel(inBooth.map((s) => namesOf(s))) : nameOf(next);
  els.afterLabel.textContent = inBooth.length ? COPY.nextUp : COPY.afterThat;
  els.after.textContent = inBooth.length ? nameOf(next) : nameOf(after);
  els.booth.replaceChildren(...now.map((r) => takeCard(r.t, r.people, { title: COPY.boothTitle, contact: false })), ...loneBooth.map((s) => card(s)));
  els.boothNone.hidden = now.length + loneBooth.length > 0;
  els.line.replaceChildren(...waiting.map((s) => card(s)));
  els.waitingTitle.hidden = waiting.length === 0;
  els.upload.replaceChildren(
    ...station.map((x, i) => takeCard(x.t, x.people, { title: i === 0 ? COPY.nextUpload : COPY.laterUpload, contact: true, open: !x.t.closed })),
    ...loose.map((s) => card(s, { contact: true })));
  els.uploadNone.hidden = station.length + loose.length > 0;
  els.done.replaceChildren(...done.map((s) => card(s)));
  els.doneTitle.hidden = done.length === 0;
  if (!app.sessions.length) { els.lineNote.textContent = COPY.empty; els.lineNote.hidden = false; }
  else els.lineNote.hidden = true; // loaded: no "Loading…", no stale "Could not reach"
}
async function poll() {
  clearTimeout(app.timer);
  if (!app.token) return;
  if (!document.hidden && !app.pending && !app.repoint) {
    try {
      const [{ data }, songs] = await Promise.all([call("/api/party/team/line"), call("/api/party/team/songs")]);
      app.sessions = data.sessions ?? [];
      app.takes = data.takes ?? [];
      app.songs = songs.data?.songs ?? [];
      app.guests = songs.data?.guests ?? [];
      drawSongs();
      if (els.lineNote.textContent === COPY.unreachable) els.lineNote.hidden = true;
      draw();
    } catch (err) {
      if (signedOut(err)) { signOut(); return; }
      els.lineNote.textContent = COPY.unreachable;
      els.lineNote.hidden = false;
    }
  }
  app.timer = setTimeout(poll, LINE_POLL_MS);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && app.token) poll(); });

// ── A status change: always asked first (with any flag and its contact details), then Undo for 10 s.
// Into the booth while the last recording waits on its upload with nobody in the booth, the question
// is which song: the same one (a group recording one verse at a time) or a new one. `names` is that
// recording's first names (from the line, or from the server's 409 which_song).
function ask(s, to, names = to === "booth" && s.status === "waiting" ? songQuestion(app.takes, app.sessions) : "") {
  app.pending = { s, to, song: null };
  const flagged = to === "booth" ? s.guests.filter((g) => g.flags?.length) : [];
  const flagText = flagged.map((g) => COPY.confirmFlagged.replace("{name}", g.name).replace("{email}", g.email).replace("{phone}", g.phone).replace("{why}", flagWords(COPY, g.flags))).join(" ");
  const fill = (t) => t.replace(/\{name\}/g, namesOf(s)).replace(/\{names\}/g, names);
  els.confirmTitle.textContent = names ? fill(COPY.whichSong) : COPY.confirm.replace("{names}", namesOf(s)).replace("{status}", STATUS[to].word);
  els.confirmNote.textContent = [names ? fill(COPY.whichSongNote) : "", flagText].filter(Boolean).join(" ");
  els.confirmNote.hidden = !els.confirmNote.textContent;
  els.confirmYes.textContent = names ? COPY.sameSong : COPY.yes;
  els.confirmYes.className = `btn btn-status btn-${STATUS[to].tone}`;
  els.confirmAlt.textContent = COPY.newSong;
  els.confirmAlt.hidden = !names;
  app.pending.asked = Boolean(names);
  showModal(els.confirm, cancel);
  els.confirmNo.focus();
}
function cancel() { app.pending = null; closeModal(els.confirm); }
function toast(text, undo = null) {
  clearTimeout(app.undoTimer);
  els.toastText.textContent = text;
  app.undo = undo;
  els.undo.hidden = !undo;
  els.toast.hidden = false;
  app.undoTimer = setTimeout(() => { els.toast.hidden = true; app.undo = null; }, UNDO_MS);
}

// ── The songs: "Take out of the vote" / "Put back", and "Change who's on it"
function songLine(s) {
  const ch = s.changed;
  const entry = ch ? (ch.action === "entered" ? COPY.songChangedIn : COPY.songChangedOut).replace("{name}", ch.by || COPY.someone).replace("{time}", clockWords(ch.at))
    : s.ticked ? COPY.songEntered.replace("{ticked}", s.ticked_by || COPY.someone) : COPY.songNotEntered;
  return [s.pulled ? COPY.songPulledNote : null, entry].filter(Boolean).join(" ");
}
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const firstNames = (names) => groupLabel(names.map((n) => String(n).split(" ")[0])) || COPY.nobodyOn;
function drawSongs() {
  els.songsNone.hidden = app.songs.length > 0;
  els.songs.replaceChildren(...app.songs.map((s) => {
    const tone = s.pulled ? "stop" : s.entered ? "go" : "wait";
    const on = (s.members ?? []).map((p) => p.first_name || COPY.notSignedUp);
    return h("li", { class: `line-item is-${tone}` },
      h("div", { class: "line-head" },
        h("span", { class: `pill pill-${tone}`, text: s.pulled ? COPY.songPulled : s.entered ? COPY.inVote : COPY.notInVote }),
        h("span", { class: "line-size", text: s.code })),
      h("p", { class: "next-names", text: s.label }),
      h("p", { class: "line-meta", text: s.needs_people ? COPY.songNobody : COPY.songOn.replace("{names}", groupLabel(on)) }),
      h("p", { class: "line-meta", text: songLine(s) }),
      ...(s.repoints ?? []).map((r) => h("p", { class: "line-meta repoint-log", text: [COPY.repointLog.replace("{time}", clock(r.at)).replace("{by}", r.by || COPY.someone).replace("{before}", firstNames(r.before)).replace("{after}", firstNames(r.after)), r.note ? COPY.repointLogNote.replace("{note}", r.note) : null].filter(Boolean).join(" ") })),
      h("div", { class: "line-actions" },
        h("button", { type: "button", class: "btn btn-small", text: COPY.repoint, onclick: () => openRepoint(s) }),
        s.pulled
          ? h("button", { type: "button", class: "btn btn-small btn-ghost", text: COPY.putBack, onclick: () => askSong(s, false) })
          : s.entered ? h("button", { type: "button", class: "btn btn-status btn-stop", text: COPY.pullOut, onclick: () => askSong(s, true) }) : null));
  }));
}
// "Change who's on it": every sign-up, newest first, with email, phone and any flag; ticked are the
// song's people now. Saving asks nothing more (the dialog is the question) and is kept with a note.
function openRepoint(song) {
  const picked = new Set((song.members ?? []).map((m) => m.guest_id).filter(Boolean));
  app.repoint = { song, picked };
  els.repointTitle.textContent = COPY.repointTitle.replace("{code}", song.code);
  els.repointFind.value = "";
  els.repointNote.value = "";
  els.repointMsg.hidden = true;
  drawRepoint();
  showModal(els.repoint, closeRepoint);
  els.repointFind.focus();
}
function closeRepoint() { app.repoint = null; closeModal(els.repoint); }
function drawRepoint() {
  const r = app.repoint;
  if (!r) return;
  const q = els.repointFind.value.trim().toLowerCase();
  const list = app.guests.filter((g) => r.picked.has(g.id) || !q || `${g.name} ${g.email} ${g.phone}`.toLowerCase().includes(q));
  els.repointList.replaceChildren(...(list.length ? list.map((g) => {
    const id = `tbz-repoint-${g.id}`;
    const why = flagWords(COPY, g.flags);
    return h("li", { class: "check" },
      h("input", { type: "checkbox", id, checked: r.picked.has(g.id), onchange: (e) => { if (e.target.checked) r.picked.add(g.id); else r.picked.delete(g.id); } }),
      h("label", { for: id }, h("span", { text: g.name }), h("span", { class: "line-meta", text: ` ${g.email} · ${g.phone}` }), why ? h("span", { class: "flag-note", text: ` ${why}` }) : null));
  }) : [h("li", { class: "line-meta", text: COPY.repointNoneFound })]));
}
els.repointFind.addEventListener("input", drawRepoint);
els.repointCancel.addEventListener("click", closeRepoint);
els.repointSave.addEventListener("click", async () => {
  const r = app.repoint;
  if (!r) return;
  els.repointSave.disabled = true;
  try {
    const { data } = await call(`/api/party/team/songs/${r.song.code}/people`, { method: "POST", body: { guest_ids: [...r.picked], note: els.repointNote.value } });
    closeRepoint();
    toast(COPY.repointDone.replace("{code}", r.song.code).replace("{names}", groupLabel((data.song?.members ?? []).map((m) => m.first_name).filter(Boolean)) || COPY.nobodyOn));
    poll();
  } catch (err) {
    if (signedOut(err)) { closeRepoint(); signOut(); return; }
    els.repointMsg.textContent = err?.message || COPY.failed;
    els.repointMsg.hidden = false;
  } finally {
    els.repointSave.disabled = false;
  }
});
function askSong(song, pulled) {
  app.pending = { song, pulled };
  els.confirmTitle.textContent = (pulled ? COPY.confirmPull : COPY.confirmPutBack).replace("{label}", song.label);
  els.confirmNote.hidden = true;
  els.confirmYes.textContent = COPY.yes;
  els.confirmAlt.hidden = true;
  els.confirmYes.className = `btn btn-status btn-${pulled ? "stop" : "go"}`;
  showModal(els.confirm, cancel);
  els.confirmNo.focus();
}
async function pullSong(song, pulled, { undoable }) {
  try {
    await call(`/api/party/team/songs/${song.code}/pull`, { method: "POST", body: { pulled } });
    toast((pulled ? COPY.pulledDone : COPY.putBackDone).replace("{label}", song.label), undoable ? { song, pulled: !pulled } : null);
  } catch (err) {
    if (signedOut(err)) { signOut(); return; }
    toast(err?.message || COPY.failed);
  }
  app.pending = null;
  poll();
}
async function change(s, from, to, { undoable, song = null }) {
  try {
    await call(`/api/party/team/sessions/${s.id}/status`, { method: "POST", body: { status: to, from, ...(song ? { song } : {}) } });
    s.status = to;
    if (undoable) toast(COPY.moved.replace("{names}", namesOf(s)).replace("{status}", STATUS[to].word), { s, from: to, to: from });
    else { els.toast.hidden = true; app.undo = null; }
  } catch (err) {
    if (signedOut(err)) { signOut(); return; }
    // The line moved on since this phone looked (another phone tapped someone out): ask which song now.
    if (err?.code === "which_song" && typeof err.extra?.names === "string") { app.pending = null; ask(s, to, err.extra.names); return; }
    toast(err?.code === "changed" ? COPY.changed : err?.message || COPY.failed);
  }
  app.pending = null;
  poll();
}
els.confirmYes.addEventListener("click", () => {
  const p = app.pending;
  closeModal(els.confirm);
  if (p?.song) pullSong(p.song, p.pulled, { undoable: true });
  else if (p) change(p.s, p.s.status, p.to, { undoable: true, song: p.asked ? "same" : null });
});
els.confirmAlt.addEventListener("click", () => {
  const p = app.pending;
  closeModal(els.confirm);
  if (p?.s) change(p.s, p.s.status, p.to, { undoable: true, song: "new" });
});
els.confirmNo.addEventListener("click", cancel);
els.undo.addEventListener("click", () => {
  const u = app.undo;
  if (u?.song) pullSong(u.song, u.pulled, { undoable: false });
  else if (u) change(u.s, u.from, u.to, { undoable: false });
});

// ── Gallery GIFs
function gifTile(g, onclick, label) {
  return h("li", {}, h("button", { type: "button", class: "gif", "aria-label": `${label}: ${g.title || "GIF"}`, onclick }, h("img", { src: g.preview_url || g.url, alt: "", width: g.preview_width || g.width || null, height: g.preview_height || g.height || null, loading: "lazy" })));
}
function drawGifs() {
  els.gifsChosen.replaceChildren(...app.gifs.map((g) => gifTile(g, () => setGif(g, false), COPY.remove)));
  els.gifsNone.hidden = app.gifs.length > 0;
}
async function setGif(g, add) {
  try {
    const { data } = add
      ? await call("/api/party/team/gifs", { method: "POST", body: { id: g.id, url: g.url, width: g.width, height: g.height, title: g.title } })
      : await call(`/api/party/team/gifs/${encodeURIComponent(g.id)}/remove`, { method: "POST", body: {} });
    app.gifs = data.gifs ?? [];
    drawGifs();
  } catch (err) {
    els.gifStatus.textContent = err?.message || COPY.failed;
  }
}
async function searchGifs() {
  const q = els.gifSearch.value.trim();
  try {
    const { data } = await api(q.length >= 2 ? `/api/giphy/search?q=${encodeURIComponent(q)}` : "/api/giphy/trending", { timeout: 10000 });
    if (data?.available === false) { els.gifStatus.textContent = COPY.gifsOff; els.gifResults.replaceChildren(); return; }
    els.gifStatus.textContent = data?.limited ? COPY.gifsBusy : "";
    els.gifResults.replaceChildren(...(data?.results ?? []).map((g) => gifTile(g, () => setGif(g, true), COPY.add)));
  } catch (err) {
    els.gifStatus.textContent = err?.message || COPY.gifsBusy;
  }
}
els.gifSearch.addEventListener("input", () => { clearTimeout(app.gifTimer); app.gifTimer = setTimeout(searchGifs, 450); });

// ── The team list
function drawMembers(members) {
  els.members.replaceChildren(...members.map((m) => h("li", { class: "member-row" },
    h("span", { class: "log-file", text: m.you ? `${m.email} (${COPY.you})` : m.email }),
    m.you ? null : h("button", { type: "button", class: "btn btn-small btn-ghost", text: COPY.remove, onclick: async () => { try { drawMembers((await call(`/api/party/team/members/${m.id}/remove`, { method: "POST", body: {} })).data.members); } catch (err) { els.addMsg.textContent = err?.message; els.addMsg.hidden = false; } } }))));
}
els.addForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  els.addMsg.hidden = true;
  try {
    drawMembers((await call("/api/party/team/members", { method: "POST", body: { email: els.add.value.trim() } })).data.members);
    els.add.value = "";
  } catch (err) {
    els.addMsg.textContent = err?.message || COPY.failed;
    els.addMsg.hidden = false;
  }
});

// ── Open the board
async function openBoard() {
  view("board");
  els.who.textContent = COPY.signedInAs.replace("{email}", app.me);
  els.lineNote.textContent = COPY.loading;
  els.lineNote.hidden = false;
  poll();
  call("/api/party/team/members").then(({ data }) => drawMembers(data.members)).catch(() => {});
  call("/api/party/team/gifs").then(({ data }) => { app.gifs = data.gifs ?? []; drawGifs(); }).catch(() => {});
  searchGifs();
}

view("loading");
if (!(await festive())) {
  view("off");
} else {
  const kept = saved();
  if (kept) { app.token = kept.token; app.me = kept.email ?? ""; openBoard(); } else { view("signin"); }
}
