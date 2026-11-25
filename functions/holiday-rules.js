// /holiday-rules: the DRAFT rules for the holiday contest are served only where the party is on
// (preview), never in production until Scooter sends the final rules and says go live.
import { holidayOn } from "./_lib/party.js";

export async function onRequest(context) {
  if (holidayOn(context.env)) return context.next();
  return new Response("Nothing on right now.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
