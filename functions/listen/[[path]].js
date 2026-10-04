// GET /listen/<share_id> — the listen page (public/listen.html) for any id: the page reads the id
// from its own address and asks GET /api/booth/listen/<share_id>. Pages serves /listen itself as
// the static file; this function serves the same file under every path below it, from the
// static assets (never a copy of the markup here). Nothing is looked up on the server side:
// an unknown or private id is the same 200 page, which then shows "Sorry, this song is private".
export async function onRequest({ request, env }) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  let page = await env.ASSETS.fetch(new Request(new URL("/listen.html", request.url), { method: "GET" }));
  if (page.status >= 300 && page.status < 400) page = await env.ASSETS.fetch(new Request(new URL("/listen", request.url), { method: "GET" })); // the asset server's clean-URL redirect
  if (page.status !== 200) return new Response("Not found", { status: 404 });
  const headers = new Headers(page.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "public, max-age=60");
  return new Response(request.method === "HEAD" ? null : page.body, { status: 200, headers });
}
