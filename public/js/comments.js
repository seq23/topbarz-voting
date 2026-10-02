// A track's comments: the thread that opens under its card, the box to write one, and the GIF
// picker. Only a first name, the text, a GIF and a time are ever shown.
import { h, icon } from "./dom.js";
import { holdFrom, isLongComment, relativeTime, safeGifUrl } from "./logic.js";

const FIRST_PAGE = 5;
const MORE_PAGE = 10;
const MAX_CHARS = 500;
const GIF_DEBOUNCE_MS = 450;
const GIF_MAX = 12;

// Shared by every card on the page, so a search term (and trending) costs the Giphy budget once.
const gifCache = new Map();

let threadSeq = 0;

// ctx: { api, token(), closed(), giphyOn(), now(), requestGate(action, opener, note?),
//        onCount(slug, count, holdUntil), onClosed(), onAuthLost() }
export function createThread(slug, label, ctx) {
  const uid = `tbz-thread-${++threadSeq}`;
  const state = { open: false, loaded: false, loading: false, reloadAfter: false, comments: [], total: 0, hasMore: false, posting: false, gif: null, closed: false, askedFor: null, unfolded: new Set() };

  // ── Elements ───────────────────────────────────────────────────────────────────────────────
  const moreBtn = h("button", { type: "button", class: "link-btn thread-more", hidden: true, text: "Show earlier comments" });
  const list = h("ol", { class: "comments", "aria-label": `Comments on the track by ${label}` });
  const note = h("p", { class: "thread-note", role: "status" });
  const retryBtn = h("button", { type: "button", class: "link-btn", hidden: true, text: "Try again" });

  const input = h("textarea", { id: `${uid}-input`, class: "compose-input", rows: 2, maxlength: MAX_CHARS, placeholder: "Add a comment…", enterkeyhint: "send" });
  const counter = h("span", { class: "compose-count", "aria-live": "polite" });
  const gifBtn = h("button", { type: "button", class: "chip chip-quiet gif-toggle", hidden: true, "aria-expanded": "false", "aria-controls": `${uid}-gifs`, text: "GIF" });
  const postBtn = h("button", { type: "submit", class: "btn btn-small compose-post", text: "Post" });
  const chosenImg = h("img", { alt: "The GIF you picked", width: 80, height: 80 });
  const chosenRemove = h("button", { type: "button", class: "gif-remove", "aria-label": "Remove the GIF" }, icon("close"));
  const chosen = h("div", { class: "gif-chosen", hidden: true }, chosenImg, chosenRemove);
  const composeMsg = h("p", { class: "compose-msg", role: "status" });

  const gifSearch = h("input", { type: "search", class: "gif-search", placeholder: "Search GIFs", "aria-label": "Search GIFs", maxlength: 50, autocomplete: "off", enterkeyhint: "search" });
  const gifNote = h("p", { class: "gif-note", role: "status" });
  const gifRetry = h("button", { type: "button", class: "link-btn", hidden: true, text: "Try again" });
  const gifGrid = h("div", { class: "gif-grid" });
  const picker = h("div", { id: `${uid}-gifs`, class: "gif-picker", hidden: true, role: "group", "aria-label": "Pick a GIF" },
    gifSearch, h("div", { class: "gif-status" }, gifNote, gifRetry), gifGrid, h("p", { class: "gif-by", text: "Powered by GIPHY" }));

  const form = h("form", { class: "compose", novalidate: true },
    h("label", { class: "sr-only", for: `${uid}-input`, text: `Add a comment on the track by ${label}` }),
    input, chosen,
    h("div", { class: "compose-row" }, gifBtn, counter, postBtn),
    picker, composeMsg);
  const closedLine = h("p", { class: "thread-closed", hidden: true, text: "Voting closed. Comments are closed too." });

  const el = h("div", { id: uid, class: "thread", hidden: true },
    moreBtn, list, h("div", { class: "thread-status" }, note, retryBtn), form, closedLine);

  // ── The list ───────────────────────────────────────────────────────────────────────────────
  function item(c) {
    const created = Date.parse(c.created_at);
    const time = h("time", { class: "c-time", datetime: c.created_at, text: relativeTime(created, ctx.now() ?? created) });
    const li = h("li", { class: "comment" },
      h("p", { class: "c-head" }, h("span", { class: "c-name", text: c.first_name || "Someone" }), " ", time));
    if (c.text) {
      const body = h("p", { class: "c-text", text: c.text });
      li.append(body);
      // A very long comment shows its first lines; the reader opens the rest.
      if (isLongComment(c.text)) {
        const open = state.unfolded.has(c.id);
        body.classList.toggle("is-clamped", !open);
        const more = h("button", { type: "button", class: "link-btn c-more", "aria-expanded": String(open), text: open ? "Show less" : "Show all" });
        more.addEventListener("click", () => {
          const now = body.classList.toggle("is-clamped");
          if (now) state.unfolded.delete(c.id); else state.unfolded.add(c.id);
          more.setAttribute("aria-expanded", String(!now));
          more.textContent = now ? "Show all" : "Show less";
        });
        li.append(more);
      }
    }
    const gif = safeGifUrl(c.gif?.url);
    if (gif) li.append(h("img", { class: "c-gif", src: gif, alt: `GIF from ${c.first_name || "a voter"}`, loading: "lazy", decoding: "async" }));
    return li;
  }

  function setNote(text, canRetry = false) {
    note.textContent = text || "";
    retryBtn.hidden = !canRetry;
  }

  function draw() {
    list.replaceChildren(...state.comments.map(item));
    moreBtn.hidden = !state.hasMore;
    if (state.loaded && !state.comments.length) {
      setNote(state.closed ? "No comments on this track." : "No comments yet. Be the first to say something.");
    } else if (state.loaded) setNote("");
  }

  async function load({ before = null, limit = FIRST_PAGE } = {}) {
    if (state.loading) { state.reloadAfter = true; return; }
    state.loading = true;
    if (!state.loaded) setNote("Loading comments…");
    if (before) { moreBtn.disabled = true; moreBtn.textContent = "Loading earlier comments…"; }
    try {
      const query = `/api/comments?track=${encodeURIComponent(slug)}&limit=${limit}${before ? `&before=${before}` : ""}`;
      const { data } = await ctx.api(query);
      const fresh = Array.isArray(data.comments) ? data.comments : [];
      if (before) {
        const known = new Set(state.comments.map((c) => c.id));
        state.comments = [...fresh.filter((c) => !known.has(c.id)), ...state.comments];
      } else {
        state.comments = fresh;
      }
      state.hasMore = data.has_more === true;
      state.total = Number(data.total) || 0;
      state.loaded = true;
      draw();
    } catch (err) {
      if (before) setNote(`Earlier comments did not load. ${err.message}`);
      else if (!state.loaded) setNote(`Comments did not load. ${err.message}`, true);
      // a failed background refresh keeps what is already on screen
    } finally {
      state.loading = false;
      moreBtn.disabled = false;
      moreBtn.textContent = "Show earlier comments";
      if (state.reloadAfter) { state.reloadAfter = false; refresh(); }
    }
  }

  // Re-read the newest comments, keeping as many on screen as there are now.
  function refresh() {
    return load({ limit: Math.min(50, Math.max(FIRST_PAGE, state.comments.length)) });
  }

  moreBtn.addEventListener("click", () => { if (state.comments.length) load({ before: state.comments[0].id, limit: MORE_PAGE }); });
  retryBtn.addEventListener("click", () => load());

  // ── Writing one ────────────────────────────────────────────────────────────────────────────
  function setMsg(text, kind = "") {
    composeMsg.textContent = text || "";
    composeMsg.dataset.kind = kind;
  }

  function draft() {
    return { text: input.value.trim(), gif: state.gif ? { id: state.gif.id, url: state.gif.url } : null };
  }

  function setChosen(gif) {
    state.gif = gif;
    chosen.hidden = !gif;
    if (gif) chosenImg.src = gif.preview;
    else chosenImg.removeAttribute("src");
  }

  let msgTimer = null;
  async function post(payload) {
    if (state.posting) return { ok: false };
    state.posting = true;
    postBtn.disabled = true;
    postBtn.textContent = "Posting…";
    clearTimeout(msgTimer);
    setMsg("");
    try {
      const body = { track: slug, text: payload.text };
      if (payload.gif) body.gif = payload.gif;
      const { data, date } = await ctx.api("/api/comments", { method: "POST", token: ctx.token(), body });
      state.total = Number(data.comments) || state.total + 1;
      if (state.loaded) {
        if (!state.comments.some((c) => c.id === data.comment.id)) state.comments.push(data.comment);
        if (state.loading) state.reloadAfter = true; // a read that began before this post may not include it
        draw();
      } else {
        load(); // the thread had not been read yet: read it now, with the new comment in it
      }
      ctx.onCount(slug, state.total, holdFrom(date, ctx.now()));
      input.value = "";
      counter.textContent = "";
      setChosen(null);
      postBtn.textContent = "Post";
      setMsg("Comment posted", "done");
      msgTimer = setTimeout(() => setMsg(""), 4000);
      list.lastElementChild?.scrollIntoView({ block: "nearest" });
      return { ok: true };
    } catch (err) {
      postBtn.textContent = "Try again";
      if (err.status === 401) {
        setMsg("Your sign-in ran out. Confirm your details to post this.", "error");
        ctx.onAuthLost();
        ctx.requestGate({ type: "comment", slug, payload }, postBtn, "Your saved sign-in stopped working. Enter your details again to post.");
      } else if (err.code === "voting_closed") {
        ctx.onClosed();
      } else {
        setMsg(`Not posted. ${err.message}`, "error");
      }
      return { ok: false };
    } finally {
      state.posting = false;
      postBtn.disabled = false;
    }
  }

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (state.posting || state.closed) return;
    const payload = draft();
    if (!payload.text && !payload.gif) {
      setMsg(ctx.giphyOn() ? "Write something or pick a GIF." : "Write something first.", "error");
      input.focus();
      return;
    }
    if (!ctx.token()) { ctx.requestGate({ type: "comment", slug, payload }, postBtn); return; }
    post(payload);
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); form.requestSubmit?.(); }
  });
  input.addEventListener("input", () => {
    const left = MAX_CHARS - input.value.length;
    counter.textContent = left <= 60 ? `${left} left` : "";
    if (composeMsg.dataset.kind === "error") setMsg("");
    if (postBtn.textContent === "Try again") postBtn.textContent = "Post";
  });
  chosenRemove.addEventListener("click", () => { setChosen(null); gifBtn.focus(); });

  // ── GIF picker ─────────────────────────────────────────────────────────────────────────────
  let gifTimer = null;
  let gifRequest = null;
  let gifSeq = 0;
  let lastTerm = "";

  function drawGifs(results) {
    gifGrid.replaceChildren(...results.slice(0, GIF_MAX).map((g) => {
      const preview = safeGifUrl(g.preview_url) || safeGifUrl(g.url);
      const url = safeGifUrl(g.url);
      if (!preview || !url || typeof g.id !== "string") return null;
      const btn = h("button", { type: "button", class: "gif", "aria-label": `Use this GIF${g.title ? `: ${g.title}` : ""}` },
        h("img", { src: preview, alt: "", width: g.preview_width || null, height: g.preview_height || null, loading: "lazy", decoding: "async" }));
      btn.addEventListener("click", () => {
        setChosen({ id: g.id, url, preview });
        togglePicker(false);
        setMsg("");
        postBtn.focus();
      });
      return btn;
    }).filter(Boolean));
  }

  function gifStatus(text, canRetry = false) {
    gifNote.textContent = text || "";
    gifRetry.hidden = !canRetry;
  }

  function showGifs(data, term) {
    const results = Array.isArray(data.results) ? data.results : [];
    drawGifs(results);
    if (data.available === false) gifStatus("GIFs are switched off right now.");
    else if (data.limited && !results.length) gifStatus("GIFs are busy right now. Try again in a few minutes.");
    else if (data.limited) gifStatus("GIFs are busy right now. These are saved results.");
    else if (!results.length) gifStatus(term ? `No GIFs found for “${term}”. Try another word.` : "No GIFs to show right now. Try a search.");
    else gifStatus("");
  }

  async function loadGifs(term) {
    lastTerm = term;
    const seq = ++gifSeq;
    gifRequest?.abort();
    const key = term || "\u0000trending";
    if (gifCache.has(key)) { showGifs(gifCache.get(key), term); return; }
    gifRequest = new AbortController();
    gifStatus(term ? `Searching for “${term}”…` : "Loading GIFs…");
    gifGrid.setAttribute("aria-busy", "true");
    try {
      const { data } = await ctx.api(term ? `/api/giphy/search?q=${encodeURIComponent(term)}` : "/api/giphy/trending", { signal: gifRequest.signal });
      if (seq !== gifSeq) return;
      if (data.available !== false && !data.limited && Array.isArray(data.results) && data.results.length) gifCache.set(key, data);
      showGifs(data, term);
    } catch (err) {
      if (seq !== gifSeq || err.code === "cancelled") return;
      gifGrid.replaceChildren();
      gifStatus(`GIFs did not load. ${err.message}`, true);
    } finally {
      if (seq === gifSeq) gifGrid.removeAttribute("aria-busy");
    }
  }

  gifSearch.addEventListener("input", () => {
    clearTimeout(gifTimer);
    const term = gifSearch.value.trim().toLowerCase();
    if (term.length === 1) { gifRequest?.abort(); gifSeq++; gifStatus("Type at least 2 letters."); return; }
    gifStatus(term ? `Searching for “${term}”…` : "Loading GIFs…");
    gifTimer = setTimeout(() => loadGifs(term), GIF_DEBOUNCE_MS);
  });
  gifSearch.addEventListener("keydown", (ev) => { if (ev.key === "Enter") ev.preventDefault(); });
  gifRetry.addEventListener("click", () => loadGifs(lastTerm));

  function togglePicker(open) {
    const show = open ?? picker.hidden;
    picker.hidden = !show;
    gifBtn.setAttribute("aria-expanded", String(show));
    if (show) {
      if (!gifGrid.childElementCount) loadGifs(gifSearch.value.trim().toLowerCase().length >= 2 ? gifSearch.value.trim().toLowerCase() : "");
      gifSearch.focus();
    }
  }
  gifBtn.addEventListener("click", () => togglePicker());

  function applyAvailability() {
    const on = ctx.giphyOn() && !state.closed;
    gifBtn.hidden = !on;
    if (!on) {
      picker.hidden = true;
      gifBtn.setAttribute("aria-expanded", "false");
      if (!ctx.giphyOn()) setChosen(null);
    }
    form.hidden = state.closed;
    closedLine.hidden = !state.closed;
  }

  return {
    el,
    id: uid,
    isOpen: () => state.open,
    toggle() {
      state.open = !state.open;
      el.hidden = !state.open;
      if (state.open) {
        applyAvailability();
        if (!state.loaded) load();
        else refresh();
      }
      return state.open;
    },
    // Called on every poll: the count from /api/state, and whether the picker / voting is on.
    sync(count, closed) {
      state.closed = closed;
      applyAvailability();
      if (!state.open || !state.loaded) return;
      for (const t of list.querySelectorAll("time")) {
        const created = Date.parse(t.getAttribute("datetime"));
        t.textContent = relativeTime(created, ctx.now() ?? created);
      }
      // A count that differs from what is on screen means someone commented (or one was hidden):
      // read again, once per new count.
      if (!state.loading && !state.posting && Number.isFinite(count) && count !== state.total && count !== state.askedFor) {
        state.askedFor = count;
        refresh();
      } else if (!state.comments.length) draw();
    },
    // The held comment behind the gate.
    post,
    focusInput: () => input.focus(),
  };
}
