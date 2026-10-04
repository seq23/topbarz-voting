// The two name rules the loaders and the booth's promotion share, pure (no I/O, no Node), so one
// definition serves scripts/lib/names.mjs (the loaders) and functions/_lib/booth.js (promoteVerdict).
const norm = (s) => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Scooter Taylor's own track must never be in the vote. True for any file named for him:
// "Scooter Taylor", "Taylor, Scooter", "scootertaylor", "@scootertaylor", or just "Scooter".
export function isScooterTaylor(name) {
  const flat = norm(name).replace(/[^a-z0-9]+/g, " ").trim();
  const tokens = flat.split(" ").filter((t) => t && t !== "test");
  if (flat.replace(/ /g, "").includes("scootertaylor")) return true;
  if (tokens.includes("scooter") && tokens.includes("taylor")) return true;
  return tokens.length === 1 && tokens[0] === "scooter";
}

// A "Test …" name: a test folder segment or a test file. Test files load into preview only.
const TEST_SEGMENT = /^test([^a-z]|$)/i;
export const isTestName = (name) => TEST_SEGMENT.test(String(name ?? "").trim());
