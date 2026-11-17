// The partner logos for the holiday party's "in partnership with" row (Scooter, 17 Nov 2026:
// "Logos go white on the black background - prepare white versions of each mark, don't invert the
// images"). Each source (design/partner-logos/, the files Scooter attached) is turned into a WHITE
// mark on a transparent background: every pixel is white, and how much of the mark it is (its
// coverage against the source's own background) becomes its alpha. Nothing is inverted: a dark mark
// on a light ground and a light mark on a dark ground both come out as the same white mark. The
// result is trimmed to the mark and written to public/img/partners/<name>.png.
// The sources are Scooter's attachments (17 Nov 2026), kept on the Mac in design/partner-logos/
// (git-ignored: only the white marks are committed, tests/loaders.test.mjs). Another folder: --from <dir>.
// Run: npm run make-partner-logos (committed output; re-run only when a source changes).
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// crop: the mark's region in the source (left, top, width, height), so a background glow or a
// cut-off line at the edge is not part of it. ink: is the mark lighter or darker than its ground, or
// "white" for a source that is already a white mark on transparency (its alpha is kept as it is).
export const LOGOS = [
  { name: "flow-music", src: "flow-music.png", crop: { left: 200, top: 95, width: 625, height: 280 }, ink: "light", lo: 70, hi: 230 },
  { name: "dick-and-janes", src: "dick-and-janes.png", crop: { left: 30, top: 230, width: 600, height: 290 }, ink: "dark", lo: 25, hi: 200 },
  // Blitz and Bubbles: the file Scooter sent at 19:44Z on 17 Nov 2026 ("use this Blitz & Bubbles logo
  // instead of the one in my last email. It's already white"), so its own transparency is the mark.
  { name: "blitz-and-bubbles", src: "blitz-and-bubbles.png", crop: { left: 30, top: 30, width: 1617, height: 570 }, ink: "white" },
];

export async function whiteMark(input, { crop, ink, lo, hi }) {
  if (ink === "white") {
    const { data, info } = await sharp(input).extract(crop).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += 4) { data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; }
    // Trimmed, then 270 px tall like the other two marks (the page shows it at 30 px at most).
    const trimmed = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).trim({ threshold: 1 }).png().toBuffer();
    const small = await sharp(trimmed).resize({ height: 270 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < small.data.length; i += 4) { small.data[i] = 255; small.data[i + 1] = 255; small.data[i + 2] = 255; }
    return sharp(small.data, { raw: { width: small.info.width, height: small.info.height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
  }
  const { data, info } = await sharp(input, { animated: false }).extract(crop).flatten({ background: ink === "light" ? "#000" : "#fff" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0; i < info.width * info.height; i++) {
    const v = data[i * info.channels];
    const cover = ink === "light" ? v : 255 - v; // how far from the ground, 0 … 255
    const a = Math.max(0, Math.min(255, Math.round(((cover - lo) / (hi - lo)) * 255)));
    out[i * 4] = 255; out[i * 4 + 1] = 255; out[i * 4 + 2] = 255; out[i * 4 + 3] = a;
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).trim({ threshold: 1 }).png({ compressionLevel: 9 }).toBuffer();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const l of LOGOS) {
    const from = process.argv.includes("--from") ? process.argv[process.argv.indexOf("--from") + 1] : path.join(root, "design/partner-logos");
    const buf = await whiteMark(path.join(from, l.src), l);
    const file = path.join(root, "public/img/partners", `${l.name}.png`);
    await sharp(buf).toFile(file);
    const m = await sharp(buf).metadata();
    console.log(`${l.name}.png ${m.width}x${m.height}`);
  }
}
