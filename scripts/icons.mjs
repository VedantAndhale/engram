// Makes the PNG app icons from public/icon.svg's shapes: node scripts/icons.mjs
//
// The icon is a few flat shapes, so it is drawn here directly (4x4 samples a pixel) and written
// as PNG with node's zlib, without an image library. Change the shapes below if icon.svg changes.

import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** Inside a rectangle whose corners are rounded by r (per corner: tl, tr, br, bl), in icon units (0..512). */
function inRounded(x, y, x0, y0, x1, y1, [tl, tr, br, bl]) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const corner = (cx, cy, r) => (r > 0 ? (x - cx) ** 2 + (y - cy) ** 2 <= r * r : true);
  if (x < x0 + tl && y < y0 + tl) return corner(x0 + tl, y0 + tl, tl);
  if (x > x1 - tr && y < y0 + tr) return corner(x1 - tr, y0 + tr, tr);
  if (x > x1 - br && y > y1 - br) return corner(x1 - br, y1 - br, br);
  if (x < x0 + bl && y > y1 - bl) return corner(x0 + bl, y1 - bl, bl);
  return true;
}
const pill = (x, y, w, h) => [x, y, x + w, y + h, [h / 2, h / 2, h / 2, h / 2]];

// icon.svg, top to bottom: the tile, the page (top-right and bottom-left corners rounded), a highlight, two lines.
const SHAPES = [
  { color: hex("#f6f1e7"), box: [150, 120, 362, 392, [0, 62, 0, 62]] },
  { color: hex("#f2c94c"), box: pill(190, 185, 130, 22) },
  { color: hex("#9aa5b1"), box: pill(190, 235, 110, 14) },
  { color: hex("#9aa5b1"), box: pill(190, 270, 120, 14) },
];
const TILE = hex("#1f2a37");

/** RGBA pixels. `bleed` fills the whole square (maskable and Apple icons are cropped by the system). */
function render(size, bleed) {
  const px = new Uint8Array(size * size * 4);
  const S = 4;
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = ((pxl + (sx + 0.5) / S) * 512) / size;
          const y = ((py + (sy + 0.5) / S) * 512) / size;
          let c = null;
          if (bleed || inRounded(x, y, 0, 0, 512, 512, [112, 112, 112, 112])) c = TILE;
          for (const s of SHAPES) if (inRounded(x, y, ...s.box)) c = s.color;
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a++;
          }
        }
      }
      const i = (py * size + pxl) * 4;
      // Colours averaged over the covered samples, so edges blend with what is behind.
      if (a) {
        px[i] = Math.round(r / a);
        px[i + 1] = Math.round(g / a);
        px[i + 2] = Math.round(b / a);
      }
      px[i + 3] = Math.round((a / (S * S)) * 255);
    }
  }
  return px;
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(size, rgba) {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head[8] = 8; // bits per channel
  head[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(rows, y * (size * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const out = new URL("../public/", import.meta.url);
for (const [name, size, bleed] of [
  ["icon-192.png", 192, false],
  ["icon-512.png", 512, false],
  ["icon-maskable-512.png", 512, true],
  ["apple-touch-icon.png", 180, true],
]) {
  writeFileSync(new URL(name, out), png(size, render(size, bleed)));
  console.log(`public/${name}`);
}
