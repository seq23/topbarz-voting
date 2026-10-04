// The booth's rules with no request in them: what a file name may be, what a file may be, what a
// code is and how one is reserved. Used by functions/api/booth/[[path]].js and the media route
// (the download name). Booth tracks are their own data (the `booth_tracks` table, R2 keys under
// booth/): never tracks, never in the vote (tests/booth.test.mjs).
export const BOOTH_EXTENSIONS = ["wav", "mp3", "m4a", "aif", "aiff", "flac"];
export const BOOTH_MAX_BYTES = 100 * 1024 * 1024;
export const BOOTH_LOG_ROWS = 200;
export const BOOTH_NAME_MAX = 120;
export const BOOTH_CODE_TRIES = 25;
export const BOOTH_DAY_KEY = "booth-uploads-day"; // the one site-wide counter in rate_limits

// The engineer's file name as it is kept and shown: the base name only (no folder, whatever the
// separator), printable characters only, at most 120, trimmed. Empty in → "" (the caller refuses).
export function cleanFileName(raw) {
  if (typeof raw !== "string") return "";
  let name = raw;
  try { name = decodeURIComponent(name); } catch {}
  name = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  name = name.replace(/\s+/g, " ").replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (name.startsWith(".")) name = name.replace(/^\.+/, "");
  return name.slice(0, BOOTH_NAME_MAX).trim();
}

// The extension of a cleaned name, lower-case, or null when it is not one the booth takes.
export function audioExtension(name) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name);
  const ext = m?.[1].toLowerCase();
  return ext && BOOTH_EXTENSIONS.includes(ext) ? ext : null;
}

// Audio only: the extension AND the declared type both have to say so.
export function audioType(contentType) {
  const type = String(contentType ?? "").split(";")[0].trim().toLowerCase();
  if (type.startsWith("audio/")) return type;
  if (type === "application/octet-stream") return type;
  return null;
}

// The content-length header → bytes, or null when it is missing, not a number, 0 or over the cap.
export function uploadSize(contentLength) {
  if (!/^\d{1,12}$/.test(String(contentLength ?? "").trim())) return null;
  const n = Number(contentLength);
  return n > 0 && n <= BOOTH_MAX_BYTES ? n : null;
}

// What goes in the content-disposition header: ASCII only, no quote, backslash or control
// character, so the browser saves the file under the engineer's name and nothing can escape the
// quotes. A name that is nothing but non-ASCII becomes "track".
export function downloadName(raw) {
  const clean = cleanFileName(raw).replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "").trim();
  return clean || "track";
}

// Four digits from the platform's random source, with no bias (rejection sampling), 0000–9999.
export function randomCode(random = (n) => crypto.getRandomValues(new Uint16Array(n))) {
  for (;;) {
    const [v] = random(1);
    if (v < 60000) return String(v % 10000).padStart(4, "0");
  }
}
export const isCode = (s) => typeof s === "string" && /^\d{4}$/.test(s);

// The key is the code plus 16 random hex characters: a track is reachable only with the key the
// lookup hands out, never by guessing a code against /media.
export function mediaKey(code, ext, random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const hex = [...random(8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `booth/${code}-${hex}.${ext}`;
}

// Reserves a code by inserting the row: the UNIQUE constraint on `code` is the only arbiter, so
// two uploads racing can never share one. A collision is retried with a fresh code, a bounded
// number of times. → { id, code, mediaKey }, or null when every try collided.
const INSERT_SQL = `INSERT OR IGNORE INTO booth_tracks (code, file_name, content_type, size, media_key, uploaded_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id`;
export async function reserveCode(db, { fileName, contentType, size, ext, uploadedAt }, { random, tries = BOOTH_CODE_TRIES } = {}) {
  for (let i = 0; i < tries; i++) {
    const code = randomCode(random);
    const key = mediaKey(code, ext);
    const res = await db.prepare(INSERT_SQL).bind(code, fileName, contentType, size, key, uploadedAt).all();
    const id = res.results?.[0]?.id;
    if (id !== undefined) return { id, code, mediaKey: key };
  }
  return null;
}

export const LOG_SQL = `SELECT code, file_name, size, uploaded_at, opened FROM booth_tracks ORDER BY uploaded_at DESC, id DESC LIMIT ${BOOTH_LOG_ROWS}`;
export const OPEN_SQL = "UPDATE booth_tracks SET opened = opened + 1, last_opened_at = ?2 WHERE code = ?1 RETURNING code, file_name, media_key, size, uploaded_at";
export const DROP_SQL = "DELETE FROM booth_tracks WHERE id = ?1";

export const toTrack = (row) => ({
  code: row.code,
  file_name: row.file_name,
  audio_url: `/media/${row.media_key}`,
  download_url: `/media/${row.media_key}?dl=1`,
  size: row.size ?? null,
  uploaded_at: new Date(row.uploaded_at).toISOString(),
});
