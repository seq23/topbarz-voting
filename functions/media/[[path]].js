// GET /media/tracks/<file>, /media/photos/<file>, /media/beats/<file> and /media/booth/<file> —
// straight from the R2 bucket. Keys carry a content hash (booth: random characters), so they are
// cached for a year and never change. Range requests are answered with 206: iOS Safari will not
// play audio without them. A booth file with ?dl=1 is sent as a download under the engineer's
// file name (the cache key includes the query, so the two forms are cached apart).
import { downloadName } from "../_lib/booth.js";

const ALLOWED = /^(tracks|photos|beats|booth)\/[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
const CACHE = "public, max-age=31536000, immutable";

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start, end;
  if (m[1] === "") { // suffix: the last N bytes
    const n = Number(m[2]);
    if (n === 0) return null;
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start > end || start >= size ? null : { start, end };
}

export async function onRequest(context) {
  const { request, env, params } = context;
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  const key = (Array.isArray(params.path) ? params.path : [params.path]).join("/");
  if (!ALLOWED.test(key)) return new Response("Not found", { status: 404 });

  const rangeHeader = request.headers.get("range");
  const edge = globalThis.caches?.default;
  if (edge && request.method === "GET") {
    const hit = await edge.match(request); // answers Range from a cached full copy
    if (hit) return hit;
  }

  const head = await env.MEDIA.head(key);
  if (!head) return new Response("Not found", { status: 404 });
  const headers = new Headers({
    "content-type": head.httpMetadata?.contentType || "application/octet-stream",
    "cache-control": CACHE,
    "accept-ranges": "bytes",
    etag: head.httpEtag,
  });
  if (key.startsWith("booth/") && new URL(request.url).searchParams.get("dl") === "1") {
    headers.set("content-disposition", `attachment; filename="${downloadName(head.customMetadata?.fileName)}"`);
  }
  if (request.headers.get("if-none-match") === head.httpEtag) return new Response(null, { status: 304, headers });

  if (rangeHeader) {
    const range = parseRange(rangeHeader, head.size);
    if (!range) {
      headers.set("content-range", `bytes */${head.size}`);
      return new Response(null, { status: 416, headers });
    }
    const length = range.end - range.start + 1;
    headers.set("content-range", `bytes ${range.start}-${range.end}/${head.size}`);
    headers.set("content-length", String(length));
    if (request.method === "HEAD") return new Response(null, { status: 206, headers });
    const part = await env.MEDIA.get(key, { range: { offset: range.start, length } });
    if (!part) return new Response("Not found", { status: 404 });
    return new Response(part.body, { status: 206, headers });
  }

  headers.set("content-length", String(head.size));
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  const obj = await env.MEDIA.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  const response = new Response(obj.body, { status: 200, headers });
  if (edge) context.waitUntil?.(edge.put(request, response.clone()).catch(() => {}));
  return response;
}
