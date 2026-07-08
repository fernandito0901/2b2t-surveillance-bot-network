/**
 * cartography/renderRegion.js — Render a Xaero region.xaero to a 512×512 PNG terrain
 * tile (block→color via blockColors, with north-facing relief shading like a vanilla
 * map). Dependency-free PNG encoder (zlib + a tiny CRC32). Used by the local tile
 * renderer; the VPS only serves the resulting PNGs.
 */
const zlib = require('zlib');
const { decodeRegion } = require('./XaeroRegion');
const { colorOf } = require('./blockColors');

let CRC;
function crc32(buf) {
  if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
  let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0;
}

function png(w, h, rgb) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) { raw[y * (1 + w * 3)] = 0; rgb.copy(raw, y * (1 + w * 3) + 1, y * w * 3, (y + 1) * w * 3); }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** region.xaero buffer → 512×512 PNG Buffer (or null if nothing rendered). */
function renderRegion(buf) {
  const rgb = Buffer.alloc(512 * 512 * 3);
  const ht = new Int16Array(512 * 512);
  let any = false;
  decodeRegion(buf, (rx, rz, name, h) => {
    if (rx < 0 || rx > 511 || rz < 0 || rz > 511) return;
    any = true;
    const c = colorOf(name); const i = (rz * 512 + rx) * 3;
    rgb[i] = c[0]; rgb[i + 1] = c[1]; rgb[i + 2] = c[2]; ht[rz * 512 + rx] = h | 0;
  });
  if (!any) return null;
  // relief: shade each pixel vs the one to the north (−Z)
  for (let z = 511; z > 0; z--) for (let x = 0; x < 512; x++) {
    const d = ht[z * 512 + x] - ht[(z - 1) * 512 + x];
    if (!d) continue;
    const f = d > 0 ? 1.08 : 0.8, i = (z * 512 + x) * 3;
    rgb[i] = Math.min(255, rgb[i] * f); rgb[i + 1] = Math.min(255, rgb[i + 1] * f); rgb[i + 2] = Math.min(255, rgb[i + 2] * f);
  }
  return png(512, 512, rgb);
}

module.exports = { renderRegion, png };
