// The team's page (/team; Scooter, 17 Nov 2026, and his preview notes): sign in with an emailed
// code, then the line, live (every 5 s): who is next and after that, each group with its people,
// big status buttons (green "In the booth", red "Out of the booth", which moves the group to its own
// lane, "At the upload station", apart from whoever is in the booth now, until the engineer uploads
// its song against it) that always ask first and can be undone for 10 s, a
// "Text them" button that opens Messages on this phone with every number in the group, and each
// person's details on a tap. Buttons only, no gestures. Below: the contest songs (each with "Take
// out of the vote", asked first and undoable), the gallery's GIFs and who is on the team.
// The phone keeps the team token and the member's own email (localStorage tbz.team), nothing else.
import { ApiError, api } from "./api.js";
import { $, closeModal, h, showModal } from "./dom.js";
import { festive } from "./festive.js";
import { detectPlatform } from "./logic.js";
import { HOLIDAY } from "./party-copy.js";
import { LINE_POLL_MS, STATUS, TEAM_KEY, UNDO_MS, clockWords, groupLabel, groupSmsHref, isTeamToken, moves, nextTwo } from "./party-rules.js";
import { COPY } from "./team-copy.js";

const els = Object.fromEntries([
  "headline", "intro", "loading", "off", "off-title", "off-note", "signin", "signin-title", "signin-intro", "email-form", "email", "email-label", "send", "code-form", "code-sent", "code", "code-label", "check", "resend", "change", "signin-error",
  "board", "who", "signout", "next-label", "next", "after-label", "after", "line-note", "line", "upload-title", "upload-intro", "upload-none", "upload", "done-title", "done",
  "songs-title", "songs-intro", "songs-none", "songs",
  "gifs-title", "gifs-intro", "gifs-chosen-title", "gifs-chosen", "gifs-none", "gif-search", "gif-search-label", "gif-status", "gif-results", "gif-by",
  "members-title", "members-intro", "members", "add-form", "add", "add-label", "add-go", "add-msg",
  "person", "person-title", "person-list", "person-close", "confirm", "confirm-title", "confirm-yes", "confirm-no", "toast", "toast-text", "undo",
].map((id) => [id.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), $(`tbz-team-${id}`)]));

const app = { token: null, me: "", sessions: [], timer: null, pending: null, undo: null, undoTimer: null, resendTimer: null, platform: detectPlatform(navigator), gifs: [], gifTimer: null, songs: [], assignPick: {} };

// ── The words
document.title = `${COPY.headline} | Top Barz`;
const words = { headline: "headline", intro: "intro", offNote: null, signinTitle: "signInTitle", signinIntro: "signInIntro", emailLabel: "emailLabel", send: "sendCode", codeLabel: "codeLabel", check: "check", change: "changeEmail", signout: "signOut", nextLabel: "nextUp", afterLabel: "afterThat", doneTitle: "doneTitle", uploadTitle: "uploadTitle", uploadIntro: "uploadIntro", uploadNone: "uploadNone", songsTitle: "songsTitle", songsIntro: "songsIntro", songsNone: "songsNone", gifsTitle: "gifsTitle", gifsIntro: "gifsIntro", gifsChosenTitle: "gifsChosen", gifsNone: "gifsNone", gifSearchLabel: "gifsSearch", gifBy: "poweredBy", membersTitle: "teamTitle", membersIntro: "teamIntro", addLabel: "addLabel", addGo: "add", personClose: "close", confirmYes: "yes", confirmNo: "cancel", undo: "undo" };
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
    els.codeSent.textContent = COPY.codeSent.replace("{email}", email);
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

// ── The line
const sizeWords = (n) => (n === 1 ? COPY.onePerson : COPY.people.replace("{n}", String(n)));
const namesOf = (s) => groupLabel(s.guests.map((g) => g.first_name));
function personDetails(g, s) {
  els.personTitle.textContent = COPY.detailsTitle.replace("{name}", g.name);
  const row = (k, v, href) => [h("dt", { text: COPY[k] }), h("dd", {}, href ? h("a", { href, text: v }) : (v || COPY.none))];
  els.personList.replaceChildren(
    ...row("fName", g.name), ...row("fPhone", g.phone, `tel:${g.phone}`), ...row("fEmail", g.email, `mailto:${g.email}`), ...row("fCity", g.city),
    ...row("fInstagram", g.instagram, g.instagram ? `https://www.instagram.com/${encodeURIComponent(g.instagram.replace(/^@/, ""))}` : null),
    ...row("fGroup", `${namesOf(s)} · ${sizeWords(s.guests.length)}`), ...row("fJoined", clockWords(g.joined_at)),
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
// The button that moves a group from one lane to another, in words.
function moveWords(from, to) {
  if (to === "booth") return from === "upload" ? COPY.backToBooth : COPY.toBooth;
  if (to === "upload") return from === "done" ? COPY.backToUpload : COPY.toUpload;
  if (to === "done") return COPY.toDone;
  return COPY.toWaiting;
}
function card(s) {
  const tone = STATUS[s.status].tone;
  const note = h("p", { class: "switch-note", role: "status", hidden: true });
  const actions = h("div", { class: "line-actions" },
    ...moves(s.status).map((to) => h("button", { type: "button", class: `btn btn-status btn-${STATUS[to].tone}`, text: moveWords(s.status, to), onclick: () => ask(s, to) })),
    s.status === "waiting" || s.status === "booth" ? h("button", { type: "button", class: "btn btn-small btn-ghost", text: COPY.textThem, onclick: () => textThem(s, note) }) : null);
  const meta = [COPY.joined.replace("{time}", clockWords(s.created_at)), s.texted_at ? COPY.texted.replace("{time}", clockWords(s.texted_at)) : null].filter(Boolean).join(" · ");
  return h("li", { class: `line-item is-${tone}`, "data-status": s.status },
    h("div", { class: "line-head" },
      h("span", { class: `pill pill-${tone}`, text: STATUS[s.status].word }),
      h("span", { class: "line-size", text: `${s.place ? `#${s.place} · ` : ""}${sizeWords(s.guests.length)}` })),
    h("ul", { class: "line-people" }, ...s.guests.map((g) => h("li", {}, h("button", { type: "button", class: "person-btn", text: g.name, onclick: () => personDetails(g, s) })))),
    h("p", { class: "line-meta", text: meta }),
    actions, note);
}
function draw() {
  const live = app.sessions.filter((s) => s.status === "waiting" || s.status === "booth");
  const upload = app.sessions.filter((s) => s.status === "upload");
  const done = app.sessions.filter((s) => s.status === "done");
  const { next, after, inBooth } = nextTwo(app.sessions);
  els.nextLabel.textContent = inBooth.length ? COPY.inBooth : COPY.nextUp;
  const top = inBooth[0] ?? next;
  const second = inBooth.length ? next : after;
  els.afterLabel.textContent = inBooth.length ? COPY.nextUp : COPY.afterThat;
  els.next.textContent = top ? `${namesOf(top)} · ${top.guests.length}` : COPY.nobodyNext;
  els.after.textContent = second ? `${namesOf(second)} · ${second.guests.length}` : COPY.nobodyNext;
  els.line.replaceChildren(...live.map(card));
  els.upload.replaceChildren(...upload.map(card));
  els.uploadNone.hidden = upload.length > 0;
  els.done.replaceChildren(...done.map(card));
  els.doneTitle.hidden = done.length === 0;
  if (!app.sessions.length) { els.lineNote.textContent = COPY.empty; els.lineNote.hidden = false; }
  else els.lineNote.hidden = true; // loaded: no "Loading…", no stale "Could not reach"
}
async function poll() {
  clearTimeout(app.timer);
  if (!app.token) return;
  if (!document.hidden && !app.pending) {
    try {
      const [{ data }, songs] = await Promise.all([call("/api/party/team/line"), call("/api/party/team/songs")]);
      app.sessions = data.sessions ?? [];
      app.songs = songs.data?.songs ?? [];
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

// ── A status change: always asked first, then Undo for 10 s
function ask(s, to) {
  app.pending = { s, to };
  els.confirmTitle.textContent = COPY.confirm.replace("{names}", namesOf(s)).replace("{status}", STATUS[to].word);
  els.confirmYes.className = `btn btn-status btn-${STATUS[to].tone}`;
  showModal(els.confirm, cancel);
  els.confirmNo.focus();
}
function cancel() { app.pending = null; closeModal(els.confirm); }
// ── A contest song: "Take out of the vote" / "Put back", asked first, then Undo for 10 s
function songLine(s) {
  const entry = !s.ticked ? COPY.songNotEntered
    : s.people > 1 && !s.confirmed ? COPY.songNeedsGroup.replace("{ticked}", s.ticked_by || COPY.someone)
    : s.people > 1 ? COPY.songEnteredGroup.replace("{ticked}", s.ticked_by || COPY.someone).replace("{confirmed}", s.confirmed_by || COPY.someone)
    : COPY.songEntered.replace("{ticked}", s.ticked_by || COPY.someone);
  return s.pulled ? `${COPY.songPulledNote} ${entry}` : entry;
}
function drawSongs() {
  els.songsNone.hidden = app.songs.length > 0;
  els.songs.replaceChildren(...app.songs.map((s) => {
    const tone = s.pulled ? "stop" : s.entered ? "go" : "wait";
    return h("li", { class: `line-item is-${tone}` },
      h("div", { class: "line-head" },
        h("span", { class: `pill pill-${tone}`, text: s.pulled ? COPY.songPulled : s.entered ? COPY.inVote : COPY.notInVote }),
        h("span", { class: "line-size", text: s.code })),
      h("p", { class: "next-names", text: s.label }),
      h("p", { class: "line-meta", text: songLine(s) }),
      h("ul", { class: "song-people", "aria-label": COPY.songPeople }, ...(s.members ?? []).map((p) => songPerson(s, p))),
      s.needs_group ? assignRow(s) : null,
      h("div", { class: "line-actions" }, s.pulled
        ? h("button", { type: "button", class: "btn btn-small btn-ghost", text: COPY.putBack, onclick: () => askSong(s, false) })
        : h("button", { type: "button", class: "btn btn-status btn-stop", text: COPY.pullOut, onclick: () => askSong(s, true) })));
  }));
}
// A song with nobody on it: pick the group that recorded it from the groups whose song is not
// uploaded yet (the pick survives the 5 s redraw), then confirm.
function assignRow(song) {
  const groups = app.sessions.filter((g) => g.status !== "done");
  if (!groups.length) return h("p", { class: "line-meta", text: COPY.songNoGroupNone });
  const id = `tbz-assign-${song.code}`;
  const pick = app.assignPick[song.code] ?? "";
  const select = h("select", { id, onchange: (e) => { app.assignPick[song.code] = e.target.value; } },
    h("option", { value: "", text: COPY.assignPick, selected: pick === "" }),
    ...groups.map((g) => h("option", { value: String(g.id), text: `${namesOf(g)} · ${STATUS[g.status]?.word ?? g.status}`, selected: pick === String(g.id) })));
  return h("div", { class: "assign" },
    h("p", { class: "line-meta", text: COPY.songNoGroup }),
    h("label", { for: id, text: COPY.assignLabel }), select,
    h("button", { type: "button", class: "btn btn-small", text: COPY.assignGo, onclick: () => askAssign(song, groups.find((g) => String(g.id) === app.assignPick[song.code])) }));
}
function askAssign(song, group) {
  if (!group) { document.getElementById(`tbz-assign-${song.code}`)?.focus(); return; }
  app.pending = { song, group };
  els.confirmTitle.textContent = COPY.confirmAssign.replace("{names}", namesOf(group)).replace("{code}", song.code);
  els.confirmYes.className = "btn";
  showModal(els.confirm, cancel);
  els.confirmNo.focus();
}
async function assignGroup(song, group) {
  try {
    await call(`/api/party/team/songs/${song.code}/group`, { method: "POST", body: { session_id: group.id } });
    delete app.assignPick[song.code];
    els.toastText.textContent = COPY.assigned.replace("{names}", namesOf(group)).replace("{code}", song.code);
  } catch (err) {
    if (signedOut(err)) { signOut(); return; }
    els.toastText.textContent = err?.message || COPY.failed;
  }
  app.undo = null;
  els.undo.hidden = true;
  els.toast.hidden = false;
  clearTimeout(app.undoTimer);
  app.undoTimer = setTimeout(() => { els.toast.hidden = true; }, UNDO_MS);
  app.pending = null;
  poll();
}
// One person on a song: first name (or "Not signed up" with when they entered the code), their box,
// and Remove for anyone who has not ticked: a plus-one or a mistyped code would hold the song out.
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const personName = (p) => p.first_name || COPY.notSignedUp.replace("{time}", clock(p.attached_at));
function songPerson(song, p) {
  return h("li", { class: "song-person" },
    h("span", { text: `${personName(p)} · ${p.in ? COPY.personIn : p.signed_up ? COPY.personWaiting : COPY.personNoSignUp}` }),
    p.in ? null : h("button", { type: "button", class: "btn btn-small btn-ghost", text: COPY.removePerson, "aria-label": `${COPY.removePerson}: ${personName(p)}`, onclick: () => askRemove(song, p) }));
}
function askRemove(song, person) {
  app.pending = { song, person };
  els.confirmTitle.textContent = COPY.confirmRemovePerson.replace("{name}", person.first_name || personName(person).replace(/^\p{Lu}/u, (c) => c.toLowerCase())).replace("{label}", song.label);
  els.confirmYes.className = "btn btn-status btn-stop";
  showModal(els.confirm, cancel);
  els.confirmNo.focus();
}
async function removePerson(song, person) {
  try {
    await call(`/api/party/team/songs/${song.code}/people/${person.id}/remove`, { method: "POST", body: {} });
    els.toastText.textContent = COPY.removedPerson.replace("{name}", personName(person)).replace("{label}", song.label);
  } catch (err) {
    if (signedOut(err)) { signOut(); return; }
    els.toastText.textContent = err?.message || COPY.failed;
  }
  app.undo = null;
  els.undo.hidden = true;
  els.toast.hidden = false;
  clearTimeout(app.undoTimer);
  app.undoTimer = setTimeout(() => { els.toast.hidden = true; }, UNDO_MS);
  app.pending = null;
  poll();
}
function askSong(song, pulled) {
  app.pending = { song, pulled };
  els.confirmTitle.textContent = (pulled ? COPY.confirmPull : COPY.confirmPutBack).replace("{label}", song.label);
  els.confirmYes.className = `btn btn-status btn-${pulled ? "stop" : "go"}`;
  showModal(els.confirm, cancel);
  els.confirmNo.focus();
}
async function pullSong(song, pulled, { undoable }) {
  try {
    await call(`/api/party/team/songs/${song.code}/pull`, { method: "POST", body: { pulled } });
    clearTimeout(app.undoTimer);
    els.toastText.textContent = (pulled ? COPY.pulledDone : COPY.putBackDone).replace("{label}", song.label);
    app.undo = undoable ? { song, pulled: !pulled } : null;
    els.undo.hidden = !undoable;
    els.toast.hidden = false;
    app.undoTimer = setTimeout(() => { els.toast.hidden = true; app.undo = null; }, UNDO_MS);
  } catch (err) {
    if (signedOut(err)) { signOut(); return; }
    els.toastText.textContent = err?.message || COPY.failed;
    els.undo.hidden = true;
    els.toast.hidden = false;
    clearTimeout(app.undoTimer);
    app.undoTimer = setTimeout(() => { els.toast.hidden = true; }, UNDO_MS);
  }
  app.pending = null;
  poll();
}
async function change(s, from, to, { undoable }) {
  try {
    await call(`/api/party/team/sessions/${s.id}/status`, { method: "POST", body: { status: to, from } });
    s.status = to;
    if (undoable) {
      clearTimeout(app.undoTimer);
      app.undo = { s, from: to, to: from };
      els.toastText.textContent = COPY.moved.replace("{names}", namesOf(s)).replace("{status}", STATUS[to].word);
      els.undo.hidden = false;
      els.toast.hidden = false;
      app.undoTimer = setTimeout(() => { els.toast.hidden = true; app.undo = null; }, UNDO_MS);
    } else {
      els.toast.hidden = true;
      app.undo = null;
    }
  } catch (err) {
    if (signedOut(err)) { signOut(); return; }
    els.toastText.textContent = err?.code === "changed" ? COPY.changed : err?.message || COPY.failed;
    els.undo.hidden = true;
    els.toast.hidden = false;
    clearTimeout(app.undoTimer);
    app.undoTimer = setTimeout(() => { els.toast.hidden = true; }, UNDO_MS);
  }
  app.pending = null;
  poll();
}
els.confirmYes.addEventListener("click", () => {
  const p = app.pending;
  closeModal(els.confirm);
  if (p?.group) assignGroup(p.song, p.group);
  else if (p?.person) removePerson(p.song, p.person);
  else if (p?.song) pullSong(p.song, p.pulled, { undoable: true });
  else if (p) change(p.s, p.s.status, p.to, { undoable: true });
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
