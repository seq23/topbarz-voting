// GET /api/giphy/trending → { available, results: [{ id, title, url, width, height, preview_url, … }] }
// With no key set: { available: false, reason: "no_key", results: [] } — hide the picker.
import { TRENDING_TERM, giphyResponse } from "../../_lib/giphy.js";
import { route } from "../../_lib/http.js";

export const onRequest = route({ GET: (context) => giphyResponse(context, TRENDING_TERM) });
