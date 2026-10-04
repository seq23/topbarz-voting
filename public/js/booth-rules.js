// The rules of the booth pages (/booth, /track) with no screen in them: what a code is, which
// files the drop zone takes, what the server's answers may be shown as, and the words for a size
// or a time. Unit-tested in tests/booth.test.mjs; booth.js and track.js import it as it is.
export const CODE_LENGTH = 4;
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const UPLOAD_EXTENSIONS = ["wav", "mp3", "m4a", "aif", "aiff", "flac"];

export const isCode = (s) => typeof s === "string" && /^\d{4}$/.test(s);

// Whatever was typed or pasted → its digits, at most four. "" when there are none.
export function codeDigits(value) {
  return String(value ?? "").replace(/\D/g, "").slice(0, CODE_LENGTH);
}

// The ?code= in the address, if it is a code.
export function codeFromSearch(search) {
  try {
    const code = new URLSearchParams(String(search ?? "")).get("code") ?? "";
    return isCode(code.trim()) ? code.trim() : null;
  } catch { return null; }
}

// Why a chosen file cannot be sent, before a byte goes up: "not_audio" | "too_big" | "empty", or null.
export function refuseFile(file) {
  const name = String(file?.name ?? "");
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1]?.toLowerCase();
  if (!ext || !UPLOAD_EXTENSIONS.includes(ext)) return "not_audio";
  const size = Number(file?.size);
  if (!(size > 0)) return "empty";
  if (size > MAX_UPLOAD_BYTES) return "too_big";
  return null;
}

// The server's answer to a lookup → what the page shows, or null for anything malformed.
export function cleanTrack(data) {
  if (!data || typeof data !== "object") return null;
  const { code, file_name: name, audio_url: audio, download_url: download } = data;
  if (!isCode(code) || typeof name !== "string" || !name.trim()) return null;
  if (!safeBoothUrl(audio, false) || !safeBoothUrl(download, true)) return null;
  return { code, file_name: name.trim(), audio_url: audio, download_url: download, size: Number(data.size) > 0 ? Number(data.size) : 0 };
}

// A booth media address is /media/booth/<key>, with exactly ?dl=1 for the download.
export function safeBoothUrl(url, download) {
  return typeof url === "string" && /^\/media\/booth\/[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(download ? url.replace(/\?dl=1$/, "") : url)
    && (download ? url.endsWith("?dl=1") : !url.includes("?")) && !url.includes("..")
    ? url : null;
}

// The log as the server sent it → the rows for today on this device, newest first, well-formed only.
export function todayRows(rows, now = Date.now()) {
  const today = new Date(now).toDateString();
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!isCode(r?.code) || typeof r.file_name !== "string") continue;
    const at = Date.parse(r.uploaded_at);
    if (!Number.isFinite(at) || new Date(at).toDateString() !== today) continue;
    out.push({ code: r.code, file_name: r.file_name, uploaded_at: at, opened: Number(r.opened) > 0 ? Number(r.opened) : 0, size: Number(r.size) > 0 ? Number(r.size) : 0 });
  }
  return out.sort((a, b) => b.uploaded_at - a.uploaded_at);
}

export function formatSize(bytes) {
  const n = Number(bytes);
  if (!(n > 0)) return "";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function formatTime(ms) {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export const openedWords = (n) => (n === 0 ? "not opened yet" : n === 1 ? "opened once" : `opened ${n} times`);

// The line the booth page shows for a failed upload: the page's own words for the cases it
// knows, else the server's message, else a plain line.
export function uploadFailure(copy, { code, status, message } = {}) {
  if (code === "daily_limit") return copy.dailyLimit;
  if (code === "rate_limited" || status === 429) return copy.rateLimited;
  if (code === "not_audio") return copy.notAudio;
  if (code === "bad_size" || status === 413) return copy.tooBig;
  if (typeof message === "string" && message.trim()) return message.trim();
  return copy.failed;
}
