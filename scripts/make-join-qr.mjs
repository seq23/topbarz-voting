#!/usr/bin/env node
// Writes public/img/join-qr.svg: the QR code on the holiday party's sign (/join-qr), encoding
// exactly https://voting.topbarz.xyz/join. Run once (npm run make-join-qr); the SVG is committed,
// so nothing of this runs in the browser. tests/party-pages.test.mjs re-runs it and compares.
import fs from "node:fs";
import path from "node:path";
import QRCode from "qrcode";

export const JOIN_URL = "https://voting.topbarz.xyz/join";
const ROOT = path.resolve(import.meta.dirname, "..");
export const OUT = path.join(ROOT, "public", "img", "join-qr.svg");
export const joinQrSvg = async () => (await QRCode.toString(JOIN_URL, { type: "svg", errorCorrectionLevel: "M", margin: 4 })).trim() + "\n";

if (import.meta.url === `file://${process.argv[1]}`) {
  fs.writeFileSync(OUT, await joinQrSvg());
  console.log(`Written: ${path.relative(ROOT, OUT)} (${fs.statSync(OUT).size} bytes) encoding ${JOIN_URL}`);
}
