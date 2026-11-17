// The partner logos for the holiday party's "in partnership with" row (Scooter, 17 Nov 2026:
// "Logos go white on the black background - prepare white versions of each mark, don't invert the
// images"). Each source (design/partner-logos/, the files Scooter attached) is turned into a WHITE
// mark on a transparent background: every pixel is white, and how much of the mark it is (its
// coverage against the source's own background) becomes its alpha. Nothing is inverted: a dark mark
// on a light ground and a light mark on a dark ground both come out as the same white mark. The
// result is trimmed to the mark and written to public/img/partners/<name>.png.
// Run: npm run make-partner-logos (committed output; re-run only when a source changes).
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// crop: the mark's region in the source (left, top, width, height), so a background glow or a
// cut-off line at the edge is not part of it. ink: is the mark lighter or darker than its ground.
export const LOGOS = [
  { name: "flow-music", src: "flow-music.png", crop: { left: 200, top: 95, width: 625, height: 280 }, ink: "light", lo: 70, hi: 230 },
  { name: "dick-and-janes", src: "dick-and-janes.gif", crop: { left: 30, top: 230, width: 600, height: 290 }, ink: "dark", lo: 25, hi: 200 },
  { name: "blitz-and-bubbles", src: "blitz-and-bubbles.png", crop: { left: 40, top: 22, width: 590, height: 340 }, ink: "dark", lo: 30, hi: 180 },
];

export async function whiteMark(input, { crop, ink, lo, hi }) {
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
    const buf = await whiteMark(path.join(root, "design/partner-logos", l.src), l);
    const file = path.join(root, "public/img/partners", `${l.name}.png`);
    await sharp(buf).toFile(file);
    const m = await sharp(buf).metadata();
    console.log(`${l.name}.png ${m.width}x${m.height}`);
  }
}
