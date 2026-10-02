// The select page (/select): hear the beats, pick one, done. Reads GET /api/beats once (and again
// when a page left open is shown), draws a row per beat with the same player the voting page
// uses, and keeps the pick on this device (pick.js). Nothing here writes to the server, and
// nothing here reads the voting window: the page works the same after voting closes.
import { api } from "./api.js";
import { $, h, icon, reducedMotion } from "./dom.js";
import { safeMediaUrl } from "./logic.js";
import { BEATS_STALE_MS, PICK_KEY, cleanBeats, cleanLinks, loadPick, pickedBeat, pickedTitle, savePick, togglePick } from "./pick.js";
import { createControls, createPlayer } from "./player.js";
import { COPY } from "./select-copy.js";

const els = {
  headline: $("tbz-select-headline"),
  intro: $("tbz-select-intro"),
  picked: $("tbz-picked"),
  pickedTitle: $("tbz-picked-title"),
  pickedLine: $("tbz-picked-line"),
  pickedNote: $("tbz-picked-note"),
  change: $("tbz-pick-change"),
  say: $("tbz-pick-say"),
  beats: $("tbz-beats"),
  beatsTitle: $("tbz-beats-title"),
  loading: $("tbz-beats-loading"),
  loadError: $("tbz-beats-error"),
  loadErrorText: $("tbz-beats-error-text"),
  loadRetry: $("tbz-beats-retry"),
  empty: $("tbz-beats-empty"),
  list: $("tbz-beats-list"),
  links: $("tbz-links"),
  linksTitle: $("tbz-links-title"),
  linksList: $("tbz-links-list"),
};

const store = (() => { try { return window.localStorage; } catch { return null; } })();
const app = {
  loaded: false, // an /api/beats answer has been drawn
  loadedAt: 0,
  loading: false,
  beats: [],
  rows: new Map(), // slug → row
  pick: loadPick(store), // the stored slug (it may name a beat that is no longer offered)
  kept: true, // false when this browser refused to remember the pick
};
const scrollBehavior = () => (reducedMotion() ? "auto" : "smooth");

// ── The words (select-copy.js) ───────────────────────────────────────────────────────────────
document.title = `${COPY.headline} | Top Barz`;
els.headline.textContent = COPY.headline;
els.intro.textContent = COPY.intro;
els.beatsTitle.textContent = COPY.listTitle;
els.pickedLine.textContent = COPY.done;
els.change.textContent = COPY.change;
const links = cleanLinks(COPY.links);
els.linksTitle.textContent = COPY.linksTitle;
els.linksList.replaceChildren(...links.map((l) => h("li", {},
  l.role ? h("span", { class: "credit-role", text: `${l.role}: ` }) : null,
  l.url ? h("a", { href: l.url, rel: "noopener", text: l.label }) : h("span", { text: l.label }))));
els.links.hidden = links.length === 0;

// ── The player: one for the page, so only one beat plays at a time ───────────────────────────
const player = createPlayer((slug, audio) => {
  const row = app.rows.get(slug);
  if (!row) return;
  row.audio = audio;
  row.renderAudio();
});

// ── A beat row ───────────────────────────────────────────────────────────────────────────────
function createRow(beat) {
  const slug = beat.slug;
  const row = { slug, beat, audio: { status: "idle", slow: false, time: 0, duration: beat.duration_ms / 1000 } };

  const title = h("h3", { class: "track-label", text: beat.name });
  const credit = h("p", { class: "credit", hidden: true });
  const source = () => ({ slug, url: safeMediaUrl(row.beat.audio_url), hint: row.audio.duration, title: row.beat.name, artist: "Top Barz" });
  const controls = createControls(player, { slug, what: () => row.beat.name, source, words: { none: "This beat has no audio yet.", failed: "This beat did not load. Tap play to try again." } });
  const pickText = h("span", { text: COPY.choose });
  const pickName = h("span", { class: "sr-only" });
  const pickBtn = h("button", { type: "button", class: "chip pick", "aria-pressed": "false" }, icon("check"), pickText, pickName);

  const el = h("article", { class: "track beat", id: `tbz-beat-${slug}`, "data-audio": "idle" },
    h("div", { class: "track-top" }, controls.playBtn,
      h("div", { class: "track-main" },
        h("div", { class: "track-title" }, title),
        credit,
        controls.scrubRow,
        controls.note)),
    h("div", { class: "actions" }, pickBtn));
  Object.assign(row, { el, pickBtn });

  row.renderAudio = () => controls.render(el, row.audio);
  row.renderPick = (picked) => {
    el.classList.toggle("is-picked", picked);
    pickBtn.setAttribute("aria-pressed", String(picked));
    pickText.textContent = picked ? COPY.chosen : COPY.choose;
  };
  // New details from /api/beats (a renamed beat, a credit that arrived).
  row.update = (next) => {
    row.beat = next;
    if (title.textContent !== next.name) title.textContent = next.name;
    pickName.textContent = `: ${next.name}`;
    if (!player.isCurrent(slug)) row.audio.duration = next.duration_ms / 1000;
    // A credit shows only when the beat has one; it is a link only when it has an https address.
    credit.replaceChildren(...(next.credit_label
      ? ["By ", next.credit_url ? h("a", { href: next.credit_url, rel: "noopener", text: next.credit_label }) : next.credit_label]
      : []));
    credit.hidden = !next.credit_label;
    row.renderAudio();
  };
  pickBtn.addEventListener("click", () => choose(togglePick(pickedBeat(app.pick, app.beats)?.slug ?? null, slug), true));

  row.update(beat);
  return row;
}

// ── The pick ─────────────────────────────────────────────────────────────────────────────────
// Draws whatever app.pick and app.beats say: the done panel, and each row's button.
function renderPick() {
  const beat = app.loaded ? pickedBeat(app.pick, app.beats) : null;
  for (const row of app.rows.values()) row.renderPick(row.slug === beat?.slug);
  els.picked.hidden = !beat;
  if (!beat) return;
  els.pickedTitle.textContent = pickedTitle(COPY.pickedTitle, beat.name);
  els.pickedNote.hidden = app.kept;
}

// A choice made on this page. `slug` null takes the pick back. Playback is left alone.
function choose(slug, fromRow) {
  app.pick = slug;
  app.kept = savePick(store, slug);
  renderPick();
  if (slug) {
    els.say.textContent = "";
    els.picked.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
    els.pickedTitle.focus({ preventScroll: true });
    return;
  }
  els.say.textContent = "Your pick is cleared. Choose a beat.";
  if (fromRow) return; // the button that was tapped keeps the keyboard
  els.beats.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  els.beatsTitle.focus({ preventScroll: true });
}

// ── The list ─────────────────────────────────────────────────────────────────────────────────
function renderBeats(beats) {
  app.beats = beats;
  const seen = new Set();
  beats.forEach((beat, i) => {
    seen.add(beat.slug);
    let row = app.rows.get(beat.slug);
    if (row) row.update(beat);
    else { row = createRow(beat); app.rows.set(beat.slug, row); }
    if (els.list.children[i] !== row.el) els.list.insertBefore(row.el, els.list.children[i] || null);
  });
  for (const [slug, row] of app.rows) {
    if (seen.has(slug)) continue;
    player.drop(slug);
    row.el.remove();
    app.rows.delete(slug);
  }
  els.loading.hidden = true;
  els.loadError.hidden = true;
  els.list.removeAttribute("aria-busy");
  els.empty.hidden = app.rows.size > 0;
  renderPick();
}

let slowTimer = null;
async function load() {
  if (app.loading) return;
  app.loading = true;
  if (!app.loaded && els.loadError.hidden) {
    els.loading.hidden = false;
    els.loading.textContent = "Loading the beats…";
    clearTimeout(slowTimer);
    slowTimer = setTimeout(() => { if (!app.loaded) els.loading.textContent = "Still loading the beats. Your connection is slow."; }, 5000);
  }
  try {
    const { data } = await api("/api/beats", { timeout: 10000 });
    app.loaded = true;
    app.loadedAt = Date.now();
    renderBeats(cleanBeats(data.beats));
  } catch (err) {
    // A refresh that fails leaves the beats already on the page as they are.
    if (!app.loaded) {
      els.loading.hidden = true;
      els.loadError.hidden = false;
      els.loadErrorText.textContent = `The beats did not load. ${err.message}`;
    }
  } finally {
    clearTimeout(slowTimer);
    app.loading = false;
    els.loadRetry.disabled = false;
    els.loadRetry.textContent = "Try again";
  }
}

// ── Start ────────────────────────────────────────────────────────────────────────────────────
els.loadRetry.addEventListener("click", () => {
  els.loadRetry.disabled = true;
  els.loadRetry.textContent = "Loading…";
  load();
});
els.change.addEventListener("click", () => choose(null, false));
// The pick made, changed or taken back in another tab shows here too.
window.addEventListener("storage", (ev) => {
  if (ev.key !== PICK_KEY && ev.key !== null) return;
  app.pick = loadPick(store);
  app.kept = true;
  renderPick();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && (!app.loaded || Date.now() - app.loadedAt > BEATS_STALE_MS)) load();
});
window.addEventListener("pageshow", (ev) => { if (ev.persisted) load(); });
window.addEventListener("online", () => { if (!app.loaded) load(); });

load();
