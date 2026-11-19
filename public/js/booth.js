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
import { formatSize, formatTime, openedWords, peopleWords, refuseFile, todayRows, uploadFailure } from "./booth-rules.js";

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
};

const app = { busy: false, lastFile: null, station: null };

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
  const status = next
    ? (st.queued ? COPY.queued.replace("{n}", String(st.queued)).replace("{s}", st.queued === 1 ? "" : "s") : "")
    : st?.in_booth?.length ? COPY.inBoothNow.replace("{names}", st.in_booth.join(", ")) : COPY.groupsNone;
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
    app.station = { next: data.next && Number.isInteger(data.next.id) ? data.next : null, queued: Number(data.queued) || 0, in_booth: Array.isArray(data.in_booth) ? data.in_booth : [] };
    renderStation();
  } catch {}
}

// ── States: ready (the zone), uploading (the bar), done (the code), failed (the line + retry) ──
function show(state) {
  els.zone.classList.toggle("is-busy", state === "uploading");
  els.file.disabled = state === "uploading";
  els.progress.hidden = state !== "uploading";
  els.done.hidden = state !== "done";
  els.failed.hidden = state !== "failed";
  els.walkup.hidden = state !== "walkup";
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
function upload(file, { walkUpOk = false } = {}) {
  if (app.busy || !file) return;
  const why = refuseFile(file);
  if (why) { failed(why === "not_audio" ? COPY.notAudio : why === "too_big" ? COPY.tooBig : COPY.empty); return; }
  // While the party is on, a song with nobody at the upload station has nobody on it: asked first,
  // on the page (never the browser's own pop-up, which is easy to miss), never uploaded in silence.
  const party = Boolean(app.station);
  if (party && !app.station.next && !walkUpOk) { app.lastFile = file; show("walkup"); els.walkupPick.focus(); return; }
  app.busy = true;
  app.lastFile = file;
  show("uploading");
  els.progressText.textContent = COPY.uploading.replace("{name}", file.name);
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/booth/tracks");
  xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
  xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
  xhr.setRequestHeader("accept", "application/json");
  if (party) xhr.setRequestHeader("x-party-take", String(app.station.next?.id ?? "none"));
  xhr.responseType = "json";
  xhr.timeout = 10 * 60 * 1000;
  xhr.upload.addEventListener("progress", (ev) => { if (ev.lengthComputable) setProgress(ev.loaded / ev.total); });
  xhr.addEventListener("load", () => {
    const body = xhr.response && typeof xhr.response === "object" ? xhr.response : {};
    if (xhr.status === 200 && /^\d{4}$/.test(body.code ?? "") && typeof body.file_name === "string") done(body);
    else if (body.error === "take_changed") { failed(COPY.sessionGone); loadGroups(); }
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
// The walk-up question: wait for the names (nothing uploaded) or go on with nobody on it.
els.walkupPick.addEventListener("click", () => {
  show("ready");
  els.progressText.textContent = COPY.walkUpHeld;
  els.groups.scrollIntoView({ behavior: "smooth", block: "start" });
  loadGroups();
});
els.walkupGo.addEventListener("click", () => { const file = app.lastFile; app.lastFile = null; upload(file, { walkUpOk: true }); });
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
