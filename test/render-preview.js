/* 生成预览 PNG 供人工检查：node test/render-preview.js [seed] */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const WoodGen = require('../wood.js');

// 最小 PNG 编码器（RGBA, 无滤波）
function crc32(buf) {
  let table = crc32.t;
  if (!table) {
    table = crc32.t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePNG(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (1 + w * 4) + 1);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const seed = parseInt(process.argv[2] || '20260101', 10);
const P = {
  seed, plankW: 128, plankL: 512, stagger: 0.5,
  rings: 6, distort: 0.4, knotProb: 0.35,
  colorVar: 0.5, gloss: 0.5, groove: 0.7
};
const S = 512;
const g = WoodGen.generate(S, P);
const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

for (const map of ['albedo', 'normal', 'roughness']) {
  fs.writeFileSync(path.join(outDir, `${map}.png`), encodePNG(g[map], S, S));
}

// 3×3 平铺预览（底色 + 法线）
for (const map of ['albedo', 'normal']) {
  const big = new Uint8ClampedArray(S * 3 * S * 3 * 4);
  for (let y = 0; y < S * 3; y++) for (let x = 0; x < S * 3; x++) {
    const si = ((y % S) * S + (x % S)) * 4, di = (y * S * 3 + x) * 4;
    for (let k = 0; k < 4; k++) big[di + k] = g[map][si + k];
  }
  fs.writeFileSync(path.join(outDir, `tile3x3_${map}.png`), encodePNG(big, S * 3, S * 3));
}
console.log('written to', outDir);
