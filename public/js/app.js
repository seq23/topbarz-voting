// The voting page. Reads /api/state every few seconds, draws the tracks, and sends likes,
// comments and shares. The API it calls is described in RUNBOOK.md.
import { api, forgetVoter, keepOwn, loadOwn, loadVoter, OWN_KEY, ownCounts, saveVoter, VOTER_KEY } from "./api.js";
import { createThread } from "./comments.js";
import { $, h, icon, reducedMotion } from "./dom.js";
import { createGallery } from "./gallery.js";
import { createGate } from "./gate.js";
import {
  countdownSpoken, detectPlatform, formatClock, formatCountdown, formatCount, formatEndsLine, holdFrom,
  LIKE_WAIT_MS, likeInitial, likeReduce, likeRequest, likeView, nextPollDelay, plural,
  rulesEndLine, safeMediaUrl, serverNow, serverTimeOf, shareMessage, slugFromHash, smsHref, syncClock, trackLink, voterRecord,
} from "./logic.js";
import { createPlayer } from "./player.js";

const els = {
  status: $("tbz-status"),
  vote: $("tbz-vote"),
  windowWord: $("tbz-window-word"),
  ends: $("tbz-ends"),
  countdownRow: $("tbz-countdown-row"),
  countdown: $("tbz-countdown"),
  countdownSpoken: $("tbz-countdown-spoken"),
  closedHero: $("tbz-closed-hero"),
  ruleEnds: $("tbz-rule-ends"),
  tracks: $("tbz-tracks"),
  tracksTitle: $("tbz-tracks-title"),
  list: $("tbz-list"),
  loading: $("tbz-loading"),
  loadError: $("tbz-load-error"),
  loadErrorText: $("tbz-load-error-text"),
  loadRetry: $("tbz-load-retry"),
  empty: $("tbz-empty"),
  closedNote: $("tbz-closed-note"),
  offNote: $("tbz-off-note"),
  linkNote: $("tbz-link-note"),
  who: $("tbz-who"),
  whoName: $("tbz-who-name"),
  whoForget: $("tbz-who-forget"),
};

const app = {
  loaded: false, // a /api/state has been drawn
  failures: 0, // polls failed in a row
  clock: null, // the server's clock (logic.js, syncClock)
  endMs: NaN,
  serverClosed: false,
  closedHold: 0, // server time before which a cached "open" is not believed (after a 403 voting_closed)
  closed: false,
  gateOn: true,
  codesOn: false,
  resumed: false,
  giphyOn: false,
  voter: loadVoter(), // { token, first_name } | null
  meLoaded: false,
  meLoading: false,
  liked: new Set(),
  cards: new Map(), // slug → card
  linkApplied: null,
  platform: detectPlatform(navigator),
};

const mono = () => performance.now();
const now = () => serverNow(app.clock, mono());
const scrollBehavior = () => (reducedMotion() ? "auto" : "smooth");

// ── The line at the bottom of the screen: offline, slow, back ────────────────────────────────
let statusTimer = null;
function setStatus(kind) {
  clearTimeout(statusTimer);
  const text = {
    offline: "You are offline. Likes and comments will work again when your signal is back.",
    slow: "Connection is slow. Counts may be behind. Trying again…",
    back: "Back online.",
    out: "Signed out on this device. Your votes still count.",
    late: "Voting closed before that went through, so it was not counted.",
  }[kind] || "";
  els.status.textContent = text;
  els.status.dataset.kind = kind || "";
  els.status.hidden = !text;
  if (kind === "back" || kind === "out") statusTimer = setTimeout(() => setStatus(null), 3000);
  if (kind === "late") statusTimer = setTimeout(() => setStatus(null), 7000);
}

// ── The player ───────────────────────────────────────────────────────────────────────────────
const player = createPlayer((slug, audio) => {
  const card = app.cards.get(slug);
  if (!card) return;
  card.audio = audio;
  card.renderAudio();
});

// ── The voter ────────────────────────────────────────────────────────────────────────────────
function renderWho() {
  els.who.hidden = !app.voter;
  els.whoName.textContent = app.voter?.first_name || "a saved voter";
}

function setLiked(slugs) {
  app.liked = new Set(Array.isArray(slugs) ? slugs : []);
  for (const card of app.cards.values()) {
    card.like = likeReduce(card.like, { type: "me", liked: app.liked.has(card.slug) });
    card.renderLike();
  }
}

function signOut() {
  forgetVoter();
  app.voter = null;
  app.meLoaded = false;
  app.liked = new Set();
  for (const card of app.cards.values()) {
    card.like = { ...likeInitial(card.like.serverCount, false), holdUntil: card.like.holdUntil };
    card.renderLike();
  }
  renderWho();
}

async function loadMe() {
  const voter = app.voter;
  if (!voter || app.meLoading) return;
  app.meLoading = true;
  try {
    const { data } = await api("/api/me", { token: voter.token });
    if (app.voter !== voter) return;
    app.meLoaded = true;
    const first = data.voter?.first_name;
    if (typeof first === "string" && first && first !== voter.first_name) {
      app.voter = { token: voter.token, first_name: first.slice(0, 30) };
      saveVoter(app.voter);
    }
    setLiked(data.liked);
    renderWho();
  } catch (err) {
    if (err.status === 401 && app.voter === voter) signOut();
    // anything else: tried again after the next good poll
  } finally {
    app.meLoading = false;
  }
}

function onVoter(response) {
  const rec = voterRecord(response);
  if (!rec) return;
  app.voter = rec;
  app.meLoaded = true;
  saveVoter(rec);
  setLiked(response.liked);
  renderWho();
}

// ── What this device just changed ────────────────────────────────────────────────────────────
// The server's own answer to this voter's like or comment is kept for a minute (api.js, keepOwn;
// logic.js, rememberOwn), so a refresh or a second tab inside the server's few seconds of cache
// shows the count the voter just saw, never the one from before it.
// A card takes the remembered counts while the state it was drawn from is older than they are.
function applyOwn(card, generatedAt, stored = loadOwn()) {
  const own = ownCounts(stored, card.slug, generatedAt);
  if (!own) return;
  if (own.likes !== null && !card.like.inflight) card.like = { ...card.like, serverCount: own.likes, holdUntil: Math.max(card.like.holdUntil, own.until) };
  if (own.comments !== null) { card.commentCount = own.comments; card.commentsHold = Math.max(card.commentsHold, own.until); }
}

// ── Likes ────────────────────────────────────────────────────────────────────────────────────
// One request per track at a time. Taps while it is on the wire only change what is wanted; when
// the answer lands, a newer wish goes out. So rapid taps cannot double-vote or stick the button.
async function pumpLike(card) {
  const req = likeRequest(card.like);
  const voter = app.voter;
  if (!req) return { ok: true };
  if (!voter) {
    card.like = likeReduce(card.like, { type: "failed", message: "" });
    card.renderLike();
    return { ok: false };
  }
  card.like = likeReduce(card.like, { type: "sent" });
  card.renderLike();
  try {
    const { data, date } = await api("/api/likes", { method: "POST", token: voter.token, body: { track: card.slug, liked: req.liked } });
    const liked = data.liked === true;
    card.like = likeReduce(card.like, { type: "confirmed", liked, likes: data.likes, holdUntil: holdFrom(date, now()) });
    if (liked) app.liked.add(card.slug); else app.liked.delete(card.slug);
    keepOwn(card.slug, { likes: card.like.serverCount }, card.like.holdUntil);
    card.renderLike();
    return pumpLike(card);
  } catch (err) {
    card.like = likeReduce(card.like, { type: "failed", message: err.message });
    card.renderLike();
    if (err.status === 401) {
      signOut();
      card.say("Your saved sign-in stopped working. Confirm your details to like this track.", "error");
      gate.open({ type: "like", slug: card.slug, liked: req.liked }, card.likeBtn, "Your saved sign-in stopped working. Enter your details again to count this like.");
    } else if (err.code === "voting_closed") {
      votingClosedByServer();
    } else if (err.code === "unknown_track") {
      card.say("This track is no longer in the vote.", "error");
      poll();
    } else {
      card.say(`Like not saved. ${err.message}`, "error");
      app.meLoaded = false; // the request may have landed: re-read the voter's likes after the next poll
    }
    return { ok: false };
  }
}

function tapLike(card) {
  if (app.closed || !app.gateOn) return;
  if (!app.voter) { gate.open({ type: "like", slug: card.slug, liked: true }, card.likeBtn); return; }
  card.say("");
  card.like = likeReduce(card.like, { type: "tap" });
  card.renderLike();
  pumpLike(card);
}

// ── Share ────────────────────────────────────────────────────────────────────────────────────
function closeShare(card) {
  card.sharePanel.hidden = true;
  card.shareBtn.setAttribute("aria-expanded", "false");
}

async function copyLink(card) {
  const link = card.shareLink.value;
  card.copyBtn.disabled = true;
  card.copyText.textContent = "Copying…";
  let ok = false;
  try {
    await navigator.clipboard.writeText(link);
    ok = true;
  } catch {
    try { card.shareLink.focus(); card.shareLink.select(); ok = document.execCommand("copy"); } catch {}
  }
  card.copyBtn.disabled = false;
  clearTimeout(card.copyTimer);
  if (ok) {
    card.copyBtn.dataset.state = "done";
    card.copyText.textContent = "Link copied";
    card.shareNote.textContent = "Link copied. Paste it into a text or a DM.";
    card.copyTimer = setTimeout(() => { card.copyBtn.dataset.state = ""; card.copyText.textContent = "Copy link"; }, 2500);
  } else {
    card.copyBtn.dataset.state = "";
    card.copyText.textContent = "Try again";
    card.shareLink.focus();
    card.shareLink.select();
    card.shareNote.textContent = "Copy did not work. The link is selected: copy it from here.";
  }
}

function openShare(card) {
  const link = trackLink(location.origin, card.slug);
  const href = smsHref(app.platform, shareMessage(card.track.label, link));
  card.shareLink.value = link;
  card.sharePanel.hidden = false;
  card.shareBtn.setAttribute("aria-expanded", "true");
  card.copyBtn.dataset.state = "";
  card.copyText.textContent = "Copy link";
  if (href) {
    // A phone: open the text composer with the message written.
    card.smsBtn.href = href;
    card.smsBtn.hidden = false;
    card.shareNote.textContent = "Opening your messages…";
    try { location.href = href; } catch {}
    setTimeout(() => {
      if (!card.sharePanel.hidden && card.copyBtn.dataset.state !== "done") card.shareNote.textContent = "Your text is ready to send. If Messages did not open, tap Open Messages, or copy the link.";
    }, 1500);
  } else {
    // A desktop: copy the link.
    card.smsBtn.hidden = true;
    copyLink(card);
  }
}

function tapShare(card) {
  if (app.closed || !app.gateOn) return;
  if (!card.sharePanel.hidden) { closeShare(card); return; }
  if (!app.voter) { gate.open({ type: "share", slug: card.slug }, card.shareBtn); return; }
  openShare(card);
}

// ── The gate ─────────────────────────────────────────────────────────────────────────────────
const gate = createGate({
  onVoter,
  codesOn: () => app.codesOn,
  openerFor(action) {
    const card = app.cards.get(action?.slug);
    return action?.type === "share" ? card?.shareBtn : card?.likeBtn;
  },
  heldLine(action) {
    const label = app.cards.get(action?.slug)?.track.label;
    if (!label) return "Then your likes and comments are one tap.";
    if (action.type === "like") return `Your like for ${label} counts the moment you finish.`;
    if (action.type === "comment") return `Your comment for ${label} posts the moment you finish.`;
    return `Then you can share the track by ${label}.`;
  },
  async runHeld(action) {
    const card = app.cards.get(action.slug);
    if (!card) return { ok: true, done: "You’re in" };
    if (app.closed) { setStatus("late"); return { ok: false }; } // nothing is dropped in silence
    if (action.type === "like") {
      card.say("");
      card.like = likeReduce(card.like, { type: "want", liked: action.liked !== false });
      card.renderLike();
      const result = await pumpLike(card);
      return result.ok ? { ok: true, done: "Vote counted" } : { ok: false };
    }
    if (action.type === "comment") {
      const result = await card.thread.post(action.payload);
      return result.ok ? { ok: true, done: "Comment posted" } : { ok: false };
    }
    return { ok: true, done: "You’re in", after: () => openShare(card) };
  },
});

// What a thread needs from the page.
const threadContext = {
  api,
  token: () => app.voter?.token || null,
  giphyOn: () => app.giphyOn,
  now,
  requestGate: (action, opener, note) => gate.open(action, opener, note),
  onCount(slug, count, holdUntil) {
    const card = app.cards.get(slug);
    if (!card) return;
    card.commentCount = count;
    card.commentsHold = Math.max(card.commentsHold, holdUntil);
    keepOwn(slug, { comments: count }, holdUntil);
    card.renderCounts();
  },
  onClosed: () => votingClosedByServer(),
  onAuthLost: () => signOut(),
};

// ── A track card ─────────────────────────────────────────────────────────────────────────────
function createCard(track) {
  const slug = track.slug;
  const card = {
    slug, track,
    like: likeInitial(track.likes, app.liked.has(slug)),
    commentCount: Number(track.comments) || 0,
    commentsHold: 0,
    audio: { status: "idle", slow: false, time: 0, duration: (Number(track.duration_ms) || 0) / 1000 },
    copyTimer: null,
  };
  const by = () => `the track by ${card.track.label}`;

  const playBtn = h("button", { type: "button", class: "play" }, icon("play"), icon("pause"), h("span", { class: "spinner", "aria-hidden": "true" }));
  const title = h("h3", { class: "track-label", text: track.label });
  const tag = h("span", { class: "linked-tag", hidden: true, text: "Shared with you" });
  const seek = h("input", { type: "range", class: "scrub-input", min: 0, max: 1000, step: 1, value: 0, disabled: true });
  const scrub = h("div", { class: "scrub" }, h("div", { class: "scrub-bars", "aria-hidden": "true" }), seek);
  const time = h("span", { class: "time" });
  const audioNote = h("p", { class: "audio-note", role: "status" });

  const likeCount = h("span", { class: "n" });
  const likeBtn = h("button", { type: "button", class: "chip like", "aria-pressed": "false" }, icon("heart"), h("span", { class: "spinner", "aria-hidden": "true" }), likeCount);
  const talkCount = h("span", { class: "n" });
  const talkBtn = h("button", { type: "button", class: "chip talk", "aria-expanded": "false" }, icon("comment"), talkCount);
  const shareBtn = h("button", { type: "button", class: "chip share", "aria-expanded": "false" }, icon("share"), h("span", { text: "SHARE" }));
  const msg = h("p", { class: "track-msg", role: "status" });

  const shareNote = h("p", { class: "share-note", role: "status" });
  const shareLink = h("input", { type: "text", class: "share-link", readonly: true });
  const smsBtn = h("a", { class: "btn btn-small", hidden: true, text: "Open Messages" });
  const copyText = h("span", { text: "Copy link" });
  const copyBtn = h("button", { type: "button", class: "btn btn-small btn-ghost copy" }, icon("check"), copyText);
  const shareClose = h("button", { type: "button", class: "panel-close", "aria-label": "Close share" }, icon("close"));
  const sharePanel = h("div", { class: "share-panel", hidden: true }, shareClose, shareNote, shareLink, h("div", { class: "share-actions" }, smsBtn, copyBtn));

  const thread = createThread(slug, track.label, threadContext);
  talkBtn.setAttribute("aria-controls", thread.id);

  const el = h("article", { class: "track", id: `tbz-track-${slug}`, "data-audio": "idle" },
    h("div", { class: "track-top" }, playBtn,
      h("div", { class: "track-main" },
        h("div", { class: "track-title" }, title, tag),
        h("div", { class: "scrub-row" }, scrub, time),
        audioNote)),
    h("div", { class: "actions" }, likeBtn, talkBtn, shareBtn),
    msg, sharePanel, thread.el);

  Object.assign(card, { el, likeBtn, shareBtn, sharePanel, shareNote, shareLink, smsBtn, copyBtn, copyText, thread, tag });

  // Audio
  const audioTrack = () => ({ slug, url: safeMediaUrl(card.track.audio_url), hint: card.audio.duration, title: card.track.label });
  const togglePlay = () => {
    const t = audioTrack();
    if (!t.url) { audioNote.textContent = "This track has no audio yet."; return; }
    player.toggle(t);
  };
  playBtn.addEventListener("click", togglePlay);
  let dragging = false;
  const fractionAt = (ev) => {
    const box = scrub.getBoundingClientRect();
    return box.width ? Math.min(1, Math.max(0, (ev.clientX - box.left) / box.width)) : 0;
  };
  scrub.addEventListener("pointerdown", (ev) => {
    if (ev.button > 0) return;
    if (!player.isCurrent(slug)) { togglePlay(); return; } // a tap on the bar of a resting track plays it
    dragging = true;
    try { scrub.setPointerCapture(ev.pointerId); } catch {}
    player.seek(slug, fractionAt(ev));
  });
  scrub.addEventListener("pointermove", (ev) => { if (dragging) player.seek(slug, fractionAt(ev)); });
  const endDrag = () => { dragging = false; };
  scrub.addEventListener("pointerup", endDrag);
  scrub.addEventListener("pointercancel", endDrag);
  seek.addEventListener("input", () => player.seek(slug, Number(seek.value) / 1000));

  card.renderAudio = () => {
    const a = card.audio;
    const live = a.status === "playing" || a.status === "loading" || a.status === "buffering";
    el.dataset.audio = a.status;
    playBtn.setAttribute("aria-label", `${live ? "Pause" : "Play"} ${by()}`);
    const fraction = a.duration ? Math.min(1, a.time / a.duration) : 0;
    scrub.style.setProperty("--p", `${(fraction * 100).toFixed(2)}%`);
    if (!dragging) seek.value = String(Math.round(fraction * 1000));
    seek.disabled = !player.isCurrent(slug);
    seek.setAttribute("aria-label", `Position in ${by()}`);
    seek.setAttribute("aria-valuetext", `${formatClock(a.time)} of ${formatClock(a.duration)}`);
    time.textContent = `${formatClock(a.time)} / ${formatClock(a.duration)}`;
    audioNote.textContent =
      a.status === "error" ? "This track did not load. Tap play to try again."
      : a.status === "loading" ? (a.slow ? "Still loading. Your connection is slow." : "Loading…")
      : a.status === "buffering" ? (a.slow ? "Still buffering. Your connection is slow." : "Buffering…")
      : "";
  };

  // Like, comments, share
  let msgTimer = null;
  card.say = (text, kind = "") => {
    clearTimeout(msgTimer);
    msg.textContent = text || "";
    msg.dataset.kind = kind;
    if (text) msgTimer = setTimeout(() => { msg.textContent = ""; }, 9000);
  };

  // Waiting is shown, not hidden: a like still on the wire after LIKE_WAIT_MS turns its heart
  // into a spinner (and says so to a screen reader) until the server has answered.
  let waitTimer = null;
  const showWaiting = (on) => {
    likeBtn.classList.toggle("is-waiting", on);
    if (on) likeBtn.setAttribute("aria-busy", "true"); else likeBtn.removeAttribute("aria-busy");
  };
  card.renderLike = () => {
    const view = likeView(card.like);
    const off = app.closed || !app.gateOn;
    likeBtn.setAttribute("aria-pressed", String(view.liked));
    likeBtn.classList.toggle("is-busy", card.like.inflight);
    if (card.like.inflight && waitTimer === null) waitTimer = setTimeout(() => showWaiting(card.like.inflight), LIKE_WAIT_MS);
    if (!card.like.inflight) { clearTimeout(waitTimer); waitTimer = null; showWaiting(false); }
    likeBtn.disabled = off;
    likeCount.textContent = formatCount(view.count);
    likeBtn.setAttribute("aria-label", `${app.closed ? "Voting closed. " : ""}Like ${by()}. ${plural(view.count, "like")}${view.liked ? ". You like it" : ""}${card.like.inflight ? ". Saving" : ""}`);
  };

  card.renderCounts = () => {
    const off = app.closed || !app.gateOn;
    talkCount.textContent = formatCount(card.commentCount);
    talkBtn.setAttribute("aria-label", `${plural(card.commentCount, "comment")} on ${by()}. ${thread.isOpen() ? "Hide" : "Show"} comments`);
    shareBtn.disabled = off;
    shareBtn.setAttribute("aria-label", `${app.closed ? "Voting closed. " : ""}Share ${by()}`);
    shareLink.setAttribute("aria-label", `Link to ${by()}`);
    if (off) closeShare(card);
  };

  likeBtn.addEventListener("click", () => tapLike(card));
  shareBtn.addEventListener("click", () => tapShare(card));
  copyBtn.addEventListener("click", () => copyLink(card));
  shareClose.addEventListener("click", () => { closeShare(card); shareBtn.focus(); });
  shareLink.addEventListener("focus", () => shareLink.select());
  talkBtn.addEventListener("click", () => {
    const open = thread.toggle();
    talkBtn.setAttribute("aria-expanded", String(open));
    card.renderCounts();
  });

  // New numbers from /api/state. `generatedAt` is the server time that answer was built.
  card.update = (next, generatedAt, stored) => {
    card.track = next;
    if (title.textContent !== next.label) title.textContent = next.label;
    if (!player.isCurrent(slug)) card.audio.duration = (Number(next.duration_ms) || 0) / 1000;
    applyOwn(card, generatedAt, stored);
    card.like = likeReduce(card.like, { type: "poll", likes: next.likes, generatedAt });
    const fresh = generatedAt >= card.commentsHold;
    if (fresh) card.commentCount = Number(next.comments) || 0;
    card.renderAudio();
    card.renderLike();
    card.renderCounts();
    thread.sync(fresh ? card.commentCount : NaN, app.closed);
  };

  card.renderAudio();
  card.renderLike();
  card.renderCounts();
  return card;
}

function renderTracks(tracks, generatedAt) {
  const seen = new Set();
  const stored = loadOwn(); // read once per state, not once per card
  tracks.forEach((track, i) => {
    if (typeof track?.slug !== "string" || seen.has(track.slug)) return;
    seen.add(track.slug);
    let card = app.cards.get(track.slug);
    if (!card) { card = createCard(track); app.cards.set(track.slug, card); }
    card.update(track, generatedAt, stored);
    if (els.list.children[i] !== card.el) els.list.insertBefore(card.el, els.list.children[i] || null);
  });
  for (const [slug, card] of app.cards) {
    if (seen.has(slug)) continue;
    player.drop(slug);
    card.el.remove();
    app.cards.delete(slug);
  }
  const none = app.cards.size === 0;
  els.loading.hidden = true;
  els.loadError.hidden = true;
  els.list.removeAttribute("aria-busy");
  els.empty.hidden = !none;
  els.vote.hidden = none;
}

// ── Deep links: /#<slug> scrolls to that card and marks it ───────────────────────────────────
function applyDeepLink() {
  const slug = slugFromHash(location.hash);
  for (const card of app.cards.values()) {
    const linked = card.slug === slug;
    card.el.classList.toggle("is-linked", linked);
    card.tag.hidden = !linked;
  }
  const card = slug ? app.cards.get(slug) : null;
  els.linkNote.hidden = !(slug && app.loaded && !card && app.cards.size > 0);
  if (!card || app.linkApplied === slug) return;
  app.linkApplied = slug;
  requestAnimationFrame(() => card.el.scrollIntoView({ behavior: scrollBehavior(), block: "start" }));
}

// ── The voting window ────────────────────────────────────────────────────────────────────────
function setClosed(closed) {
  app.closed = closed;
  document.body.dataset.voting = closed ? "closed" : "open";
  els.windowWord.textContent = closed ? "Voting ended" : "Voting ends";
  els.countdownRow.hidden = closed;
  els.closedHero.hidden = !closed;
  els.closedNote.hidden = !closed;
  els.vote.textContent = closed ? "LISTEN" : "VOTE";
  renderRuleEnds();
  for (const card of app.cards.values()) {
    card.renderLike();
    card.renderCounts();
    card.thread.sync(NaN, closed);
  }
}

// The rules' last line follows the window: it never promises an end that has passed.
function renderRuleEnds() {
  if (Number.isFinite(app.endMs)) els.ruleEnds.textContent = rulesEndLine(app.closed, formatEndsLine(app.endMs));
}

let spokenMinute = null;
function renderWindow() {
  const t = now();
  if (t === null || !Number.isFinite(app.endMs)) return;
  const left = app.endMs - t;
  const closed = app.serverClosed || left <= 0;
  if (closed !== app.closed) {
    setClosed(closed);
    if (closed && !app.serverClosed) poll(); // the countdown ran out: confirm with the server
  }
  if (closed) return;
  els.countdown.textContent = formatCountdown(left);
  const minute = Math.ceil(left / 60000);
  if (minute !== spokenMinute) { spokenMinute = minute; els.countdownSpoken.textContent = countdownSpoken(left); }
}

// A like or comment was refused with 403 voting_closed: the server's word is final.
function votingClosedByServer() {
  app.serverClosed = true;
  app.closedHold = (now() ?? 0) + 6000;
  renderWindow();
  if (!app.closed) setClosed(true);
}

// ── /api/state ───────────────────────────────────────────────────────────────────────────────
const gallery = createGallery();

function applyState(state, generatedAt) {
  app.loaded = true;
  app.endMs = Date.parse(state.voting_ends_at);
  app.serverClosed = state.closed === true || generatedAt < app.closedHold;
  app.gateOn = state.gate?.available !== false;
  app.giphyOn = state.giphy?.available === true;
  app.codesOn = state.verification?.available === true;
  if (Number.isFinite(app.endMs)) els.ends.textContent = formatEndsLine(app.endMs);
  renderRuleEnds();
  els.offNote.hidden = app.gateOn;
  gallery.update(state.photos);
  renderTracks(Array.isArray(state.tracks) ? state.tracks : [], generatedAt);
  renderWindow();
  applyDeepLink();
  // A voter who reloaded part-way through the code step goes straight back to it (once).
  if (!app.resumed) {
    app.resumed = true;
    if (!app.voter && app.gateOn && !app.closed) gate.resume();
  }
}

let pollTimer = null;
let polling = false;
let slowLoadTimer = null;

function schedule() {
  clearTimeout(pollTimer);
  if (document.hidden) return; // a hidden tab does not poll; it catches up when it is shown
  pollTimer = setTimeout(poll, nextPollDelay(app.failures));
}

async function poll() {
  if (polling) return;
  polling = true;
  clearTimeout(pollTimer);
  try {
    const { data, date } = await api("/api/state", { timeout: 10000 });
    const generatedAt = Date.parse(data.now);
    app.clock = syncClock(app.clock, serverTimeOf(data.now, date), mono());
    const wasFailing = app.failures > 0;
    app.failures = 0;
    clearTimeout(slowLoadTimer);
    applyState(data, Number.isFinite(generatedAt) ? generatedAt : now() ?? 0);
    if (wasFailing) setStatus("back");
    else if (els.status.dataset.kind === "offline" || els.status.dataset.kind === "slow") setStatus(null);
    if (app.voter && !app.meLoaded) loadMe();
  } catch (err) {
    app.failures += 1;
    if (!app.loaded) {
      els.loading.hidden = true;
      els.loadError.hidden = false;
      els.loadErrorText.textContent = `The tracks did not load. ${err.message}`;
      els.loadRetry.disabled = false;
      els.loadRetry.textContent = "Try again";
    }
    setStatus(navigator.onLine === false ? "offline" : "slow");
  } finally {
    polling = false;
    schedule();
  }
}

// ── Start ────────────────────────────────────────────────────────────────────────────────────
let tickTimer = null;
function startTick() { clearInterval(tickTimer); tickTimer = setInterval(renderWindow, 1000); }

document.addEventListener("visibilitychange", () => {
  if (document.hidden) { clearTimeout(pollTimer); clearInterval(tickTimer); return; }
  startTick();
  poll();
  if (app.voter) loadMe(); // a like made in another tab shows here too
});
window.addEventListener("pageshow", (ev) => { if (ev.persisted) poll(); });
window.addEventListener("online", () => poll());
window.addEventListener("offline", () => setStatus("offline"));
window.addEventListener("hashchange", () => { app.linkApplied = null; applyDeepLink(); });
window.addEventListener("storage", (ev) => {
  if (ev.key === OWN_KEY) {
    // This voter liked or commented in another tab: show that count here too, at once.
    const stored = loadOwn();
    for (const card of app.cards.values()) { applyOwn(card, 0, stored); card.renderLike(); card.renderCounts(); }
    return;
  }
  if (ev.key !== VOTER_KEY && ev.key !== null) return;
  // Another tab signed in or out.
  const stored = loadVoter();
  if (stored?.token === app.voter?.token) return;
  if (!stored) { signOut(); return; }
  app.voter = stored;
  app.meLoaded = false;
  renderWho();
  loadMe();
});

els.vote.addEventListener("click", (ev) => {
  ev.preventDefault();
  els.tracks.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  els.tracksTitle.focus({ preventScroll: true });
});
els.loadRetry.addEventListener("click", () => {
  els.loadRetry.disabled = true;
  els.loadRetry.textContent = "Loading…";
  poll();
});
els.whoForget.addEventListener("click", () => { signOut(); setStatus("out"); });

renderWho();
slowLoadTimer = setTimeout(() => { if (!app.loaded) els.loading.textContent = "Still loading the tracks. Your connection is slow."; }, 5000);
if (navigator.onLine === false) setStatus("offline");
startTick();
poll();
