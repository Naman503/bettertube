// Renders the toolbar icon (rounded dark square, red play triangle, sidebar
// lines) to PNGs without any image library: supersampled coverage + zlib.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZES = [16, 32, 48, 128];
const BG = [24, 24, 27];
const RED = [239, 68, 68];
const LINE = [212, 212, 216];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) raw.set(pixel(x, y), y * (size * 4 + 1) + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shapes in unit coordinates (0..1).
const inRoundRect = (x, y, r = 0.22) => {
  const dx = Math.max(r - x, 0, x - (1 - r));
  const dy = Math.max(r - y, 0, y - (1 - r));
  return dx * dx + dy * dy <= r * r;
};
const inTriangle = (x, y) => {
  // Play triangle on the left: (0.2,0.27) (0.2,0.73) (0.58,0.5)
  const [ax, ay, bx, by, cx, cy] = [0.2, 0.27, 0.2, 0.73, 0.58, 0.5];
  const s = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = s(x, y, ax, ay, bx, by), d2 = s(x, y, bx, by, cx, cy), d3 = s(x, y, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};
// Three "up next" lines on the right.
const inLines = (x, y) => x > 0.66 && x < 0.84 && [0.3, 0.47, 0.64].some((t) => y > t && y < t + 0.07);

function render(size) {
  const SS = 4;
  return png(size, (px, py) => {
    let a = 0, r = 0, g = 0, b = 0;
    for (let i = 0; i < SS; i++) for (let j = 0; j < SS; j++) {
      const x = (px + (i + 0.5) / SS) / size, y = (py + (j + 0.5) / SS) / size;
      if (!inRoundRect(x, y)) continue;
      const c = inTriangle(x, y) ? RED : inLines(x, y) ? LINE : BG;
      a++; r += c[0]; g += c[1]; b += c[2];
    }
    return a ? [r / a, g / a, b / a, (255 * a) / (SS * SS)].map(Math.round) : [0, 0, 0, 0];
  });
}

mkdirSync('static/icons', { recursive: true });
for (const size of SIZES) writeFileSync(`static/icons/icon-${size}.png`, render(size));
console.log(`Wrote ${SIZES.length} icons to static/icons/`);
