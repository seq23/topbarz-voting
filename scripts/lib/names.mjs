// File names → tracks, and the two refusals the loaders make. Pure (no I/O): tests/loaders.test.mjs.
import path from "node:path";

const norm = (s) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
export const slugify = (s) => norm(s).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

// Scooter Taylor's own track must never be in the vote. True for any file named for him:
// "Scooter Taylor", "Taylor, Scooter", "scootertaylor", "@scootertaylor", or just "Scooter".
export function isScooterTaylor(name) {
  const flat = norm(name).replace(/[^a-z0-9]+/g, " ").trim();
  const tokens = flat.split(" ").filter((t) => t && t !== "test");
  if (flat.replace(/ /g, "").includes("scootertaylor")) return true;
  if (tokens.includes("scooter") && tokens.includes("taylor")) return true;
  return tokens.length === 1 && tokens[0] === "scooter";
}

const TEST_SEGMENT = /^test([^a-z]|$)/i;
export const isTestName = (name) => TEST_SEGMENT.test(name.trim());

// Test tracks and test photos are for PREVIEW (and local) only. Production refuses any folder with
// a "Test …" segment in its real path, and any file whose name starts with "Test".
export function assertLoadAllowed(envName, realFolder, fileNames) {
  if (envName !== "production") return;
  const bad = path.resolve(realFolder).split(path.sep).find((seg) => isTestName(seg));
  if (bad) throw new Error(`REFUSED: "${bad}" is a test folder. Test files load into preview only, never production.`);
  const badFile = fileNames.find((f) => isTestName(f));
  if (badFile) throw new Error(`REFUSED: "${badFile}" is a test file. Test files load into preview only, never production.`);
}

const GROUP = /[&+,]|\sx\s|\sand\s|\sfeat\.?\s|\sft\.?\s/i;

// "Jane Doe.mp3" → { sourceName: "Jane Doe", label: "Jane", slugBase: "jane", last: "Doe" }.
// A group ("Carlos & Damien") keeps its whole name as the label. A leading "Test - " is dropped.
export function parseTrackFile(fileName) {
  const sourceName = path.basename(fileName, path.extname(fileName)).replace(/\s+/g, " ").trim();
  const display = sourceName.replace(/^test\s*[-–:]\s*/i, "").trim() || sourceName;
  if (GROUP.test(display)) return { sourceName, label: display, slugBase: slugify(display), last: "", excluded: isScooterTaylor(sourceName) };
  const [first, ...rest] = display.split(" ");
  return { sourceName, label: first, slugBase: slugify(first), last: rest.join(" "), excluded: isScooterTaylor(sourceName) };
}

// Slugs are links people have already texted, so one a track already has NEVER changes. A new
// track whose first name is taken (or shared inside this batch) gets "jane-d" / "Jane D.", then
// "jane-doe" / "Jane Doe", then a number.
export function assignSlugs(parsed, existing = []) {
  const bySource = new Map(existing.map((t) => [t.source_name, t]));
  const taken = new Set(existing.map((t) => t.slug));
  const fresh = parsed.filter((p) => !bySource.has(p.sourceName));
  const baseCount = new Map();
  for (const p of fresh) baseCount.set(p.slugBase, (baseCount.get(p.slugBase) ?? 0) + 1);
  return parsed.map((p) => {
    const have = bySource.get(p.sourceName);
    if (have) return { ...p, slug: have.slug, label: have.label, isNew: false };
    const base = p.slugBase || "track";
    const options = [];
    if (baseCount.get(p.slugBase) === 1) options.push([base, p.label]);
    if (p.last) {
      options.push([`${base}-${slugify(p.last[0])}`, `${p.label} ${p.last[0].toUpperCase()}.`]);
      options.push([`${base}-${slugify(p.last)}`, `${p.label} ${p.last}`]);
    }
    for (let n = 2; n < 200; n++) options.push([`${base}-${n}`, p.label]);
    const [slug, label] = options.find(([s]) => s && !s.endsWith("-") && !taken.has(s));
    taken.add(slug);
    return { ...p, slug, label, isNew: true };
  });
}

export const naturalSort = (a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
