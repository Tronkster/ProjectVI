// Draws the ProjectVI icon (orange rounded square with a pixel "VI") and writes it as PNG.
// No image libraries: the PNG is encoded by hand with node:zlib.
// Usage: npm run icons   -> src/assets/icon.png (512), src/assets/tray.png (32)

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ORANGE = [0xff, 0x6a, 0x1a];
const INK = [0x08, 0x09, 0x0c];

// 9x7 bitmap: "V", one column gap, "I".
const GLYPH = [
  "1...1.111",
  "1...1..1.",
  "1...1..1.",
  "1...1..1.",
  ".1.1...1.",
  ".1.1...1.",
  "..1...111"
];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0; // no filter
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// Coverage (0..1) of pixel (x, y) by a rounded square, sampled 4x4 for smooth edges.
function squareCoverage(x, y, size, radius) {
  let hits = 0;
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const px = x + (sx + 0.5) / 4;
      const py = y + (sy + 0.5) / 4;
      const dx = Math.max(radius - px, px - (size - radius), 0);
      const dy = Math.max(radius - py, py - (size - radius), 0);
      if (dx * dx + dy * dy <= radius * radius) hits++;
    }
  }
  return hits / 16;
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const cell = Math.floor((size * 0.62) / GLYPH[0].length);
  const glyphW = cell * GLYPH[0].length;
  const glyphH = cell * GLYPH.length;
  const left = Math.round((size - glyphW) / 2);
  const top = Math.round((size - glyphH) / 2);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const cover = squareCoverage(x, y, size, radius);
      const gx = Math.floor((x - left) / cell);
      const gy = Math.floor((y - top) / cell);
      const ink = x >= left && y >= top && gy < GLYPH.length && gx < GLYPH[0].length && GLYPH[gy][gx] === "1";
      const [r, g, b] = ink ? INK : ORANGE;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = Math.round(cover * 255);
    }
  }
  return encodePng(size, rgba);
}

const outDir = path.join(__dirname, "..", "src", "assets");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "icon.png"), drawIcon(512));
fs.writeFileSync(path.join(outDir, "tray.png"), drawIcon(32));
console.log(`Icons written to ${outDir}`);
