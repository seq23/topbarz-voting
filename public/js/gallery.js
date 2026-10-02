// The photo slider: a strip that swipes on a phone, with arrows and arrow keys on a desktop.
// Thumbnails load lazily; a tap opens the full-size photo. With no photos the section is hidden.
import { $, closeModal, h, reducedMotion, showModal } from "./dom.js";
import { safeMediaUrl, stripTarget } from "./logic.js";

export function createGallery() {
  const section = $("tbz-gallery");
  const strip = $("tbz-strip");
  const prev = $("tbz-strip-prev");
  const next = $("tbz-strip-next");
  const box = $("tbz-lightbox");
  const boxImg = $("tbz-lb-img");
  const boxCap = $("tbz-lb-cap");
  const nav = $("tbz-lb-nav");
  let photos = [];
  let signature = null;
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
  const shots = () => [...strip.querySelectorAll(".shot")];
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

  return {
    // Called with the manifest from every /api/state. Rebuilds only when the manifest changed.
    update(manifest) {
      const list = (Array.isArray(manifest) ? manifest : [])
        .map((p, i) => ({
          url: safeMediaUrl(p?.url), thumb_url: safeMediaUrl(p?.thumb_url),
          width: Number(p?.thumb_width) || null, height: Number(p?.thumb_height) || null,
          alt: typeof p?.alt === "string" && p.alt.trim() ? p.alt.trim() : `Top Barz at CultureCon, photo ${i + 1}`,
        }))
        .filter((p) => p.url && p.thumb_url);
      const sig = list.map((p) => p.thumb_url).join("|");
      if (sig === signature) return;
      signature = sig;
      photos = list;
      if (box.open && !photos.length) close();
      section.hidden = photos.length === 0;
      nav.hidden = photos.length < 2; // one photo: nothing to step through
      strip.replaceChildren(...photos.map((p, i) => {
        const img = h("img", { src: p.thumb_url, alt: p.alt, width: p.width, height: p.height, loading: i < 3 ? "eager" : "lazy", decoding: "async", draggable: "false" });
        const btn = h("button", { type: "button", class: "shot" }, img);
        btn.addEventListener("click", () => open(i, btn));
        return h("li", {}, btn);
      }));
      strip.scrollLeft = 0;
      setCurrent(0);
      requestAnimationFrame(arrows);
    },
  };
}
