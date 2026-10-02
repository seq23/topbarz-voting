export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

// Every error has the same shape: { error: "<machine_code>", message: "<plain words>" }.
export function fail(status, error, message, extra = {}) {
  return json({ error, message, ...extra }, status);
}

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// Wraps a route: { GET: fn, POST: fn }. Anything else is 405; a thrown HttpError becomes its
// response; anything unexpected is a 500 that says so (never an empty 200).
export function route(handlers) {
  return async (context) => {
    const method = context.request.method === "HEAD" && handlers.GET ? "GET" : context.request.method;
    const handler = handlers[method];
    if (!handler) return json({ error: "method_not_allowed", message: `Use ${Object.keys(handlers).join(" or ")}.` }, 405, { allow: Object.keys(handlers).join(", ") });
    try {
      return await handler(context);
    } catch (err) {
      if (err instanceof HttpError) return fail(err.status, err.code, err.message, err.extra);
      console.error("unhandled", err?.stack ?? String(err));
      return fail(500, "server_error", "Something went wrong on our side. Try again.");
    }
  };
}

export async function readJson(request, maxBytes = 8 * 1024) {
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "too_large", "That request is too large.");
  try {
    const body = JSON.parse(text);
    if (body && typeof body === "object" && !Array.isArray(body)) return body;
  } catch {}
  throw new HttpError(400, "bad_json", "Send a JSON object.");
}

export function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// IPs are never stored raw: a salted hash, enough to count and to spot a cluster.
export async function ipHash(request, env) {
  return (await sha256Hex(`${env?.VOTER_TOKEN_SECRET ?? "no-secret"}|${clientIp(request)}`)).slice(0, 24);
}
