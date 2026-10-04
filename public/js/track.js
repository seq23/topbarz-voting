// The rapper's page (/track): the 4-digit code WITH an email → the track, the vote's player, and
// Download. The code box moves on to the email box on the fourth digit (or sends, when the email
// is already there); ?code=1234 fills the code on load. The track can be made public (a switch,
// off until someone attached flips it), shared (the listen link through the share sheet, a text,
// or the clipboard) and given artwork (a 1024 px square JPEG made on the device). Everyone who
// enters the code with their email is attached to the song and has their own switch for the
// public vote (share is anyone's call; the vote is everyone's consent; 4 Oct 2026). Nothing here
// reads the vote. The device remembers ONE thing, the email typed here (localStorage
// tbz.booth.email), never the code; the only email it shows is that one (`you.email`).
import { api } from "./api.js";
import { $, h } from "./dom.js";
import { boothShareMessage, detectPlatform, listenLink, safeMediaUrl, smsHref } from "./logic.js";
import { artworkFor, cleanEmail, cleanPeople, cleanTrack, codeDigits, codeFromSearch, isCode, safeArtUrl, shareRoute, squareCrop, voteWords } from "./booth-rules.js";
import { createControls, createPlayer } from "./player.js";
import { COPY } from "./track-copy.js";

const els = {
  headline: $("tbz-track-headline"),
  intro: $("tbz-track-intro"),
  form: $("tbz-code-form"),
  label: $("tbz-code-label"),
  code: $("tbz-code"),
  emailLabel: $("tbz-email-label"),
  email: $("tbz-email"),
  go: $("tbz-go"),
  msg: $("tbz-code-msg"),
  wait: $("tbz-code-wait"),
  found: $("tbz-found"),
  foundTitle: $("tbz-found-title"),
  you: $("tbz-you"),
  list: $("tbz-found-list"),
  art: $("tbz-art"),
  artPick: $("tbz-art-pick"),
  artFile: $("tbz-art-file"),
  artMsg: $("tbz-art-msg"),
  publicLabel: $("tbz-public-label"),
  publicBtn: $("tbz-public"),
  publicNote: $("tbz-public-note"),
  publicGroup: $("tbz-public-group"),
  voteLabel: $("tbz-vote-label"),
  voteBtn: $("tbz-vote"),
  voteNote: $("tbz-vote-note"),
  download: $("tbz-download"),
  share: $("tbz-share"),
  shareMsg: $("tbz-share-msg"),
  another: $("tbz-another"),
};

const app = { looking: null, track: null, row: null, platform: detectPlatform(navigator), flipping: false, voting: false };

// ── The remembered email: the one thing kept on the device, so the box is filled in next time.
const EMAIL_KEY = "tbz.booth.email";
function rememberedEmail() {
  try { return cleanEmail(localStorage.getItem(EMAIL_KEY)); } catch { return ""; }
}
function rememberEmail(email) {
  try { localStorage.setItem(EMAIL_KEY, email); } catch {}
}

// ── The words (track-copy.js)
document.title = `${COPY.headline} | Top Barz`;
els.headline.textContent = COPY.headline;
els.intro.textContent = COPY.intro;
els.label.textContent = COPY.codeLabel;
els.emailLabel.textContent = COPY.emailLabel;
els.go.textContent = COPY.go;
els.foundTitle.textContent = COPY.found;
els.download.textContent = COPY.download;
els.share.textContent = COPY.share;
els.publicLabel.textContent = COPY.publicLabel;
els.publicGroup.textContent = COPY.publicNote;
els.voteLabel.textContent = COPY.voteLabel;
els.another.textContent = COPY.another;

// ── The player: one for the page
const player = createPlayer((slug, audio) => {
  if (app.row?.slug !== slug) return;
  app.row.audio = audio;
  app.row.render();
});

function createRow(track) {
  const slug = `booth-${track.code}`;
  const row = { slug, audio: { status: "idle", slow: false, time: 0, duration: 0 } };
  // The source is read at each play, so artwork added after the first play reaches the lock screen too.
  const source = () => ({ slug, url: safeMediaUrl(track.audio_url), hint: 0, title: track.file_name, artist: "Top Barz", artwork: artworkFor(app.track?.art_url, location.href) });
  const controls = createControls(player, { slug, what: () => "your track", source, words: { none: COPY.audioNone, failed: COPY.audioFailed } });
  row.el = h("article", { class: "track", "data-audio": "idle" },
    h("div", { class: "track-top" }, controls.playBtn,
      h("div", { class: "track-main" },
        h("div", { class: "track-title" }, h("h3", { class: "track-label", text: track.file_name })),
        controls.scrubRow,
        controls.note)));
  row.render = () => controls.render(row.el, row.audio);
  row.render();
  return row;
}

// ── The share state, drawn from what the server last said
function drawShare() {
  const t = app.track;
  const pub = Boolean(t?.public && t.share_id);
  els.publicBtn.setAttribute("aria-checked", pub ? "true" : "false");
  els.publicNote.textContent = pub ? COPY.publicOn : COPY.publicOff;
  els.share.hidden = !pub;
  if (!pub) { els.shareMsg.hidden = true; els.shareMsg.textContent = ""; }
}
// The people: this device's own email (the only one ever shown), its own vote switch, and where
// the group stands, as numbers.
function drawPeople() {
  const t = app.track;
  els.you.textContent = t ? COPY.you.replace("{email}", t.you.email) : "";
  els.voteBtn.setAttribute("aria-checked", t?.you.vote_opt_in ? "true" : "false");
  els.voteNote.textContent = t ? voteWords(COPY, t) : "";
}
function drawArt() {
  const url = safeArtUrl(app.track?.art_url);
  if (url) els.art.src = url; else els.art.removeAttribute("src");
  els.art.hidden = !url;
  els.artPick.textContent = url ? COPY.changeArt : COPY.addArt;
}

// ── Entering a code, with an email
function say(text) {
  els.msg.textContent = text;
  els.msg.hidden = !text;
}
// Why the server said no to a change, in the page's words.
const refusal = (err, fallback) => (err?.status === 403 || err?.code === "not_attached" ? COPY.notAttached : err?.status === 429 || err?.code === "rate_limited" ? COPY.tooMany : fallback);
function clearTrack() {
  if (app.row) { player.drop(app.row.slug); app.row.el.remove(); }
  app.row = null;
  app.track = null;
  els.found.hidden = true;
  els.download.removeAttribute("href");
  els.artMsg.hidden = true;
  els.artFile.value = "";
  drawShare();
  drawPeople();
  drawArt();
}
function showTrack(track) {
  clearTrack();
  app.track = track;
  app.row = createRow(track);
  els.list.replaceChildren(app.row.el);
  els.download.href = track.download_url;
  els.download.setAttribute("download", track.file_name);
  drawShare();
  drawPeople();
  drawArt();
  els.found.hidden = false;
  els.found.scrollIntoView({ block: "start" });
  els.foundTitle.focus({ preventScroll: true });
}

async function enter(code, rawEmail) {
  if (!isCode(code)) { say(COPY.needCode); els.code.focus(); return; }
  const email = cleanEmail(rawEmail);
  if (!email) { say(String(rawEmail ?? "").trim() ? COPY.badEmail : COPY.needEmail); els.email.focus(); return; }
  if (app.looking === code) return;
  if (app.track?.code === code && app.track.you.email === email) { els.foundTitle.focus(); return; }
  app.looking = code;
  say("");
  els.wait.textContent = COPY.looking;
  els.wait.hidden = false;
  els.go.disabled = true;
  try {
    const { data } = await api(`/api/booth/tracks/${code}/enter`, { method: "POST", body: { email }, timeout: 10000 });
    const track = cleanTrack(data);
    if (!track) throw new Error(COPY.notFound);
    rememberEmail(track.you.email);
    showTrack(track);
  } catch (err) {
    clearTrack();
    say(err?.status === 404 || err?.code === "not_found" ? COPY.notFound : err?.status === 429 || err?.code === "rate_limited" ? COPY.tooMany : err?.code === "bad_email" ? COPY.badEmail : err?.message || COPY.notFound);
  } finally {
    app.looking = null;
    els.wait.hidden = true;
    els.go.disabled = false;
  }
}
const enterFromForm = () => enter(codeDigits(els.code.value), els.email.value);

// ── The switch: drawn at once, put back if the server says no. Anyone attached may flip it.
async function flipPublic() {
  const track = app.track;
  if (!track || app.flipping) return;
  const was = { public: track.public, share_id: track.share_id };
  const next = !track.public;
  app.flipping = true;
  track.public = next;
  if (!next) track.share_id = null;
  drawShare();
  try {
    const { data } = await api(`/api/booth/tracks/${track.code}/public`, { method: "POST", body: { email: track.you.email, public: next }, timeout: 10000 });
    if (app.track !== track) return;
    const confirmed = cleanTrack({ ...track, public: data?.public, share_id: data?.share_id });
    if (!confirmed) throw new Error(COPY.publicFailed);
    track.public = confirmed.public;
    track.share_id = confirmed.share_id;
    drawShare();
  } catch (err) {
    if (app.track !== track) return;
    track.public = was.public;
    track.share_id = was.share_id;
    drawShare();
    els.shareMsg.textContent = refusal(err, COPY.publicFailed);
    els.shareMsg.hidden = false;
  } finally {
    app.flipping = false;
  }
}

// ── This person's own vote switch: drawn at once, put back if the server says no; the counts
// under it come from the server's answer.
async function flipVote() {
  const track = app.track;
  if (!track || app.voting) return;
  const was = track.you.vote_opt_in;
  const next = !was;
  app.voting = true;
  track.you.vote_opt_in = next;
  drawPeople();
  try {
    const { data } = await api(`/api/booth/tracks/${track.code}/vote`, { method: "POST", body: { email: track.you.email, opt_in: next }, timeout: 10000 });
    if (app.track !== track) return;
    const confirmed = cleanPeople(data);
    if (!confirmed || confirmed.you.email !== track.you.email) throw new Error(COPY.voteFailed);
    Object.assign(track, confirmed);
    drawPeople();
  } catch (err) {
    if (app.track !== track) return;
    track.you.vote_opt_in = was;
    drawPeople();
    els.voteNote.textContent = refusal(err, COPY.voteFailed);
  } finally {
    app.voting = false;
  }
}

// ── Share: the share sheet, else a text, else the clipboard
async function share() {
  const track = app.track;
  if (!track?.public || !track.share_id) return;
  const link = listenLink(location.origin, track.share_id);
  const message = boothShareMessage(COPY.shareMessage, link);
  const route = shareRoute(navigator, app.platform);
  els.shareMsg.hidden = true;
  if (route === "share") {
    try {
      await navigator.share({ text: COPY.shareMessage, url: link });
      return;
    } catch (err) {
      if (err?.name === "AbortError") return; // the sheet was closed: nothing to say
    }
  }
  const href = smsHref(app.platform, message);
  if (href) { try { location.href = href; } catch {} return; }
  try {
    await navigator.clipboard.writeText(link);
    els.shareMsg.textContent = COPY.copied;
  } catch {
    els.shareMsg.textContent = COPY.copyFailed;
  }
  els.shareMsg.hidden = false;
}

// ── Artwork: cut to a square and scaled on the device, then sent as a JPEG
async function squareJpeg(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const { sx, sy, side, out } = squareCrop(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = out;
    canvas.height = out;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, out, out);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob || !blob.size) throw new Error("no picture");
    return blob;
  } finally {
    bitmap.close?.();
  }
}
async function addArt(file) {
  const track = app.track;
  if (!track || !file) return;
  els.artMsg.hidden = true;
  els.artPick.textContent = COPY.artWorking;
  let blob;
  try {
    blob = await squareJpeg(file);
    if (blob.size > 2 * 1024 * 1024) throw new Error("too big");
  } catch {
    if (app.track === track) { els.artMsg.textContent = COPY.artUnreadable; els.artMsg.hidden = false; drawArt(); }
    return;
  }
  try {
    const res = await fetch(`/api/booth/tracks/${track.code}/art`, { method: "POST", headers: { "content-type": "image/jpeg", accept: "application/json", "x-email": track.you.email }, credentials: "same-origin", body: blob });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(refusal({ status: res.status, code: data?.error }, data?.message || COPY.artFailed));
    const url = safeArtUrl(data?.art_url);
    if (!url) throw new Error(COPY.artFailed);
    if (app.track !== track) return;
    track.art_url = url;
    drawArt();
  } catch (err) {
    if (app.track !== track) return;
    els.artMsg.textContent = err?.message || COPY.artFailed;
    els.artMsg.hidden = false;
    drawArt();
  } finally {
    els.artFile.value = "";
  }
}

els.code.addEventListener("input", () => {
  const digits = codeDigits(els.code.value);
  if (els.code.value !== digits) els.code.value = digits;
  say("");
  if (digits.length === 4) { if (cleanEmail(els.email.value)) enterFromForm(); else els.email.focus(); }
});
els.email.addEventListener("input", () => say(""));
els.form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  enterFromForm();
});
els.publicBtn.addEventListener("click", flipPublic);
els.voteBtn.addEventListener("click", flipVote);
els.share.addEventListener("click", share);
els.artFile.addEventListener("change", () => addArt(els.artFile.files?.[0]));
els.another.addEventListener("click", () => {
  clearTrack();
  els.code.value = "";
  els.code.focus();
});

// On load: the remembered email fills its box; ?code= fills the code box and, with an email
// remembered, enters at once, else the email box takes the keyboard.
els.email.value = rememberedEmail();
const fromAddress = codeFromSearch(location.search);
if (fromAddress) {
  els.code.value = fromAddress;
  if (els.email.value) enterFromForm(); else els.email.focus();
}
