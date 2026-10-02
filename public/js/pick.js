// The rules of the select page with no screen in them: what a pick is, where it is kept, and what
// may be shown. Unit-tested in tests/select.test.mjs; select.js imports it as it is.
//
// The pick is ONE beat's slug, kept on this device only (localStorage `tbz.pick`). It is never
// sent to the server and needs no sign-up.
export const PICK_KEY = "tbz.pick";

export const isBeatSlug = (s) => typeof s === "string" && /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/.test(s);

// What /api/beats sent → the rows to draw: well-formed beats only, each slug once, in order.
export function cleanBeats(list) {
  const seen = new Set();
  const out = [];
  for (const b of Array.isArray(list) ? list : []) {
    if (!isBeatSlug(b?.slug) || seen.has(b.slug) || typeof b.name !== "string" || !b.name.trim()) continue;
    seen.add(b.slug);
    const label = typeof b.credit_label === "string" && b.credit_label.trim() ? b.credit_label.trim() : null;
    out.push({
      slug: b.slug,
      name: b.name.trim(),
      audio_url: typeof b.audio_url === "string" ? b.audio_url : null,
      duration_ms: Number(b.duration_ms) > 0 ? Number(b.duration_ms) : 0,
      credit_label: label,
      credit_url: label ? safeLinkUrl(b.credit_url) : null,
    });
  }
  return out;
}

// A link on this page (a beat's credit, the producer, the engineer) is only ever https.
export function safeLinkUrl(url) {
  if (typeof url !== "string" || url.length > 500) return null;
  try {
    const u = new URL(url.trim());
    if (u.protocol === "https:" && u.hostname.includes(".") && !u.username && !u.password) return u.toString();
  } catch {}
  return null;
}

// The stored value → a slug, or null for anything that is not one.
export const readPick = (raw) => (isBeatSlug(raw) ? raw : null);

// The beat that is picked, or null: nothing stored, or the stored beat is no longer offered (the
// page then shows the unpicked state, and the next choice replaces what was stored).
export function pickedBeat(raw, beats) {
  const slug = readPick(raw);
  return slug ? (beats ?? []).find((b) => b.slug === slug) ?? null : null;
}

// A tap on a row's button: choose it, or (on the beat already picked) take the pick back.
export const togglePick = (current, slug) => (!isBeatSlug(slug) || current === slug ? null : slug);

// "You picked {name}" → "You picked Midnight Run". The name goes in as text, exactly as given.
export const pickedTitle = (template, name) => String(template ?? "").split("{name}").join(String(name ?? ""));

// The device's memory of the pick. Every call survives a browser that refuses storage (private
// mode, a full disk): load answers null, save answers false, and the page says so.
export function loadPick(storage) {
  try { return readPick(storage.getItem(PICK_KEY)); } catch {}
  return null;
}
export function savePick(storage, slug) {
  try {
    if (isBeatSlug(slug)) { storage.setItem(PICK_KEY, slug); return storage.getItem(PICK_KEY) === slug; }
    storage.removeItem(PICK_KEY);
    return true;
  } catch {}
  return false;
}

// The producer and engineer links from the copy: entries with words to show, a link only when
// its url is https.
export function cleanLinks(links) {
  return (Array.isArray(links) ? links : [])
    .filter((l) => typeof l?.label === "string" && l.label.trim())
    .map((l) => ({ role: typeof l.role === "string" ? l.role.trim() : "", label: l.label.trim(), url: safeLinkUrl(l.url) }));
}

// The beats are asked for again when the page is shown after this long (a page left open).
export const BEATS_STALE_MS = 60_000;
