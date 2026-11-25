// The engineer's page (/booth): drop or choose a finished file, watch it go up, read the 4-digit
// code out to the artist, next file. Under it, today's uploads (GET /api/booth/tracks). The
// upload is an XMLHttpRequest because fetch has no upload progress. While the holiday party is on,
// the page shows whose song the file goes to (the next recording at the upload station) before the
// drop, and the upload carries which one it showed. Each row says how many people
// entered its code ("3 people") and "all in" when every one of them opted in to the public vote:
// counts only, never a name or an address (the log route carries none). Nothing here is part of
// the vote, and nothing here is remembered on the device.
import { $, h } from "./dom.js";
import { COPY } from "./booth-copy.js";
import { askAboutHeld, formatSize, formatTime, openedWords, peopleWords, refuseFile, stationSig, todayRows, uploadFailure } from "./booth-rules.js";

const els = {
  headline: $("tbz-booth-headline"),
  intro: $("tbz-booth-intro"),
  zone: $("tbz-zone"),
  zoneText: $("tbz-zone-text"),
  zoneHint: $("tbz-zone-hint"),
  file: $("tbz-file"),
  progress: $("tbz-progress"),
  progressBar: $("tbz-progress-bar"),
  progressText: $("tbz-progress-text"),
  done: $("tbz-done"),
  doneTitle: $("tbz-done-title"),
  code: $("tbz-code"),
  doneFile: $("tbz-done-file"),
  next: $("tbz-next"),
  failed: $("tbz-failed"),
  failedText: $("tbz-failed-text"),
  retry: $("tbz-retry"),
  logTitle: $("tbz-log-title"),
  logNote: $("tbz-log-note"),
  logList: $("tbz-log-list"),
  groups: $("tbz-groups"),
  groupsTitle: $("tbz-groups-title"),
  groupsList: $("tbz-groups-list"),
  groupsFlags: $("tbz-groups-flags"),
  groupsStatus: $("tbz-groups-status"),
  groupsNote: $("tbz-groups-note"),
  walkup: $("tbz-walkup"),
  walkupText: $("tbz-walkup-text"),
  walkupPick: $("tbz-walkup-pick"),
  walkupGo: $("tbz-walkup-go"),
  held: $("tbz-held"),
  heldText: $("tbz-held-text"),
  heldForget: $("tbz-held-forget"),
};

// `held`: a file the engineer chose to keep back ("Wait for the names", "Not them", or a station that
// changed under them): { file, refused } where `refused` is the station they said no to (null: none).
const app = { busy: false, lastFile: null, station: null, asking: null, held: null, state: "ready" };

// ── The words (booth-copy.js)
document.title = `${COPY.headline} | Top Barz`;
els.headline.textContent = COPY.headline;
els.intro.textContent = COPY.intro;
els.zoneText.textContent = COPY.zone;
els.zoneHint.textContent = COPY.zoneHint;
els.doneTitle.textContent = COPY.doneTitle;
els.next.textContent = COPY.next;
els.retry.textContent = COPY.retry;
els.logTitle.textContent = COPY.logTitle;
els.groupsTitle.textContent = COPY.groupsTitle;
els.walkupText.textContent = COPY.walkUpConfirm;
els.walkupPick.textContent = COPY.walkUpPick;
els.walkupGo.textContent = COPY.walkUpGo;
els.heldForget.textContent = COPY.heldForget;

// ── The holiday party: whose song this is. The next recording at the upload station (the people the
// ambassador tapped in and out on /team), shown before the drop; the upload says which one it saw,
// and the server refuses it if the station changed since (never a song on people nobody saw).
function renderStation() {
  const st = app.station;
  const next = st?.next ?? null;
  els.groupsTitle.textContent = COPY.groupsTitle;
  els.groupsList.textContent = next ? next.names : "";
  els.groupsList.hidden = !next;
  const flagged = (next?.people ?? []).filter((p) => p.flags?.length);
  els.groupsFlags.replaceChildren(...flagged.map((p) => h("li", { class: "flag", text: COPY.flagged.replace("{name}", p.first_name).replace("{why}", p.flags.map((f) => (f === "test" ? COPY.flagTest : COPY.flagStale)).join(", ")) })));
  els.groupsFlags.hidden = flagged.length === 0;
  // The song being recorded now: its whole group, in the booth or already out.
  const rec = st?.recording ?? [];
  const recording = rec.length ? COPY.recordingNow.replace("{names}", rec.map((p) => `${p.first_name} (${p.in_booth ? COPY.inBooth : COPY.outOfBooth})`).join(", ")) : "";
  const status = next
    ? [st.queued ? COPY.queued.replace("{n}", String(st.queued)).replace("{s}", st.queued === 1 ? "" : "s") : "", recording].filter(Boolean).join(" ")
    : recording || (st?.in_booth?.length ? COPY.inBoothNow.replace("{names}", st.in_booth.join(", ")) : COPY.groupsNone);
  els.groupsStatus.textContent = status;
  els.groupsStatus.hidden = !status;
  els.groupsNote.textContent = COPY.groupsNote;
}
async function loadGroups() {
  try {
    const res = await fetch("/api/booth/sessions", { headers: { accept: "application/json" }, credentials: "same-origin" });
    const data = await res.json();
    els.groups.hidden = data?.on !== true;
    if (data?.on !== true) { app.station = null; return; }
    app.station = { next: data.next && Number.isInteger(data.next.id) && typeof data.next.key === "string" ? data.next : null, queued: Number(data.queued) || 0, in_booth: Array.isArray(data.in_booth) ? data.in_booth : [], recording: Array.isArray(data.recording) ? data.recording.filter((p) => typeof p?.first_name === "string") : [] };
    renderStation();
    askHeld();
  } catch {}
}
// A held file: the moment a recording is at the station (or its names changed since "Not them"),
// the page asks again. It never uploads by itself: only "Yes, it's them" sends it.
function askHeld() {
  const next = app.station?.next ?? null;
  if (askAboutHeld(app.held, next, { busy: app.busy, asking: app.state === "walkup" })) askFirst(app.held.file, { again: true });
}
function hold(file, refused = null, words = COPY.walkUpHeld) {
  app.held = { file, refused };
  els.heldText.textContent = words.replace("{file}", file.name);
  show("ready");
}

// ── States: ready (the zone), uploading (the bar), done (the code), failed (the line + retry) ──
function show(state) {
  els.zone.classList.toggle("is-busy", state === "uploading");
  els.file.disabled = state === "uploading";
  els.progress.hidden = state !== "uploading";
  els.done.hidden = state !== "done";
  els.failed.hidden = state !== "failed";
  els.walkup.hidden = state !== "walkup";
  app.state = state;
  els.held.hidden = !app.held || state === "walkup" || state === "uploading";
  if (state !== "uploading") { els.progressText.textContent = ""; setProgress(0); }
}
function setProgress(fraction) {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  els.progressBar.style.setProperty("--p", `${pct}%`);
  els.progress.setAttribute("aria-valuenow", String(pct));
}
function failed(text) {
  app.busy = false;
  els.failedText.textContent = text;
  show("failed");
  els.retry.focus();
}
function done({ code, file_name: name }) {
  app.busy = false;
  loadGroups(); // that recording is done: the station shows the next one
  app.lastFile = null;
  els.code.textContent = code;
  els.doneFile.textContent = name;
  show("done");
  els.code.focus({ preventScroll: true });
  loadLog();
}

// ── The upload
// While the party is on, nothing goes up before the engineer answers ON the page (never the
// browser's own pop-up, which is easy to miss): the names at the upload station, "Yes, it's them"
// or "Not them"; or, with nobody there, "Upload with nobody on it" or "Wait for the names". The
// upload carries the station's key as it was when they said yes, so a change since is refused.
function askFirst(file, { again = false } = {}) {
  const next = app.station.next;
  app.lastFile = file;
  app.asking = next ? { key: next.key, sig: stationSig(next) } : { key: "none", sig: "" };
  const lead = again ? `${COPY.heldAgain} ` : "";
  els.walkupText.textContent = next ? `${lead}${COPY.confirmGroup.replace("{file}", file.name).replace("{names}", next.names)} ${COPY.confirmGroupNote}` : COPY.walkUpConfirm;
  els.walkupGo.textContent = next ? COPY.confirmGroupGo : COPY.walkUpGo;
  els.walkupPick.textContent = next ? COPY.confirmGroupNo : COPY.walkUpPick;
  show("walkup");
  // Asked again by itself (a held file): shown and scrolled to, never a focused Yes a stray key could press.
  if (again) els.walkup.scrollIntoView({ behavior: "smooth", block: "center" });
  else (next ? els.walkupGo : els.walkupPick).focus();
}
function upload(file, { confirmed = null } = {}) {
  if (app.busy || !file) return;
  const why = refuseFile(file);
  if (why) { failed(why === "not_audio" ? COPY.notAudio : why === "too_big" ? COPY.tooBig : COPY.empty); return; }
  const party = Boolean(app.station);
  if (party && !confirmed) { askFirst(file); return; }
  app.held = null; // it is going up now, on the engineer's own answer
  app.busy = true;
  app.lastFile = file;
  show("uploading");
  els.progressText.textContent = COPY.uploading.replace("{name}", file.name);
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/booth/tracks");
  xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
  xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
  xhr.setRequestHeader("accept", "application/json");
  if (party) xhr.setRequestHeader("x-party-take", confirmed);
  xhr.responseType = "json";
  xhr.timeout = 10 * 60 * 1000;
  xhr.upload.addEventListener("progress", (ev) => { if (ev.lengthComputable) setProgress(ev.loaded / ev.total); });
  xhr.addEventListener("load", () => {
    const body = xhr.response && typeof xhr.response === "object" ? xhr.response : {};
    if (xhr.status === 200 && /^\d{4}$/.test(body.code ?? "") && typeof body.file_name === "string") done(body);
    else if (body.error === "take_changed") { app.busy = false; hold(file, null, COPY.sessionGone); loadGroups(); }
    else failed(uploadFailure(COPY, { code: body.error, status: xhr.status, message: body.message }));
  });
  xhr.addEventListener("error", () => failed(uploadFailure(COPY, {})));
  xhr.addEventListener("timeout", () => failed(uploadFailure(COPY, {})));
  xhr.addEventListener("abort", () => failed(uploadFailure(COPY, {})));
  xhr.send(file);
}

els.file.addEventListener("change", () => {
  const file = els.file.files?.[0];
  els.file.value = "";
  upload(file);
});
for (const type of ["dragenter", "dragover"]) {
  els.zone.addEventListener(type, (ev) => { ev.preventDefault(); if (!app.busy) els.zone.classList.add("is-over"); });
}
for (const type of ["dragleave", "dragend", "drop"]) {
  els.zone.addEventListener(type, () => els.zone.classList.remove("is-over"));
}
els.zone.addEventListener("drop", (ev) => {
  ev.preventDefault();
  upload(ev.dataTransfer?.files?.[0]);
});
// The question: "Not them" / "Wait for the names" HOLD the file here (nothing uploaded; the page asks
// again when the right names show), or go on.
els.walkupPick.addEventListener("click", () => {
  const file = app.lastFile;
  const notThem = app.asking?.key && app.asking.key !== "none";
  const refused = notThem ? app.asking.sig : null;
  app.asking = null;
  app.lastFile = null;
  if (file) hold(file, refused, notThem ? COPY.confirmGroupHeld : COPY.walkUpHeld);
  else show("ready");
  els.groups.scrollIntoView({ behavior: "smooth", block: "start" });
  loadGroups();
});
els.heldForget.addEventListener("click", () => { app.held = null; show("ready"); els.file.focus(); });
els.walkupGo.addEventListener("click", () => { const file = app.lastFile; const key = app.asking?.key ?? "none"; app.asking = null; app.lastFile = null; upload(file, { confirmed: key }); });
els.next.addEventListener("click", () => { show("ready"); els.file.focus(); });
els.retry.addEventListener("click", () => {
  if (app.lastFile) upload(app.lastFile);
  else { show("ready"); els.file.click(); }
});

// ── Today's log
function renderLog(rows) {
  els.logList.replaceChildren(...rows.map((r) => h("li", { class: r.art_url ? "has-art" : null },
    h("span", { class: "log-code", text: r.code }),
    r.art_url ? h("img", { class: "log-art", src: r.art_url, width: 40, height: 40, alt: "", loading: "lazy" }) : null,
    h("span", { class: "log-file", text: r.file_name }),
    h("span", { class: "log-meta", text: [formatTime(r.uploaded_at), formatSize(r.size), openedWords(r.opened), peopleWords(COPY, r.people), r.everyone_in ? COPY.allIn : "", r.public ? "public" : ""].filter(Boolean).join(" · ") }))));
  els.logNote.textContent = rows.length ? "" : COPY.logEmpty;
  els.logNote.hidden = rows.length > 0;
}
async function loadLog() {
  try {
    const res = await fetch("/api/booth/tracks", { headers: { accept: "application/json" }, credentials: "same-origin" });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || COPY.logFailed);
    renderLog(todayRows(data.tracks));
  } catch (err) {
    els.logNote.textContent = `${COPY.logFailed} ${err?.message ?? ""}`.trim();
    els.logNote.hidden = false;
  }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) { loadLog(); loadGroups(); } });

show("ready");
loadLog();
loadGroups();
setInterval(() => { if (!document.hidden && !app.busy) loadGroups(); }, 5000);
