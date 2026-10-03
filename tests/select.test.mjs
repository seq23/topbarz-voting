// The select page (/select): the pick's rules (public/js/pick.js, imported as the browser imports
// it), the page's own script run against a stand-in page, and the markup and copy rules read from
// the shipped files.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BEATS_STALE_MS, PICK_KEY, cleanBeats, cleanLinks, introParts, introText, isBeatSlug, loadPick, pickedBeat, pickedTitle, readPick, safeLinkUrl, savePick, togglePick,
} from "../public/js/pick.js";
import { COPY } from "../public/js/select-copy.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, "public", rel), "utf8");
const BEATS = [1, 2, 3, 4].map((n) => ({ slug: `placeholder-beat-${n}`, name: `Placeholder beat ${n}`, audio_url: `/media/beats/placeholder-beat-${n}-0123456789.mp3`, duration_ms: 60000 + n * 1000, credit_label: null, credit_url: null }));
const memory = (map = new Map()) => ({ getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), map });
const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };

// ── The pick's rules ─────────────────────────────────────────────────────────────────────────
test("pick: it is one beat's slug, kept under tbz.pick, and anything else stored there is no pick", () => {
  assert.equal(PICK_KEY, "tbz.pick");
  for (const good of ["night-drive", "placeholder-beat-2", "a", "808"]) assert.equal(readPick(good), good);
  for (const bad of ["", " night", "Night-Drive", "-x", "x-", "a/b", "<b>", '{"slug":"x"}', "x".repeat(61), null, undefined, 7, {}]) assert.equal(readPick(bad), null, String(bad));
  assert.equal(isBeatSlug("placeholder-beat-10"), true);
  const store = memory();
  assert.equal(loadPick(store), null, "nothing stored = nothing picked");
  assert.equal(savePick(store, "night-drive"), true);
  assert.equal(store.map.get("tbz.pick"), "night-drive", "the stored value is the slug itself");
  assert.equal(loadPick(store), "night-drive");
  assert.equal(savePick(store, null), true);
  assert.equal(store.map.has("tbz.pick"), false, "taking the pick back forgets it");
  assert.equal(savePick(store, "Not A Slug"), true);
  assert.equal(store.map.has("tbz.pick"), false, "and something that is not a slug is never stored");
});

test("pick: a browser that refuses storage does not break the page; it is told the pick will not be kept", () => {
  assert.equal(loadPick(broken), null);
  assert.equal(savePick(broken, "night-drive"), false);
  assert.equal(savePick(broken, null), false);
  assert.equal(loadPick(null), null);
  assert.equal(savePick(null, "night-drive"), false);
});

test("pick: choosing, changing and taking it back; a stored beat that is no longer offered is no pick", () => {
  assert.equal(togglePick(null, "night-drive"), "night-drive", "choose");
  assert.equal(togglePick("night-drive", "midnight-run"), "midnight-run", "another row changes it");
  assert.equal(togglePick("night-drive", "night-drive"), null, "the picked row's own button takes it back");
  assert.equal(togglePick("night-drive", "<script>"), null);
  assert.equal(pickedBeat("placeholder-beat-3", BEATS), BEATS[2]);
  assert.equal(pickedBeat("gone-beat", BEATS), null, "falls back to the unpicked state");
  assert.equal(pickedBeat(null, BEATS), null);
  assert.equal(pickedBeat("placeholder-beat-3", []), null);
  assert.equal(pickedTitle("You picked {name}", "Night Drive"), "You picked Night Drive");
  assert.equal(pickedTitle("{name} it is. {name}!", "$& <b>"), "$& <b> it is. $& <b>!", "the name goes in exactly as given");
  assert.ok(BEATS_STALE_MS >= 30_000 && BEATS_STALE_MS <= 5 * 60_000);
});

test("beats: only well-formed beats are drawn, each once; a credit is a link only when it is https", () => {
  const cleaned = cleanBeats([
    { slug: "a", name: " A ", audio_url: "/media/beats/a-1.mp3", duration_ms: 1000, credit_label: " Kay ", credit_url: "https://example.com/kay" },
    { slug: "a", name: "A again" },
    { slug: "b", name: "B", credit_label: "Label only", credit_url: "javascript:alert(1)" },
    { slug: "c", name: "C", credit_url: "https://example.com/no-label" },
    { slug: "Bad Slug", name: "x" }, { slug: "d", name: "  " }, { slug: "e" }, null, "x",
  ]);
  assert.deepEqual(cleaned, [
    { slug: "a", name: "A", audio_url: "/media/beats/a-1.mp3", duration_ms: 1000, credit_label: "Kay", credit_url: "https://example.com/kay" },
    { slug: "b", name: "B", audio_url: null, duration_ms: 0, credit_label: "Label only", credit_url: null },
    { slug: "c", name: "C", audio_url: null, duration_ms: 0, credit_label: null, credit_url: null },
  ]);
  for (const junk of [null, undefined, {}, "beats", 7]) assert.deepEqual(cleanBeats(junk), []);
  assert.equal(safeLinkUrl("https://www.instagram.com/topbarz.xyz"), "https://www.instagram.com/topbarz.xyz");
  for (const bad of ["http://example.com", "javascript:alert(1)", "data:text/html,x", "//example.com/x", "/select", "", null, "https://u:p@example.com/", "https://localhost/"]) assert.equal(safeLinkUrl(bad), null, String(bad));
  assert.deepEqual(cleanLinks([{ role: " Producer ", label: " Kay ", url: "https://example.com/kay" }, { role: "Engineer", label: "No link yet", url: "" }, { role: "Nobody", label: " " }, null]), [
    { role: "Producer", label: "Kay", url: "https://example.com/kay" },
    { role: "Engineer", label: "No link yet", url: null },
  ]);
  assert.deepEqual(cleanLinks(undefined), []);
});

test("intro parts: words stay words, a name links only to an https address, and the text reads as one sentence", () => {
  const parts = ["Beats by ", { text: "Kay", url: "https://example.com/kay" }, " and ", { text: "Lo", url: "http://example.com/lo" }, { text: "", url: "https://example.com/nobody" }, ".", 7, null];
  assert.deepEqual(introParts(parts), [
    { text: "Beats by ", url: null }, { text: "Kay", url: "https://example.com/kay" }, { text: " and ", url: null }, { text: "Lo", url: null }, { text: ".", url: null },
  ]);
  assert.equal(introText(parts), "Beats by Kay and Lo.");
  assert.deepEqual(introParts("One plain sentence."), [{ text: "One plain sentence.", url: null }], "a plain string still works");
  assert.deepEqual(introParts(undefined), []);
});

// ── The page's own script, run against a stand-in page ───────────────────────────────────────
// Every element select.js looks up, as select.html has it (hidden or not); the rows it builds are
// real trees of stand-in elements. fetch, storage and the audio element are under the test's
// control. Each open() is one tab: a fresh run of the script against the shared storage.
class El {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.parent = null; this.attrs = new Map(); this.listeners = {};
    this.dataset = {}; this.hidden = false; this.disabled = false; this.value = ""; this.text = "";
    const cls = new Set();
    this.cls = cls;
    this.classList = { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) };
    this.style = { setProperty() {} };
  }
  set className(v) { for (const c of String(v).split(/\s+/).filter(Boolean)) this.cls.add(c); }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this.text = String(v); this.children = []; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); if (k === "hidden") this.hidden = true; if (k === "disabled") this.disabled = true; if (k === "id") this.id = String(v); }
  getAttribute(k) { return this.attrs.get(k) ?? null; }
  removeAttribute(k) { this.attrs.delete(k); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  fire(type, ev = {}) { for (const fn of this.listeners[type] ?? []) fn({ preventDefault() {}, button: 0, ...ev }); }
  append(...kids) { for (const k of kids) { const node = typeof k === "string" ? Object.assign(new El("#text"), { text: k }) : k; node.parent = this; this.children.push(node); } }
  replaceChildren(...kids) { this.children = []; this.text = ""; this.append(...kids); }
  insertBefore(node, ref) { node.remove(); const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(node); else this.children.splice(i, 0, node); node.parent = this; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  focus() { this.tab.focused = this; }
  scrollIntoView() { this.tab.scrolledTo = this; }
  getBoundingClientRect() { return { left: 0, width: 100 }; }
  setPointerCapture() {}
  find(cls) { for (const c of this.children) { if (c.cls.has(cls)) return c; const deep = c.find(cls); if (deep) return deep; } return null; }
  all(tag, out = []) { for (const c of this.children) { if (c.tagName === tag) out.push(c); c.all(tag, out); } return out; }
}

let opened = 0;
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
// answers: one per request to /api/beats, each a beats array or an Error (the request fails).
async function open(t, { store = memory(), answers }) {
  const html = read("select.html");
  const tab = { focused: null, scrolledTo: null, requests: [], audios: [], title: "" };
  const byId = {};
  const doc = {
    hidden: false, listeners: {},
    get title() { return tab.title; }, set title(v) { tab.title = v; },
    addEventListener: (type, fn) => { (doc.listeners[type] ??= []).push(fn); },
    createElement: (tag) => Object.assign(new El(tag), { tab }),
    createElementNS: (_ns, tag) => Object.assign(new El(tag), { tab }),
    getElementById(id) {
      if (byId[id]) return byId[id];
      const tag = new RegExp(`<([a-z0-9]+)\\b[^>]*\\bid="${id}"[^>]*>`).exec(html);
      assert.ok(tag, `select.js looks up #${id}, which is not in select.html`);
      const el = Object.assign(new El(tag[1]), { tab, id });
      el.hidden = /\shidden(\s|>)/.test(tag[0]);
      if (/\saria-busy="true"/.test(tag[0])) el.attrs.set("aria-busy", "true");
      return (byId[id] = el);
    },
  };
  const win = { listeners: {}, localStorage: store, addEventListener: (type, fn) => { (win.listeners[type] ??= []).push(fn); } };
  class FakeAudio {
    constructor() { this.listeners = {}; this.paused = true; this.ended = false; this.currentTime = 0; this.duration = NaN; this.readyState = 0; this.src = ""; tab.audios.push(this); }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    emit(type) { for (const fn of this.listeners[type] ?? []) fn(); }
    play() { this.paused = false; this.emit("play"); this.readyState = 4; this.emit("playing"); return Promise.resolve(); }
    pause() { if (this.paused) return; this.paused = true; this.emit("pause"); }
    removeAttribute() { this.src = ""; }
  }
  const real = { fetch: globalThis.fetch };
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.Audio = FakeAudio;
  globalThis.fetch = async (url, init = {}) => {
    tab.requests.push(`${init.method ?? "GET"} ${url}`);
    const next = answers.shift();
    assert.ok(next, `an unexpected request: ${url}`);
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify({ beats: next }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = real.fetch; delete globalThis.document; delete globalThis.window; delete globalThis.Audio; });
  await import(`../public/js/select.js?tab=${++opened}`);
  await flush();
  const $ = (id) => doc.getElementById(`tbz-${id}`);
  const rows = () => $("beats-list").children;
  const row = (n) => rows()[n - 1];
  const view = () => ({
    done: $("picked").hidden ? null : $("picked-title").textContent,
    pressed: rows().map((r) => r.find("pick").getAttribute("aria-pressed") === "true"),
    marked: rows().map((r) => r.cls.has("is-picked")),
    buttons: rows().map((r) => r.find("pick").textContent),
    audio: rows().map((r) => r.dataset.audio),
  });
  return {
    tab, doc, win, store, $, rows, row, view,
    choose: (n) => row(n).find("pick").fire("click"),
    play: (n) => row(n).find("play").fire("click"),
    storage: async (key = PICK_KEY) => { for (const fn of win.listeners.storage ?? []) fn({ key }); await flush(); },
    show: async () => { for (const fn of doc.listeners.visibilitychange ?? []) fn({}); await flush(); },
  };
}

test("select page: the beats load, each with a player and a Choose button; nothing is picked yet", async (t) => {
  const page = await open(t, { answers: [BEATS] });
  assert.deepEqual(page.rows().map((r) => r.find("track-label").textContent), BEATS.map((b) => b.name));
  assert.deepEqual(page.rows().map((r) => r.id), BEATS.map((b) => `tbz-beat-${b.slug}`));
  assert.deepEqual(page.view(), { done: null, pressed: [false, false, false, false], marked: [false, false, false, false], buttons: BEATS.map((b) => `${COPY.choose}: ${b.name}`), audio: ["idle", "idle", "idle", "idle"] });
  assert.deepEqual([page.$("beats-loading").hidden, page.$("beats-error").hidden, page.$("beats-empty").hidden, page.$("beats-list").getAttribute("aria-busy")], [true, true, true, null]);
  assert.equal(page.row(1).find("play").getAttribute("aria-label"), "Play Placeholder beat 1");
  assert.equal(page.row(1).find("time").textContent, "0:00 / 1:01");
  assert.equal(page.row(1).find("credit").hidden, true, "a beat with no credit shows none");
  // The words come from the one copy object.
  assert.deepEqual([page.$("select-headline").textContent, page.$("select-intro").textContent, page.$("beats-title").textContent, page.$("picked-line").textContent, page.$("pick-change").textContent, page.$("links-title").textContent],
    [COPY.headline, introText(COPY.intro), COPY.listTitle, COPY.done, COPY.change, COPY.linksTitle]);
  // The three names in the intro are links, in the order written, each to its https address.
  assert.deepEqual(page.$("select-intro").all("a").map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("rel")]),
    introParts(COPY.intro).filter((p) => p.url).map((p) => [p.text, p.url, "noopener"]));
  assert.equal(page.$("select-intro").all("a").length, 3, "Ayake, 4stro and Studio404 are linked");
  assert.equal(page.tab.title, `${COPY.headline} | Top Barz`);
  assert.equal(page.$("links").hidden, false);
  assert.deepEqual(page.$("links-list").children.map((li) => li.textContent), COPY.links.map((l) => `${l.role}: ${l.label}`));
  assert.equal(page.$("links-list").all("a").length, COPY.links.filter((l) => safeLinkUrl(l.url)).length, "a placeholder with no address is words, not a dead link");
  assert.deepEqual(page.tab.requests, ["GET /api/beats"]);
});

test("select page: choosing shows the done state, it survives a refresh and a return visit, and it can be changed or taken back", async (t) => {
  const store = memory();
  const page = await open(t, { store, answers: [BEATS] });
  page.choose(2);
  assert.deepEqual(page.view(), { done: "You picked Placeholder beat 2", pressed: [false, true, false, false], marked: [false, true, false, false], buttons: [`${COPY.choose}: Placeholder beat 1`, `${COPY.chosen}: Placeholder beat 2`, `${COPY.choose}: Placeholder beat 3`, `${COPY.choose}: Placeholder beat 4`], audio: ["idle", "idle", "idle", "idle"] });
  assert.equal(store.map.get("tbz.pick"), "placeholder-beat-2", "kept on the device, as the slug");
  assert.deepEqual([...store.map.keys()], ["tbz.pick"], "and nothing else is kept");
  assert.equal(page.tab.focused, page.$("picked-title"), "the keyboard and the screen reader land on the done state");
  assert.equal(page.tab.scrolledTo, page.$("picked"));
  assert.equal(page.$("picked-note").hidden, true);

  // A refresh, or coming back another day: the same storage, a fresh page.
  const back = await open(t, { store, answers: [BEATS] });
  assert.equal(back.view().done, "You picked Placeholder beat 2");
  assert.deepEqual(back.view().pressed, [false, true, false, false]);
  assert.equal(back.tab.focused, null, "a return visit does not move the page or the keyboard");
  assert.equal(back.tab.scrolledTo, null);

  // Another row changes the pick; the picked row's own button takes it back; so does Change my pick.
  back.choose(4);
  assert.equal(back.view().done, "You picked Placeholder beat 4");
  assert.equal(store.map.get("tbz.pick"), "placeholder-beat-4");
  back.choose(4);
  assert.deepEqual([back.view().done, back.view().pressed.includes(true), store.map.has("tbz.pick")], [null, false, false]);
  assert.equal(back.$("pick-say").textContent, "Your pick is cleared. Choose a beat.");
  back.choose(1);
  assert.equal(back.view().done, "You picked Placeholder beat 1");
  assert.equal(back.$("pick-say").textContent, "");
  back.$("pick-change").fire("click");
  assert.deepEqual([back.view().done, back.view().marked.includes(true), store.map.has("tbz.pick")], [null, false, false]);
  assert.equal(back.tab.focused, back.$("beats-title"), "Change my pick goes back to the beats");
  assert.equal(back.tab.scrolledTo, back.$("beats"));

  // The pick never leaves the device: the only requests either page made were reads of the beats.
  for (const tab of [page.tab, back.tab]) assert.deepEqual(tab.requests, ["GET /api/beats"]);
  const source = read("js/select.js") + read("js/pick.js");
  assert.ok(!/method:|body:|POST|\/api\/(?!beats\b)|cookie|email/i.test(source), "the page sends nothing: no write, no sign-up, no email");
  assert.equal([...source.matchAll(/api\("([^"]+)"/g)].map((m) => m[1]).join(), "/api/beats");
});

test("select page: a pick made, changed or taken back in a second tab shows in the first", async (t) => {
  const store = memory();
  const first = await open(t, { store, answers: [BEATS] });
  const second = await open(t, { store, answers: [BEATS] });
  second.choose(3);
  assert.equal(first.view().done, null, "not until the browser tells the first tab");
  await first.storage();
  assert.equal(first.view().done, "You picked Placeholder beat 3");
  assert.deepEqual(first.view().pressed, [false, false, true, false]);
  assert.equal(first.tab.focused, null, "the first tab is not scrolled or refocused by it");
  second.choose(1);
  await first.storage();
  assert.equal(first.view().done, "You picked Placeholder beat 1");
  second.$("pick-change").fire("click");
  await first.storage(null); // storage cleared as a whole is read the same way
  assert.deepEqual([first.view().done, first.view().pressed.includes(true)], [null, false]);
  await first.storage("tbz.voter");
  assert.equal(first.view().done, null, "another key's change is not the pick's");
});

test("select page: a stored pick whose beat is no longer offered falls back to the unpicked state", async (t) => {
  const store = memory(new Map([["tbz.pick", "retired-beat"]]));
  const page = await open(t, { store, answers: [BEATS, BEATS.slice(0, 2)] });
  assert.deepEqual([page.view().done, page.view().pressed.includes(true), page.view().marked.includes(true)], [null, false, false]);
  page.choose(3);
  assert.equal(page.view().done, "You picked Placeholder beat 3");
  assert.equal(store.map.get("tbz.pick"), "placeholder-beat-3", "the next choice replaces it");
  // The picked beat leaves while the page is open (a page left open asks again when it is shown).
  const realNow = Date.now;
  Date.now = () => realNow() + BEATS_STALE_MS + 1000;
  try { await page.show(); } finally { Date.now = realNow; }
  assert.deepEqual(page.tab.requests, ["GET /api/beats", "GET /api/beats"]);
  assert.equal(page.rows().length, 2);
  assert.deepEqual([page.view().done, page.view().pressed.includes(true)], [null, false]);
  // Junk under the key is no pick either.
  const junk = await open(t, { store: memory(new Map([["tbz.pick", '{"slug":"placeholder-beat-1"}']])), answers: [BEATS] });
  assert.equal(junk.view().done, null);
});

test("select page: one beat plays at a time, and choosing does not stop the one that is playing", async (t) => {
  const page = await open(t, { answers: [BEATS] });
  page.play(1);
  assert.deepEqual(page.view().audio, ["playing", "idle", "idle", "idle"]);
  assert.equal(page.row(1).find("play").getAttribute("aria-label"), "Pause Placeholder beat 1");
  page.choose(3);
  assert.deepEqual(page.view().audio, ["playing", "idle", "idle", "idle"], "still playing after the pick");
  assert.equal(page.tab.audios[0].paused, false);
  assert.equal(page.view().done, "You picked Placeholder beat 3");
  page.play(2);
  assert.deepEqual(page.view().audio, ["idle", "playing", "idle", "idle"], "starting another stops the first");
  assert.equal(page.tab.audios.length, 1, "there is one audio element for the whole page");
  assert.equal(page.tab.audios[0].src, BEATS[1].audio_url);
  page.play(2);
  assert.deepEqual(page.view().audio, ["idle", "paused", "idle", "idle"]);
  page.$("pick-change").fire("click");
  page.play(2);
  assert.deepEqual(page.view().audio, ["idle", "playing", "idle", "idle"], "and taking the pick back does not touch it either");
  // Audio that fails says so on its row, and play tries again.
  page.tab.audios[0].error = { code: 4 };
  page.tab.audios[0].emit("error");
  assert.equal(page.view().audio[1], "error");
  assert.equal(page.row(2).find("audio-note").textContent, "This beat did not load. Tap play to try again.");
  page.tab.audios[0].error = null;
  page.play(2);
  assert.deepEqual([page.view().audio[1], page.row(2).find("audio-note").textContent], ["playing", ""]);
});

test("select page: waiting, failed and empty are each shown; Try again loads the beats", async (t) => {
  const offline = Object.assign(new TypeError("fetch failed"));
  const page = await open(t, { answers: [offline, offline, BEATS] });
  assert.deepEqual([page.$("beats-loading").hidden, page.$("beats-error").hidden, page.rows().length], [true, false, 0]);
  assert.equal(page.$("beats-error-text").textContent, "The beats did not load. No connection. Check your signal and try again.");
  assert.deepEqual([page.$("beats-retry").disabled, page.$("beats-retry").textContent], [false, "Try again"]);
  page.$("beats-retry").fire("click");
  assert.deepEqual([page.$("beats-retry").disabled, page.$("beats-retry").textContent, page.$("beats-error").hidden], [true, "Loading…", false], "the button shows it is working, and stays where the keyboard is");
  await flush();
  assert.deepEqual([page.$("beats-retry").disabled, page.$("beats-retry").textContent, page.$("beats-error").hidden], [false, "Try again", false], "a second failure can be tried again");
  page.$("beats-retry").fire("click");
  await flush();
  assert.deepEqual([page.$("beats-error").hidden, page.$("beats-loading").hidden, page.rows().length], [true, true, 4]);

  // No beats yet (production, until the real ones are loaded): the empty state, in the page's voice.
  const empty = await open(t, { store: memory(new Map([["tbz.pick", "placeholder-beat-1"]])), answers: [[]] });
  assert.deepEqual([empty.$("beats-empty").hidden, empty.$("beats-loading").hidden, empty.$("beats-error").hidden, empty.rows().length, empty.view().done], [false, true, true, 0, null]);
  assert.equal(empty.$("beats-list").getAttribute("aria-busy"), null);
  const html = read("select.html");
  const panel = /<div id="tbz-beats-empty" class="empty" hidden>([\s\S]*?)<\/div>/.exec(html)[1];
  assert.match(panel, /<p class="empty-title">The beats land here soon<\/p>/);
  assert.match(/<div id="tbz-empty" class="empty" hidden>([\s\S]*?)<\/div>/.exec(read("index.html"))[1], /<p class="empty-title">The tracks land here soon<\/p>/, "modelled on the voting page's own");
  assert.match(html, /<p id="tbz-beats-loading" class="list-note" role="status">Loading the beats…<\/p>/);
  assert.match(html, /<div id="tbz-beats-error" class="list-note" role="alert" hidden>/);
  assert.match(html, /<noscript><p class="list-note">This page needs JavaScript/);
});

test("select page: a credit shows only when a beat has one; a browser that cannot keep the pick says so", async (t) => {
  const credited = [
    { ...BEATS[0], credit_label: "Kay Beats", credit_url: "https://example.com/kay" },
    { ...BEATS[1], credit_label: "The Engineer", credit_url: null },
    { ...BEATS[2], name: "A very long beat name that has to wrap on a small phone without pushing the page sideways" },
  ];
  const page = await open(t, { store: broken, answers: [credited] });
  const credits = page.rows().map((r) => r.find("credit"));
  assert.deepEqual(credits.map((c) => [c.hidden, c.textContent]), [[false, "By Kay Beats"], [false, "By The Engineer"], [true, ""]]);
  assert.deepEqual(credits.map((c) => c.all("a").map((a) => a.getAttribute("href"))), [["https://example.com/kay"], [], []]);
  page.choose(3);
  assert.equal(page.view().done, `You picked ${credited[2].name}`, "the pick still shows for this visit");
  assert.equal(page.$("picked-note").hidden, false, "with a line saying it will not be remembered");
});

// ── The markup, the copy and the styles, read from what ships ────────────────────────────────
test("select page: same look and the same policy as the voting page; noindex; not linked from the vote", () => {
  const html = read("select.html");
  const index = read("index.html");
  assert.doesNotMatch(html, /name="robots"/, "the real copy landed 3 Oct 2026: the page is no longer noindex, and must not become so again (RUNBOOK.md, The select page)");
  const head = (page, re) => [...page.matchAll(re)].map((m) => m[0]);
  for (const re of [/<link rel="stylesheet"[^>]*>/g, /<link rel="preload"[^>]*as="font"[^>]*>/g, /<link rel="(?:icon|apple-touch-icon)"[^>]*>/g, /<meta name="(?:viewport|theme-color|color-scheme)"[^>]*>/g]) {
    assert.deepEqual(head(html, re), head(index, re), `the same ${re.source} as the voting page`);
  }
  assert.equal(/<header class="top">[\s\S]*?<\/header>/.exec(html)[0], /<header class="top">[\s\S]*?<\/header>/.exec(index)[0], "the same masthead: the logo and the slogan");
  assert.deepEqual([...html.matchAll(/<script[^>]*>/g)].map((m) => m[0]), ['<script type="module" src="/js/select.js">'], "one script, its own file");
  assert.ok(!/<style\b|\sstyle="|\son[a-z]+="/.test(html), "nothing inline: the page's policy is default-src 'self'");
  assert.match(read("_headers"), /^\/\*\n(?:  .+\n)*  Content-Security-Policy: default-src 'self';/m, "and that policy covers every page, /select included");
  // The player is the voting page's own, not a copy of it.
  assert.match(read("js/select.js"), /import \{ createControls, createPlayer \} from "\.\/player\.js";/);
  assert.match(read("js/app.js"), /import \{ createControls, createPlayer \} from "\.\/player\.js";/);
  for (const file of ["js/select.js", "js/app.js"]) assert.ok(!/new Audio\(|class: "scrub|class: "play"/.test(read(file)), `${file} builds no player of its own`);
  assert.match(read("js/select.js"), /artist: "Top Barz" \}\)/, "a phone's lock screen names the beat");
  // The voting page does not link to it, load it, or mention it.
  assert.ok(!/select|beat/i.test(index), "index.html does not know about /select");
  assert.ok(!/select/i.test(read("privacy.html")));
  for (const file of ["js/app.js", "js/gate.js", "js/comments.js", "js/gallery.js", "js/api.js", "js/logic.js"]) assert.ok(!/["'`/]select\b|select-copy|pick\.js/.test(read(file)), `${file} does not reach the select page`);
});

test("select page: the copy lives in one object, and nowhere else; it is Top Barz's real copy, not a placeholder", () => {
  assert.deepEqual(Object.keys(COPY), ["headline", "intro", "listTitle", "choose", "chosen", "pickedTitle", "done", "change", "linksTitle", "links"]);
  for (const key of ["headline", "listTitle", "choose", "chosen", "pickedTitle", "done", "change", "linksTitle"]) assert.ok(typeof COPY[key] === "string" && COPY[key].trim(), `COPY.${key}`);
  assert.ok(COPY.pickedTitle.includes("{name}"), "the done state names the beat");
  // The intro Scooter sent on 3 Oct 2026, with the three names linked (he may swap the two engineer names later).
  assert.ok(Array.isArray(COPY.intro) && COPY.intro.length >= 3, "the intro is parts: words and linked names");
  assert.equal(introText(COPY.intro), "These are beats from professional engineers, Ayake and 4stro, who have engineered hundreds of sessions with some of your favorite notable artists. This is made possible by our partnership with Studio404 located in Brooklyn, NY.");
  assert.deepEqual(introParts(COPY.intro).filter((p) => p.url).map((p) => p.url), ["https://instagram.com/ayake.io", "https://instagram.com/4stro.naut", "https://studio404.nyc/"]);
  assert.ok(COPY.intro.filter((p) => typeof p === "object").every((p) => safeLinkUrl(p.url)), "every linked name in the intro has an https address");
  assert.equal(COPY.linksTitle, "Engineers and studio");
  assert.ok(COPY.links.length === 3 && COPY.links.every((l) => l.label && safeLinkUrl(l.url)), "the three credits are links, each https");
  for (const text of ["placeholder", "goes here"]) {
    assert.ok(!JSON.stringify(COPY).toLowerCase().includes(text), `no "${text}" is left in the copy`);
  }
  const html = read("select.html");
  const js = read("js/select.js") + read("js/pick.js");
  for (const key of ["headline", "listTitle", "choose", "chosen", "done", "change", "linksTitle"]) {
    assert.ok(!html.includes(COPY[key]) && !js.includes(`"${COPY[key]}"`), `"${COPY[key]}" is written once, in select-copy.js`);
  }
  assert.ok(!html.includes("Ayake") && !js.includes("Ayake"), "the intro is written once, in select-copy.js");
  for (const id of ["tbz-select-headline", "tbz-select-intro", "tbz-beats-title", "tbz-picked-title", "tbz-picked-line", "tbz-pick-change", "tbz-links-title", "tbz-links-list"]) {
    assert.match(html, new RegExp(`<([a-z0-9]+)\\b[^>]*\\bid="${id}"[^>]*></\\1>`), `#${id} is empty in the page: its words come from the copy`);
  }
  assert.equal([...read("js/select.js").matchAll(/from "\.\/select-copy\.js"/g)].length, 1);
});

test("select page: its styles are tokens, thumb-sized, and hold at 320 px with a long beat name", () => {
  const css = read("css/site.css");
  const rule = (selector) => new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  for (const sel of [".page-title", ".picked", ".picked h2", ".beat.is-picked", ".credit", ".pick[aria-pressed=\"true\"]", ".pick[aria-pressed=\"true\"]:active:not(:disabled)", ".credits"]) assert.ok(rule(sel), `${sel} is styled`);
  assert.match(rule(".chip"), /min-height: var\(--tap\);/, "Choose this beat is a thumb-sized target");
  assert.match(rule(".btn-small"), /min-height: var\(--tap\);/, "so are Change my pick and Try again");
  assert.match(rule(".pick[aria-pressed=\"true\"]"), /background: var\(--color-accent\); color: var\(--color-accent-ink\);/, "the picked button is filled");
  assert.match(rule(".pick[aria-pressed=\"true\"] .ico"), /display: block;/, "and carries a tick, so it is not colour alone");
  assert.match(css, /\nh1, h2, h3 \{ font-weight: 400; overflow-wrap: anywhere; min-width: 0; \}/, "a long beat name wraps");
  assert.match(rule(".track-main"), /min-width: 0;/);
  assert.match(rule(".credit"), /overflow-wrap: anywhere;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ animation: none !important; transition: none !important; scroll-behavior: auto !important; \}/);
  assert.match(read("js/select.js"), /const scrollBehavior = \(\) => \(reducedMotion\(\) \? "auto" : "smooth"\);/, "and the page's own scrolling respects reduced motion");
  assert.equal([...read("js/select.js").matchAll(/scrollIntoView\(\{ behavior: scrollBehavior\(\), block: "start" \}\)/g)].length, [...read("js/select.js").matchAll(/scrollIntoView\(/g)].length);
});
