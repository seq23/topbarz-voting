// Server-side Giphy proxy. The key (env GIPHY_BETA_KEY) never reaches a browser. The beta key
// allows 100 calls an hour for the whole site, so:
//   · results are cached in D1 by search term (shared by every edge location), trending is one row;
//   · every upstream call is a row in giphy_calls and we stop at GIPHY.budgetPerHour in any rolling
//     hour — past it, a term already cached is served stale and a new one answers `limited: true`.
import { GIPHY, LIMITS, giphyStatus } from "./config.js";
import { ipHash, json } from "./http.js";
import { assertUnderLimit, limitStatement } from "./ratelimit.js";

export const TRENDING_TERM = "__trending__";

export function normalizeTerm(q) {
  return typeof q === "string" ? q.toLowerCase().replace(/[^\p{L}\p{N} '-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 50) : "";
}

function slim(gif) {
  const img = gif?.images ?? {};
  const full = img.fixed_height ?? img.downsized ?? img.original;
  const small = img.fixed_width_small ?? img.fixed_height_small ?? full;
  if (!gif?.id || !full?.url) return null;
  return {
    id: gif.id,
    title: typeof gif.title === "string" ? gif.title.slice(0, 120) : "",
    url: full.url,
    width: Number(full.width) || null,
    height: Number(full.height) || null,
    preview_url: small.url,
    preview_width: Number(small.width) || null,
    preview_height: Number(small.height) || null,
  };
}

// → the JSON Response for /api/giphy/trending (term = TRENDING_TERM) or /api/giphy/search.
export async function giphyResponse(context, term) {
  const { request, env } = context;
  const status = giphyStatus(env);
  if (!status.available) return json({ ...status, results: [] });

  const db = env.DB;
  const nowS = Math.floor(Date.now() / 1000);
  const ttl = term === TRENDING_TERM ? GIPHY.trendingTtl : GIPHY.searchTtl;
  const [ipLimit, cachedRes] = await db.batch([
    limitStatement(db, `giphy:ip:${await ipHash(request, env)}`, LIMITS.giphyPerIp),
    db.prepare("SELECT payload, fetched_at FROM giphy_cache WHERE term = ?1").bind(term),
  ]);
  assertUnderLimit(ipLimit, LIMITS.giphyPerIp, "GIF searches");
  const cached = cachedRes.results[0];
  const stale = cached ? JSON.parse(cached.payload) : null;
  const ok = (results, extra = {}) => json({ available: true, results, ...extra }, 200, { "cache-control": "public, max-age=120" });
  if (cached && nowS - cached.fetched_at < ttl) return ok(stale, { cached: true });

  // Take one call from the rolling-hour budget, atomically. No row back = budget spent.
  const slot = await db
    .prepare("INSERT INTO giphy_calls (called_at) SELECT ?1 WHERE (SELECT COUNT(*) FROM giphy_calls WHERE called_at > ?2) < ?3 RETURNING id")
    .bind(nowS, nowS - 3600, GIPHY.budgetPerHour)
    .first();
  if (!slot) return stale ? ok(stale, { cached: true, limited: true }) : json({ available: true, limited: true, results: [] });

  const upstream = new URL(`https://api.giphy.com/v1/gifs/${term === TRENDING_TERM ? "trending" : "search"}`);
  upstream.searchParams.set("api_key", env.GIPHY_BETA_KEY);
  upstream.searchParams.set("limit", String(GIPHY.pageSize));
  upstream.searchParams.set("rating", GIPHY.rating);
  if (term !== TRENDING_TERM) upstream.searchParams.set("q", term);
  let res;
  try { res = await fetch(upstream, { headers: { accept: "application/json" } }); } catch { res = null; }
  if (res && (res.status === 401 || res.status === 403)) {
    console.error("giphy rejected the key", res.status);
    return json({ available: false, reason: "key_rejected", results: [] });
  }
  if (!res || !res.ok) {
    console.error("giphy upstream", res?.status ?? "network");
    return stale ? ok(stale, { cached: true, degraded: "upstream_error" }) : json({ available: true, degraded: "upstream_error", results: [] });
  }
  const data = await res.json();
  const results = (Array.isArray(data?.data) ? data.data : []).map(slim).filter(Boolean).slice(0, GIPHY.pageSize);
  context.waitUntil?.(
    db.batch([
      db.prepare("INSERT INTO giphy_cache (term, payload, fetched_at) VALUES (?1, ?2, ?3) ON CONFLICT (term) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at").bind(term, JSON.stringify(results), nowS),
      db.prepare("DELETE FROM giphy_calls WHERE called_at < ?1").bind(nowS - 2 * 3600),
      db.prepare("DELETE FROM giphy_cache WHERE fetched_at < ?1 AND term <> ?2").bind(nowS - 24 * 3600, TRENDING_TERM),
    ]).catch((err) => console.error("giphy cache write", String(err))),
  );
  return ok(results, { cached: false });
}
