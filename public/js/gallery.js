// The photo slider: a strip that swipes on a phone, with arrows and arrow keys on a desktop.
// Thumbnails load lazily; a tap opens the full-size photo. With no photos the section is hidden.
import { $, closeModal, h, reducedMotion, showModal } from "./dom.js";
import { safeGifUrl, safeMediaUrl, stripTarget } from "./logic.js";

export function createGallery() {
  const section = $("tbz-gallery");
  const strip = $("tbz-strip");
  const prev = $("tbz-strip-prev");
  const next = $("tbz-strip-next");
  const box = $("tbz-lightbox");
  const boxImg = $("tbz-lb-img");
  const boxCap = $("tbz-lb-cap");
  const nav = $("tbz-lb-nav");
  const by = $("tbz-gallery-by");
  let photos = [];
  let signature = null;
  const galleryWhat = { photo: "Top Barz at CultureCon, photo" };
  let index = 0;
  let opener = null;

  const behavior = () => (reducedMotion() ? "auto" : "smooth");

  function arrows() {
    const max = strip.scrollWidth - strip.clientWidth;
    prev.disabled = strip.scrollLeft <= 2;
    next.disabled = strip.scrollLeft >= max - 2;
    const scrolls = max > 2;
    prev.hidden = !scrolls;
    next.hidden = !scrolls;
  }

  function page(direction) {
    strip.scrollBy({ left: direction * Math.max(160, strip.clientWidth * 0.8), behavior: behavior() });
  }

  let raf = 0;
  strip.addEventListener("scroll", () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(arrows); }, { passive: true });
  window.addEventListener("resize", arrows, { passive: true });
  prev.addEventListener("click", () => page(-1));
  next.addEventListener("click", () => page(1));
  // From a keyboard the strip is one Tab stop, however many photos it holds (200 photos must
  // not be 200 presses of Tab before the VOTE button): the arrow keys, Home and End move between
  // photos, and Tab leaves the strip.
  let current = 0; // the photo that is the strip's Tab stop
  const shots = () => [...strip.querySelectorAll(".shot:not(.shot-copy)")];
  function setCurrent(i, focus = false) {
    const all = shots();
    if (!all.length) return;
    current = Math.min(Math.max(0, i), all.length - 1);
    all.forEach((btn, n) => { btn.tabIndex = n === current ? 0 : -1; });
    if (focus) {
      all[current].focus({ preventScroll: true });
      all[current].scrollIntoView({ behavior: behavior(), block: "nearest", inline: "nearest" });
    }
  }
  strip.addEventListener("keydown", (ev) => {
    const next = stripTarget(current, ev.key, photos.length);
    if (next === null) return;
    ev.preventDefault();
    setCurrent(next, true);
  });
  strip.addEventListener("focusin", (ev) => {
    const i = shots().indexOf(ev.target.closest?.(".shot"));
    if (i >= 0 && i !== current) setCurrent(i);
  });

  // ── Full-size view ─────────────────────────────────────────────────────────────────────────
  function show(i) {
    if (!photos.length) return;
    index = (i + photos.length) % photos.length;
    const photo = photos[index];
    const place = `Photo ${index + 1} of ${photos.length}`;
    boxImg.alt = photo.alt;
    boxImg.src = photo.thumb_url; // already on screen, so it shows at once
    boxCap.textContent = `${place}. Loading full size…`;
    const full = new Image();
    full.onload = () => { if (photos[index] === photo && box.open) { boxImg.src = photo.url; boxCap.textContent = place; } };
    full.onerror = () => { if (photos[index] === photo && box.open) boxCap.textContent = `${place}. The full-size photo did not load.`; };
    full.src = photo.url;
  }

  function open(i, from) {
    opener = from;
    showModal(box, close);
    show(i);
  }

  function close() {
    closeModal(box);
    opener?.focus?.();
    opener = null;
  }

  $("tbz-lb-close").addEventListener("click", close);
  $("tbz-lb-prev").addEventListener("click", () => show(index - 1));
  $("tbz-lb-next").addEventListener("click", () => show(index + 1));
  box.addEventListener("cancel", (ev) => { ev.preventDefault(); close(); });
  box.addEventListener("click", (ev) => { if (ev.target === box) close(); });
  box.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowRight") { ev.preventDefault(); show(index + 1); }
    else if (ev.key === "ArrowLeft") { ev.preventDefault(); show(index - 1); }
    else if (ev.key === "Escape" && typeof box.showModal !== "function") close();
  });
  let touchX = null;
  box.addEventListener("touchstart", (ev) => { touchX = ev.touches.length === 1 ? ev.touches[0].clientX : null; }, { passive: true });
  box.addEventListener("touchend", (ev) => {
    if (touchX === null) return;
    const dx = ev.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 48) show(index + (dx < 0 ? 1 : -1));
  }, { passive: true });

  // ── The holiday GIFs drift by, slowly and without end (Scooter, 18 Nov 2026: "The front-page GIFs
  // scroll slowly and continuously"). The list is drawn twice (the copy hidden from screen readers
  // and the keyboard) so the strip loops with no jump. It pauses while a finger, the pointer or the
  // keyboard is on it, while the tab is hidden, and never moves for anyone who turns motion off.
  const DRIFT_PX_PER_S = 24;
  let drifting = false;
  let held = false;
  let last = 0;
  let resume = 0;
  function drift(t) {
    if (!drifting) return;
    const dt = last ? Math.min(100, t - last) : 0;
    last = t;
    if (!held && !document.hidden) {
      // One lap: from the first GIF to its copy (gaps and padding included, so the loop never jumps).
      const copy = strip.querySelector(".shot-copy")?.parentElement;
      const loop = copy ? copy.offsetLeft - strip.firstElementChild.offsetLeft : 0;
      let x = strip.scrollLeft + (DRIFT_PX_PER_S * dt) / 1000;
      if (loop > 0 && x >= loop) x -= loop;
      strip.scrollLeft = x;
    }
    requestAnimationFrame(drift);
  }
  const hold = () => { held = true; clearTimeout(resume); };
  const letGo = (ms = 0) => { clearTimeout(resume); resume = setTimeout(() => { held = false; last = 0; }, ms); };
  strip.addEventListener("pointerenter", hold);
  strip.addEventListener("pointerleave", () => letGo());
  strip.addEventListener("touchstart", hold, { passive: true });
  strip.addEventListener("touchend", () => letGo(3000), { passive: true });
  strip.addEventListener("focusin", hold);
  strip.addEventListener("focusout", () => letGo());
  function setDrift(on) {
    strip.classList.toggle("is-drifting", on);
    if (on && !drifting) { drifting = true; last = 0; requestAnimationFrame(drift); }
    if (!on) drifting = false;
  }

  return {
    // The words a photo's alt text starts with (the festive look renames CultureCon's).
    rename(photo) { galleryWhat.photo = photo; signature = ""; },
    // Called with the manifest from every /api/state. Rebuilds only when the manifest changed.
    // The holiday party (17 Nov 2026; Scooter's preview notes): the GIFs the team picked replace
    // the photos while there are any (Giphy's own images, with "Powered by GIPHY" as its terms
    // ask). With no GIFs picked, the photos show as before. Production sends no GIFs until go-live.
    update(manifest, gifs = []) {
      const photoList = (Array.isArray(manifest) ? manifest : [])
        .map((p, i) => ({
          url: safeMediaUrl(p?.url), thumb_url: safeMediaUrl(p?.thumb_url),
          width: Number(p?.thumb_width) || null, height: Number(p?.thumb_height) || null,
          alt: typeof p?.alt === "string" && p.alt.trim() ? p.alt.trim() : `${galleryWhat.photo} ${i + 1}`,
        }))
        .filter((p) => p.url && p.thumb_url);
      const gifList = (Array.isArray(gifs) ? gifs : [])
        .map((g) => ({ url: safeGifUrl(g?.url), thumb_url: safeGifUrl(g?.url), width: Number(g?.width) || null, height: Number(g?.height) || null, alt: typeof g?.title === "string" && g.title.trim() ? g.title.trim().slice(0, 120) : "Holiday GIF" }))
        .filter((p) => p.url);
      const list = gifList.length ? gifList : photoList;
      by.hidden = gifList.length === 0;
      const sig = list.map((p) => p.thumb_url).join("|");
      if (sig === signature) return;
      signature = sig;
      photos = list;
      if (box.open && !photos.length) close();
      section.hidden = photos.length === 0;
      nav.hidden = photos.length < 2; // one photo: nothing to step through
      const drifts = gifList.length > 0 && photos.length > 1 && !reducedMotion();
      const items = photos.map((p, i) => {
        const img = h("img", { src: p.thumb_url, alt: p.alt, width: p.width, height: p.height, loading: i < 3 ? "eager" : "lazy", decoding: "async", draggable: "false" });
        const btn = h("button", { type: "button", class: "shot" }, img);
        btn.addEventListener("click", () => open(i, btn));
        return h("li", {}, btn);
      });
      // The second copy, for the loop: the same GIFs, out of reach of the keyboard and screen readers.
      const copies = drifts ? photos.map((p, i) => {
        const btn = h("button", { type: "button", class: "shot shot-copy", tabindex: "-1" }, h("img", { src: p.thumb_url, alt: "", width: p.width, height: p.height, loading: "lazy", decoding: "async", draggable: "false" }));
        btn.addEventListener("click", () => open(i, btn));
        return h("li", { "aria-hidden": "true" }, btn);
      }) : [];
      strip.replaceChildren(...items, ...copies);
      strip.scrollLeft = 0;
      setDrift(drifts);
      setCurrent(0);
      requestAnimationFrame(arrows);
    },
  };
}
