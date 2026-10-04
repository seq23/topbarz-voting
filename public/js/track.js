// The rapper's page (/track): one 4-digit code → the track, played with the same player the vote
// uses, and a Download button. The code box sends itself on the fourth digit; ?code=1234 in the
// address is looked up on load. Since 4 Oct 2026 the track can be made public (a switch, off for
// every track until the rapper flips it), shared (the listen page's link, through the share
// sheet, a text, or the clipboard) and given artwork (resized on the device to a 1024 px square
// JPEG before it goes up). Nothing here reads the vote, and nothing is kept on the device.
import { api } from "./api.js";
import { $, h } from "./dom.js";
import { boothShareMessage, detectPlatform, listenLink, safeMediaUrl, smsHref } from "./logic.js";
import { artworkFor, cleanTrack, codeDigits, codeFromSearch, isCode, safeArtUrl, shareRoute, squareCrop } from "./booth-rules.js";
import { createControls, createPlayer } from "./player.js";
import { COPY } from "./track-copy.js";

const els = {
  headline: $("tbz-track-headline"),
  intro: $("tbz-track-intro"),
  form: $("tbz-code-form"),
  label: $("tbz-code-label"),
  code: $("tbz-code"),
  go: $("tbz-go"),
  msg: $("tbz-code-msg"),
  wait: $("tbz-code-wait"),
  found: $("tbz-found"),
  foundTitle: $("tbz-found-title"),
  list: $("tbz-found-list"),
  art: $("tbz-art"),
  artPick: $("tbz-art-pick"),
  artFile: $("tbz-art-file"),
  artMsg: $("tbz-art-msg"),
  publicLabel: $("tbz-public-label"),
  publicBtn: $("tbz-public"),
  publicNote: $("tbz-public-note"),
  download: $("tbz-download"),
  share: $("tbz-share"),
  shareMsg: $("tbz-share-msg"),
  another: $("tbz-another"),
};

const app = { looking: null, track: null, row: null, platform: detectPlatform(navigator), flipping: false };

// ── The words (track-copy.js)
document.title = `${COPY.headline} | Top Barz`;
els.headline.textContent = COPY.headline;
els.intro.textContent = COPY.intro;
els.label.textContent = COPY.codeLabel;
els.go.textContent = COPY.go;
els.foundTitle.textContent = COPY.found;
els.download.textContent = COPY.download;
els.share.textContent = COPY.share;
els.publicLabel.textContent = COPY.publicLabel;
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
function drawArt() {
  const url = safeArtUrl(app.track?.art_url);
  if (url) els.art.src = url; else els.art.removeAttribute("src");
  els.art.hidden = !url;
  els.artPick.textContent = url ? COPY.changeArt : COPY.addArt;
}

// ── Looking a code up
function say(text) {
  els.msg.textContent = text;
  els.msg.hidden = !text;
}
function clearTrack() {
  if (app.row) { player.drop(app.row.slug); app.row.el.remove(); }
  app.row = null;
  app.track = null;
  els.found.hidden = true;
  els.download.removeAttribute("href");
  els.artMsg.hidden = true;
  els.artFile.value = "";
  drawShare();
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
  drawArt();
  els.found.hidden = false;
  els.found.scrollIntoView({ block: "start" });
  els.foundTitle.focus({ preventScroll: true });
}

async function lookUp(code) {
  if (!isCode(code)) { say(COPY.needCode); return; }
  if (app.looking === code) return;
  if (app.track?.code === code) { els.foundTitle.focus(); return; }
  app.looking = code;
  say("");
  els.wait.textContent = COPY.looking;
  els.wait.hidden = false;
  els.go.disabled = true;
  try {
    const { data } = await api(`/api/booth/tracks/${code}`, { timeout: 10000 });
    const track = cleanTrack(data);
    if (!track) throw new Error(COPY.notFound);
    showTrack(track);
  } catch (err) {
    clearTrack();
    say(err?.status === 404 || err?.code === "not_found" ? COPY.notFound : err?.status === 429 || err?.code === "rate_limited" ? COPY.tooMany : err?.message || COPY.notFound);
  } finally {
    app.looking = null;
    els.wait.hidden = true;
    els.go.disabled = false;
  }
}

// ── The switch: drawn at once, put back if the server says no
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
    const { data } = await api(`/api/booth/tracks/${track.code}/public`, { method: "POST", body: { public: next }, timeout: 10000 });
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
    els.shareMsg.textContent = err?.status === 429 || err?.code === "rate_limited" ? COPY.tooMany : COPY.publicFailed;
    els.shareMsg.hidden = false;
  } finally {
    app.flipping = false;
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
    const res = await fetch(`/api/booth/tracks/${track.code}/art`, { method: "POST", headers: { "content-type": "image/jpeg", accept: "application/json" }, credentials: "same-origin", body: blob });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.message || COPY.artFailed);
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
  if (digits.length === 4) lookUp(digits);
});
els.form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  lookUp(codeDigits(els.code.value));
});
els.publicBtn.addEventListener("click", flipPublic);
els.share.addEventListener("click", share);
els.artFile.addEventListener("change", () => addArt(els.artFile.files?.[0]));
els.another.addEventListener("click", () => {
  clearTrack();
  els.code.value = "";
  els.code.focus();
});

const fromAddress = codeFromSearch(location.search);
if (fromAddress) {
  els.code.value = fromAddress;
  lookUp(fromAddress);
}
