// One <audio> element for the whole page, so only one track can ever be playing.
// onChange(slug, { status, time, duration, slow }) tells a card what to draw.
// status: "idle" | "loading" | "playing" | "buffering" | "paused" | "error"
const SLOW_AFTER_MS = 6000;

export function createPlayer(onChange) {
  const audio = new Audio();
  audio.preload = "none";
  let current = null; // { slug, url, hint } — hint = duration in seconds from /api/state
  let status = "idle";
  let slowTimer = null;
  let isSlow = false;

  const snapshot = () => ({
    time: audio.currentTime || 0,
    duration: Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : current?.hint || 0,
  });

  function set(next, slow = false) {
    status = next;
    isSlow = slow;
    clearTimeout(slowTimer);
    if (!current) return;
    if (next === "loading" || next === "buffering") {
      const slug = current.slug;
      // Still waiting after a few seconds: say so, rather than spin in silence.
      if (!slow) slowTimer = setTimeout(() => { if (current?.slug === slug && status === next) set(next, true); }, SLOW_AFTER_MS);
    }
    onChange(current.slug, { status: next, slow, ...snapshot() });
  }

  audio.addEventListener("play", () => { if (current) set(audio.readyState >= 3 ? "playing" : "loading"); });
  audio.addEventListener("playing", () => set("playing"));
  audio.addEventListener("waiting", () => { if (current && !audio.paused) set("buffering"); });
  audio.addEventListener("pause", () => {
    // A pause event from the track we just switched away from arrives late: ignore it.
    if (!current || !audio.paused || audio.ended || status === "error" || status === "idle") return;
    set("paused");
  });
  audio.addEventListener("ended", () => {
    if (!current) return;
    status = "idle";
    isSlow = false;
    clearTimeout(slowTimer);
    onChange(current.slug, { status: "idle", slow: false, time: 0, duration: snapshot().duration });
  });
  const progress = () => { if (current && status !== "idle") onChange(current.slug, { status, slow: isSlow, ...snapshot() }); };
  audio.addEventListener("timeupdate", progress);
  audio.addEventListener("durationchange", progress);
  audio.addEventListener("error", () => { if (current && audio.error) set("error"); });

  function play() {
    const mine = current;
    let attempt;
    try { attempt = audio.play(); } catch { set("error"); return; }
    attempt?.catch?.((err) => {
      if (current !== mine || err?.name === "AbortError") return; // superseded by another tap
      if (err?.name === "NotAllowedError") set("paused"); // the browser wants a fresh tap
      else set("error");
    });
  }

  function start(track) {
    if (current && current.slug !== track.slug) {
      const prev = current;
      audio.pause();
      onChange(prev.slug, { status: "idle", slow: false, time: 0, duration: prev.hint });
    }
    current = { slug: track.slug, url: track.url, hint: track.hint };
    audio.src = track.url;
    // What a phone's lock screen and notification shade show while it plays.
    try {
      if (typeof MediaMetadata === "function" && navigator.mediaSession) {
        navigator.mediaSession.metadata = new MediaMetadata({ title: track.title || "CultureCon track", artist: "Top Barz at CultureCon" });
      }
    } catch {}
    set("loading");
    play();
  }

  return {
    // Play / pause / retry, from a tap on a card's play button.
    toggle(track) {
      if (!current || current.slug !== track.slug || status === "error") return start(track);
      if (audio.paused || audio.ended) play();
      else audio.pause();
    },
    // 0..1 along the track. Only the track that is loaded can be scrubbed.
    seek(slug, fraction) {
      if (!current || current.slug !== slug) return;
      const { duration } = snapshot();
      if (!duration) return;
      try { audio.currentTime = Math.min(Math.max(0, fraction), 0.999) * duration; } catch {}
      progress();
    },
    // A track that left the vote while it was loaded.
    drop(slug) {
      if (!current || current.slug !== slug) return;
      audio.pause();
      audio.removeAttribute("src");
      clearTimeout(slowTimer);
      current = null;
      status = "idle";
    },
    isCurrent: (slug) => current?.slug === slug,
  };
}
