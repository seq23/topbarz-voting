// GET /api/giphy/search?q=<term> → same shape as /api/giphy/trending. Debounce the box (~450 ms):
// each new term costs one of the site's 90 upstream calls an hour; repeats are served from cache.
// `limited: true` means the hourly budget is spent — show what came back (maybe nothing) and say so.
import { giphyResponse, normalizeTerm } from "../../_lib/giphy.js";
import { HttpError, route } from "../../_lib/http.js";

export const onRequest = route({
  GET(context) {
    const term = normalizeTerm(new URL(context.request.url).searchParams.get("q"));
    if (term.length < 2) throw new HttpError(400, "term_required", "Type at least two letters.");
    return giphyResponse(context, term);
  },
});
