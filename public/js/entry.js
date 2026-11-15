// The contest entry page (/entry): the thank-you, the contest, and the opt-in form with the track
// upload. The track goes up first (an XMLHttpRequest, because fetch has no upload progress) and
// comes back with a one-time upload id; the fields and that id then go as one JSON request. If the
// second step fails the upload is kept, so "Try again" does not send the file twice, and nothing
// typed is ever cleared. Nothing is kept on the device, and the done screen shows the entry number
// and no personal data. The server checks everything again (functions/_lib/entries.js).
import { $, h } from "./dom.js";
import { refuseFile } from "./booth-rules.js";
import { COPY } from "./entry-copy.js";
import { MAX_MEMBERS, checkEntry, entryBody, failureWords } from "./entry-rules.js";

const els = {
  headline: $("tbz-entry-headline"),
  thanks: $("tbz-entry-thanks"),
  contestTitle: $("tbz-entry-contest-title"),
  contest: $("tbz-entry-contest"),
  form: $("tbz-entry-form"),
  formTitle: $("tbz-entry-form-title"),
  first: $("tbz-entry-first"),
  firstLabel: $("tbz-entry-first-label"),
  last: $("tbz-entry-last"),
  lastLabel: $("tbz-entry-last-label"),
  city: $("tbz-entry-city"),
  cityLabel: $("tbz-entry-city-label"),
  email: $("tbz-entry-email"),
  emailLabel: $("tbz-entry-email-label"),
  phone: $("tbz-entry-phone"),
  phoneLabel: $("tbz-entry-phone-label"),
  instagram: $("tbz-entry-instagram"),
  instagramLabel: $("tbz-entry-instagram-label"),
  title: $("tbz-entry-title"),
  titleLabel: $("tbz-entry-title-label"),
  eligibility: $("tbz-entry-eligibility"),
  prizeTitle: $("tbz-entry-prize-title"),
  prize: $("tbz-entry-prize"),
  faqTitle: $("tbz-entry-faq-title"),
  faq: $("tbz-entry-faq"),
  group: $("tbz-entry-group"),
  groupLabel: $("tbz-entry-group-label"),
  groupYes: $("tbz-entry-group-yes"),
  groupNo: $("tbz-entry-group-no"),
  yesLabel: $("tbz-entry-yes-label"),
  noLabel: $("tbz-entry-no-label"),
  members: $("tbz-entry-members"),
  membersTitle: $("tbz-entry-members-title"),
  membersHint: $("tbz-entry-members-hint"),
  membersList: $("tbz-entry-members-list"),
  add: $("tbz-entry-add"),
  zone: $("tbz-entry-zone"),
  zoneText: $("tbz-entry-zone-text"),
  zoneHint: $("tbz-entry-zone-hint"),
  file: $("tbz-entry-file"),
  progress: $("tbz-entry-progress"),
  progressBar: $("tbz-entry-progress-bar"),
  progressText: $("tbz-entry-progress-text"),
  agree: $("tbz-entry-agree"),
  agreeLabel: $("tbz-entry-agree-label"),
  website: $("tbz-entry-website"),
  error: $("tbz-entry-error"),
  failed: $("tbz-entry-failed"),
  failedText: $("tbz-entry-failed-text"),
  retry: $("tbz-entry-retry"),
  submit: $("tbz-entry-submit"),
  done: $("tbz-entry-done"),
  doneTitle: $("tbz-entry-done-title"),
  doneText: $("tbz-entry-done-text"),
};

// file: the chosen File; uploaded: { file, id } once that file is up; rows: the group members' inputs.
const app = { busy: false, file: null, uploaded: null, rows: [], made: 0 };

// ── The words (entry-copy.js)
const paragraphs = (box, lines) => box.replaceChildren(...lines.map((text) => h("p", { class: "lede", text })));
document.title = `${COPY.formTitle} | Top Barz`;
els.headline.textContent = COPY.headline;
paragraphs(els.thanks, COPY.thanks);
els.contestTitle.textContent = COPY.contestTitle;
paragraphs(els.contest, COPY.contest);
els.prizeTitle.textContent = COPY.prizeTitle;
const prize = COPY.prize;
els.prize.replaceChildren(h("p", { class: "lede" }, prize.before,
  h("a", { href: prize.studio.href, target: "_blank", rel: "noopener noreferrer", text: prize.studio.text }),
  prize.middle, h("a", { href: `mailto:${prize.email}`, text: prize.email }), prize.after));
els.eligibility.textContent = COPY.eligibility;
els.instagramLabel.textContent = COPY.instagram;
els.titleLabel.textContent = COPY.trackTitle;
els.faqTitle.textContent = COPY.faqTitle;
els.faq.replaceChildren(...COPY.faq.map((item) => h("details", { class: "faq-item" },
  h("summary", { text: item.q }),
  h("p", { text: item.a }),
  ...(item.link ? [h("p", {}, h("a", { href: item.link.href, target: "_blank", rel: "noopener noreferrer", text: item.link.text }))] : []),
)));
els.formTitle.textContent = COPY.formTitle;
els.firstLabel.textContent = COPY.firstName;
els.lastLabel.textContent = COPY.lastName;
els.cityLabel.textContent = COPY.city;
els.emailLabel.textContent = COPY.email;
els.phoneLabel.textContent = COPY.phone;
els.groupLabel.textContent = COPY.groupLabel;
els.yesLabel.textContent = COPY.yes;
els.noLabel.textContent = COPY.no;
els.membersTitle.textContent = COPY.groupTitle;
els.membersHint.textContent = COPY.groupHint;
els.add.textContent = COPY.add;
els.zoneText.textContent = COPY.zone;
els.zoneHint.textContent = COPY.zoneHint;
els.agreeLabel.replaceChildren(COPY.agree.before, h("a", { href: COPY.agree.href, target: "_blank", rel: "noopener noreferrer", text: COPY.agree.link }), COPY.agree.after);
els.submit.textContent = COPY.submit;
els.retry.textContent = COPY.retry;

// ── Group members: one row each (first name, last name, email), added and removed by hand
function addRow() {
  if (app.rows.length >= MAX_MEMBERS) return;
  const made = ++app.made; // ids never repeat, even after a row is removed
  const field = (key, label, attrs) => {
    const id = `tbz-member-${made}-${key}`;
    const input = h("input", { id, type: "text", maxlength: 80, "aria-describedby": "tbz-entry-error", ...attrs });
    return { input, el: h("div", { class: "field" }, h("label", { for: id, text: label }), input) };
  };
  const first = field("first", COPY.firstName, { autocomplete: "off" });
  const last = field("last", COPY.lastName, { autocomplete: "off" });
  const email = field("email", COPY.email, { type: "email", inputmode: "email", autocomplete: "off", autocapitalize: "off", spellcheck: "false", maxlength: 254 });
  const remove = h("button", { type: "button", class: "btn btn-small btn-ghost", text: COPY.remove });
  const title = h("h4", { class: "zone-hint", text: COPY.memberTitle.replace("{n}", String(app.rows.length + 1)) });
  const row = { first: first.input, last: last.input, email: email.input, el: h("div", { class: "member" }, title, h("div", { class: "field-pair" }, first.el, last.el), email.el, remove), title, remove };
  remove.addEventListener("click", () => {
    app.rows.splice(app.rows.indexOf(row), 1);
    row.el.remove();
    renumber();
    (app.rows[app.rows.length - 1]?.first ?? els.add).focus();
  });
  app.rows.push(row);
  els.membersList.append(row.el);
  renumber();
  return row;
}
function renumber() {
  app.rows.forEach((row, i) => {
    row.title.textContent = COPY.memberTitle.replace("{n}", String(i + 1));
    row.remove.hidden = app.rows.length === 1;
  });
  els.add.hidden = app.rows.length >= MAX_MEMBERS;
}
function inGroup() {
  return els.groupYes.checked ? true : els.groupNo.checked ? false : null;
}
function syncGroup() {
  const yes = inGroup() === true;
  els.members.hidden = !yes;
  if (yes && app.rows.length === 0) addRow();
}

// ── States: the form always stays on the page (nothing typed is cleared); done replaces it
function setError(text, field) {
  els.error.textContent = text;
  els.error.hidden = !text;
  for (const el of [els.first, els.last, els.city, els.email, els.phone, els.agree]) el.removeAttribute("aria-invalid");
  for (const row of app.rows) for (const el of [row.first, row.last, row.email]) el.removeAttribute("aria-invalid");
  if (!field) return;
  const target = {
    first_name: els.first, last_name: els.last, city: els.city, email: els.email, phone: els.phone, in_group: els.groupYes,
    members: app.rows[0]?.first ?? els.add, track: els.file, agree: els.agree,
  }[field.replace(/\.\d+$/, "")];
  const index = /^members\.(\d+)$/.exec(field)?.[1];
  const focus = index !== undefined ? (app.rows[Number(index)]?.first ?? target) : target;
  focus?.setAttribute("aria-invalid", "true");
  focus?.focus();
}
function setProgress(fraction) {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  els.progressBar.style.setProperty("--p", `${pct}%`);
  els.progress.setAttribute("aria-valuenow", String(pct));
}
function setBusy(busy, text = "") {
  app.busy = busy;
  els.submit.disabled = busy || !els.agree.checked;
  els.file.disabled = busy;
  els.zone.classList.toggle("is-busy", busy);
  els.progress.hidden = !busy;
  els.progressText.textContent = busy ? text : "";
  if (!busy) setProgress(0);
}
function failed(text) {
  setBusy(false);
  els.failedText.textContent = text;
  els.failed.hidden = false;
  els.retry.focus();
}

// ── The track
function chooseFile(file) {
  if (!file) return;
  const why = refuseFile(file);
  if (why) { app.file = null; els.zoneText.textContent = COPY.zone; setError(why === "not_audio" ? COPY.notAudio : why === "too_big" ? COPY.tooBig : COPY.empty, "track"); return; }
  app.file = file;
  els.zoneText.textContent = COPY.zoneChosen.replace("{name}", file.name);
  setError("");
}
function upload(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/entries/upload");
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.setRequestHeader("accept", "application/json");
    xhr.responseType = "json";
    xhr.timeout = 10 * 60 * 1000;
    xhr.upload.addEventListener("progress", (ev) => { if (ev.lengthComputable) setProgress(ev.loaded / ev.total); });
    xhr.addEventListener("load", () => {
      const body = xhr.response && typeof xhr.response === "object" ? xhr.response : {};
      if (xhr.status === 200 && typeof body.upload_id === "string") resolve(body.upload_id);
      else reject({ code: body.error, status: xhr.status, message: body.message });
    });
    for (const type of ["error", "timeout", "abort"]) xhr.addEventListener(type, () => reject({}));
    xhr.send(file);
  });
}

// ── Send: validate, upload the track (once per file), then the fields
function values() {
  return {
    first_name: els.first.value, last_name: els.last.value, city: els.city.value, email: els.email.value, phone: els.phone.value, instagram: els.instagram.value, track_title: els.title.value,
    in_group: inGroup(), members: app.rows.map((r) => ({ first_name: r.first.value, last_name: r.last.value, email: r.email.value })),
    agree: els.agree.checked, file: app.file,
  };
}
async function send() {
  if (app.busy) return;
  els.failed.hidden = true;
  const v = values();
  const problem = checkEntry(v, COPY);
  if (problem) { setError(problem.message, problem.field); return; }
  setError("");
  try {
    if (app.uploaded?.file !== app.file) {
      setBusy(true, COPY.uploading.replace("{name}", app.file.name));
      app.uploaded = { file: app.file, id: await upload(app.file) };
    }
    setBusy(true, COPY.sending);
    setProgress(1);
    const res = await fetch("/api/entries", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, credentials: "same-origin", body: JSON.stringify(entryBody(v, app.uploaded.id, els.website.value)) });
    const body = await res.json().catch(() => ({}));
    if (res.status === 201 && Number.isInteger(body.entry)) { done(body.entry); return; }
    if (body.error === "upload_unknown" || body.error === "upload_used") app.uploaded = null; // that upload is spent: the next try sends the file again
    failed(failureWords(COPY, { code: body.error, status: res.status, message: body.message }));
  } catch (err) {
    failed(failureWords(COPY, err ?? {}));
  }
}
function done(entry) {
  setBusy(false);
  els.form.hidden = true;
  els.doneTitle.textContent = COPY.doneTitle;
  els.doneText.textContent = COPY.doneEntry.replace("{entry}", String(entry));
  els.done.hidden = false;
  els.doneTitle.focus();
}

els.form.addEventListener("submit", (ev) => { ev.preventDefault(); send(); });
els.retry.addEventListener("click", send);
els.agree.addEventListener("change", () => { els.submit.disabled = app.busy || !els.agree.checked; });
els.groupYes.addEventListener("change", syncGroup);
els.groupNo.addEventListener("change", syncGroup);
els.add.addEventListener("click", () => addRow()?.first.focus());
els.file.addEventListener("change", () => { const file = els.file.files?.[0]; if (file) chooseFile(file); });
for (const type of ["dragenter", "dragover"]) els.zone.addEventListener(type, (ev) => { ev.preventDefault(); if (!app.busy) els.zone.classList.add("is-over"); });
for (const type of ["dragleave", "dragend", "drop"]) els.zone.addEventListener(type, () => els.zone.classList.remove("is-over"));
els.zone.addEventListener("drop", (ev) => { ev.preventDefault(); if (!app.busy) chooseFile(ev.dataTransfer?.files?.[0]); });
