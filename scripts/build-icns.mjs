// Assembles build/icon.icns from the PNGs in build/icons (no macOS tooling needed).
// An ICNS file is the 8-byte header "icns" + total length, followed by chunks of
// (4-byte type, 4-byte length including this 8-byte header, PNG bytes). Since macOS
// 10.7 every type below accepts PNG data. The @2x entries reuse the PNG of twice the
// size, so 16 and 32 px (and the @2x of 16 = 32 px) are the small-variant artwork.
import { readFileSync, writeFileSync } from "node:fs";

const ENTRIES = [
  ["icp4", 16], // 16x16
  ["icp5", 32], // 32x32
  ["icp6", 64], // 64x64
  ["ic07", 128], // 128x128
  ["ic08", 256], // 256x256
  ["ic09", 512], // 512x512
  ["ic10", 1024], // 1024x1024 (512@2x)
  ["ic11", 32], // 16x16@2x
  ["ic12", 64], // 32x32@2x
  ["ic13", 256], // 128x128@2x
  ["ic14", 512], // 256x256@2x
];

const chunks = ENTRIES.map(([type, size]) => {
  const png = readFileSync(new URL(`../build/icons/${size}x${size}.png`, import.meta.url));
  const head = Buffer.alloc(8);
  head.write(type, 0, "ascii");
  head.writeUInt32BE(png.length + 8, 4);
  return Buffer.concat([head, png]);
});
const body = Buffer.concat(chunks);
const header = Buffer.alloc(8);
header.write("icns", 0, "ascii");
header.writeUInt32BE(body.length + 8, 4);
writeFileSync(new URL("../build/icon.icns", import.meta.url), Buffer.concat([header, body]));
