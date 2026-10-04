#!/usr/bin/env node
// Writes public/img/track-qr.svg: the QR code on the booth's print page (/track-qr), encoding
// exactly https://voting.topbarz.xyz/track. Run once (npm run make-track-qr); the SVG is
// committed, so nothing of this runs in the browser. tests/booth.test.mjs reads the SVG back.
import fs from "node:fs";
import path from "node:path";
import QRCode from "qrcode";

export const TRACK_URL = "https://voting.topbarz.xyz/track";
const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "public", "img", "track-qr.svg");

if (import.meta.url === `file://${process.argv[1]}`) {
  const svg = await QRCode.toString(TRACK_URL, { type: "svg", errorCorrectionLevel: "M", margin: 4 });
  fs.writeFileSync(OUT, svg.trim() + "\n");
  console.log(`Written: ${path.relative(ROOT, OUT)} (${fs.statSync(OUT).size} bytes) encoding ${TRACK_URL}`);
}
