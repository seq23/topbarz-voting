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
export const ART_MAX_BYTES = 2 * 1024 * 1024;
export const ART_TYPES = { "image/jpeg": "jpg", "image/png": "png" };

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

// The share id: 16 hex characters from the platform's random source, drawn on its own, so it is
// never the code, never made from the code, and cannot be guessed (2^64 of them).
export function shareId(random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  return [...random(8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const isShareId = (s) => typeof s === "string" && /^[0-9a-f]{16}$/.test(s);

// Artwork: image/jpeg or image/png by the declared type → its extension, or null.
export function artType(contentType) {
  const type = String(contentType ?? "").split(";")[0].trim().toLowerCase();
  return ART_TYPES[type] ?? null;
}
// … and by the first bytes (the magic number): "jpg" | "png" | null. The two have to agree.
export function artMagic(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return "png";
  return null;
}
// The content-length header → bytes, or null when it is missing, not a number, 0 or over 2 MB.
export function artSize(contentLength) {
  if (!/^\d{1,9}$/.test(String(contentLength ?? "").trim())) return null;
  const n = Number(contentLength);
  return n > 0 && n <= ART_MAX_BYTES ? n : null;
}
// The artwork's key: random characters (never the code, never the share id) plus the content hash.
export function artKey(ext, hashHex, random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const hex = [...random(8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `booth/art/${hex}-${String(hashHex).slice(0, 10)}.${ext}`;
}

// Reserves a code by inserting the row: the UNIQUE constraint on `code` is the only arbiter, so
// two uploads racing can never share one. A collision is retried with a fresh code, a bounded
// number of times. → { id, code, mediaKey }, or null when every try collided.
// The share id is drawn here too, so every track has one from the start (private until the
// rapper flips the switch); a track from before the share existed gets one on its first publish.
const INSERT_SQL = `INSERT OR IGNORE INTO booth_tracks (code, file_name, content_type, size, media_key, uploaded_at, share_id)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id`;
export async function reserveCode(db, { fileName, contentType, size, ext, uploadedAt }, { random, tries = BOOTH_CODE_TRIES } = {}) {
  for (let i = 0; i < tries; i++) {
    const code = randomCode(random);
    const key = mediaKey(code, ext);
    const res = await db.prepare(INSERT_SQL).bind(code, fileName, contentType, size, key, uploadedAt, shareId()).all();
    const id = res.results?.[0]?.id;
    if (id !== undefined) return { id, code, mediaKey: key };
  }
  return null;
}

export const LOG_SQL = `SELECT code, file_name, size, uploaded_at, opened, public, art_key FROM booth_tracks ORDER BY uploaded_at DESC, id DESC LIMIT ${BOOTH_LOG_ROWS}`;
export const OPEN_SQL = "UPDATE booth_tracks SET opened = opened + 1, last_opened_at = ?2 WHERE code = ?1 RETURNING code, file_name, media_key, size, uploaded_at, public, share_id, art_key";
export const DROP_SQL = "DELETE FROM booth_tracks WHERE id = ?1";
// The share: the switch (a track from before the share existed gets its id now), the artwork,
// and the listen page's read, by share id only (never the code), which never counts an open.
export const PUBLIC_SQL = "UPDATE booth_tracks SET public = ?2, share_id = COALESCE(share_id, ?3) WHERE code = ?1 RETURNING public, share_id";
export const HAS_CODE_SQL = "SELECT id FROM booth_tracks WHERE code = ?1";
export const ART_SQL = "UPDATE booth_tracks SET art_key = ?2 WHERE code = ?1 RETURNING art_key";
export const LISTEN_SQL = "SELECT file_name, media_key, art_key, public FROM booth_tracks WHERE share_id = ?1";

export const artUrl = (row) => (row.art_key ? `/media/${row.art_key}` : null);
// The rapper's view of their track. The share id is handed out only while the track is public:
// a private track has no link to give.
export const toTrack = (row) => ({
  code: row.code,
  file_name: row.file_name,
  audio_url: `/media/${row.media_key}`,
  download_url: `/media/${row.media_key}?dl=1`,
  size: row.size ?? null,
  uploaded_at: new Date(row.uploaded_at).toISOString(),
  public: row.public === 1,
  share_id: row.public === 1 && row.share_id ? row.share_id : null,
  art_url: artUrl(row),
});
