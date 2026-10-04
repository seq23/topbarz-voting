// The listen page (/listen/<share id>): a song a rapper made public from /track, for anyone with
// the link. The artwork (or the Top Barz mark), the file name as the title, the same player the
// vote uses, one line. No way to save it, no code box, nothing kept on the device. A private song and
// an unknown link are the same screen: "Sorry, this song is private" and the way to Top Barz.
// Reading this page never counts as an open of the track (the server's rule).
import { api } from "./api.js";
import { $, h } from "./dom.js";
import { safeMediaUrl } from "./logic.js";
import { artworkFor, cleanListen, shareIdFromPath } from "./booth-rules.js";
import { createControls, createPlayer } from "./player.js";
import { COPY } from "./listen-copy.js";

const els = {
  wait: $("tbz-listen-wait"),
  song: $("tbz-listen-song"),
  art: $("tbz-listen-art"),
  title: $("tbz-listen-title"),
  list: $("tbz-listen-list"),
  line: $("tbz-listen-line"),
  private: $("tbz-listen-private"),
  privateText: $("tbz-listen-private-text"),
  instagram: $("tbz-listen-ig"),
};

// ── The words (listen-copy.js)
document.title = `${COPY.title} | Top Barz`;
els.wait.textContent = COPY.loading;
els.line.textContent = COPY.line;
els.privateText.textContent = COPY.private;
els.instagram.textContent = COPY.instagram;

const app = { row: null };
const player = createPlayer((slug, audio) => {
  if (app.row?.slug !== slug) return;
  app.row.audio = audio;
  app.row.render();
});

function createRow(song, slug) {
  const row = { slug, audio: { status: "idle", slow: false, time: 0, duration: 0 } };
  const source = () => ({ slug, url: safeMediaUrl(song.audio_url), hint: 0, title: song.file_name, artist: "Top Barz", artwork: artworkFor(song.art_url, location.href) });
  const controls = createControls(player, { slug, what: () => "the song", source, words: { none: COPY.audioNone, failed: COPY.audioFailed } });
  row.el = h("article", { class: "track", "data-audio": "idle" },
    h("div", { class: "track-top" }, controls.playBtn,
      h("div", { class: "track-main" }, controls.scrubRow, controls.note)));
  row.render = () => controls.render(row.el, row.audio);
  row.render();
  return row;
}

function showPrivate() {
  els.wait.hidden = true;
  els.song.hidden = true;
  els.private.hidden = false;
}
function showSong(song, id) {
  document.title = `${song.file_name} | Top Barz`;
  if (song.art_url) { els.art.src = song.art_url; els.art.alt = COPY.artAlt; } else { els.art.src = "/img/logo.png"; els.art.alt = ""; }
  els.art.classList.toggle("art-mark", !song.art_url);
  els.title.textContent = song.file_name;
  app.row = createRow(song, `listen-${id}`);
  els.list.replaceChildren(app.row.el);
  els.wait.hidden = true;
  els.private.hidden = true;
  els.song.hidden = false;
}

async function load() {
  const id = shareIdFromPath(location.pathname);
  if (!id) { showPrivate(); return; }
  try {
    const { data } = await api(`/api/booth/listen/${id}`, { timeout: 10000 });
    const song = cleanListen(data);
    if (!song) throw new Error(COPY.private);
    showSong(song, id);
  } catch (err) {
    // A private song, an unknown link or a malformed answer: the private screen. No connection
    // or a busy server: the line says so, and a reload tries again.
    if (err?.status === 404 || err?.code === "private" || err?.code === "not_found" || !err?.status) showPrivate();
    else els.wait.textContent = err.message || COPY.private;
  }
}
load();
