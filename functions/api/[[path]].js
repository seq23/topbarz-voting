// Any /api/* path with no route of its own: a JSON 404, never the site's HTML.
import { fail } from "../_lib/http.js";
export const onRequest = () => fail(404, "not_found", "No such API route.");
