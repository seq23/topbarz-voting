// Everything GET /api/beats returns. Beats are their own data (the `beats` table): they are never
// tracks, so they are never in the vote: not its state, its tally or its export (tests/beats.test.mjs).
export const BEATS_CACHE_SECONDS = 5;

// A stand-in (a test file loaded as a placeholder beat) is for preview and local only. The loader
// refuses to put one in production; if a row got there anyway, production still never returns it.
export const beatsSql = (env) => `
SELECT slug, name, audio_key, duration_ms, credit_label, credit_url
FROM beats WHERE active = 1${env?.APP_ENV === "production" ? " AND stand_in = 0" : ""}
ORDER BY sort, name, id`;

const text = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

// A credit link is only ever https. Anything else is left out, and the label shows as plain text.
export function creditUrl(url) {
  if (typeof url !== "string" || url.length > 500) return null;
  try {
    const u = new URL(url.trim());
    if (u.protocol === "https:" && u.hostname.includes(".") && !u.username && !u.password) return u.toString();
  } catch {}
  return null;
}

export async function buildBeats(env) {
  const { results } = await env.DB.prepare(beatsSql(env)).all();
  return {
    beats: (results ?? []).map((b) => {
      const label = text(b.credit_label, 120);
      return {
        slug: b.slug,
        name: b.name,
        audio_url: `/media/${b.audio_key}`,
        duration_ms: b.duration_ms ?? null,
        credit_label: label,
        credit_url: label ? creditUrl(b.credit_url) : null,
      };
    }),
  };
}
