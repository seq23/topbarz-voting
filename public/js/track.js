// The rapper's page (/track): one 4-digit code → the track, played with the same player the vote
// uses, and a Download button. The code box sends itself on the fourth digit; ?code=1234 in the
// address is looked up on load. Nothing here reads the vote, and nothing is kept on the device.
import { api } from "./api.js";
import { $, h } from "./dom.js";
import { safeMediaUrl } from "./logic.js";
import { cleanTrack, codeDigits, codeFromSearch, isCode } from "./booth-rules.js";
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
  download: $("tbz-download"),
  another: $("tbz-another"),
};

const app = { looking: null, track: null, row: null };

// ── The words (track-copy.js) ────────────────────────────────────────────────────────────────
document.title = `${COPY.headline} | Top Barz`;
els.headline.textContent = COPY.headline;
els.intro.textContent = COPY.intro;
els.label.textContent = COPY.codeLabel;
els.go.textContent = COPY.go;
els.foundTitle.textContent = COPY.found;
els.download.textContent = COPY.download;
els.another.textContent = COPY.another;

// ── The player: one for the page ─────────────────────────────────────────────────────────────
const player = createPlayer((slug, audio) => {
  if (app.row?.slug !== slug) return;
  app.row.audio = audio;
  app.row.render();
});

function createRow(track) {
  const slug = `booth-${track.code}`;
  const row = { slug, audio: { status: "idle", slow: false, time: 0, duration: 0 } };
  const source = () => ({ slug, url: safeMediaUrl(track.audio_url), hint: 0, title: track.file_name, artist: "Top Barz" });
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

// ── Looking a code up ────────────────────────────────────────────────────────────────────────
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
}
function showTrack(track) {
  clearTrack();
  app.track = track;
  app.row = createRow(track);
  els.list.replaceChildren(app.row.el);
  els.download.href = track.download_url;
  els.download.setAttribute("download", track.file_name);
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
