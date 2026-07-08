/**
 * cartography/XaeroRegion.js — Full per-pixel decoder for Xaero `region.xaero`.
 *
 * Ported from DanDucky/XaerosMapFormat (the reference C++ reader). Walks the real
 * structure — Region → 8×8 tiles → 4×4 chunks → 16×16 pixels — so we can pinpoint
 * *which 16×16 chunk* inside a 512×512 region holds player-placed blocks, instead of
 * only knowing the region. Targets the modern format (major 7, minor 8 = 2b2t's data);
 * reads enough of every field to advance correctly, keeps block-state names per chunk.
 *
 * Format notes: Java big-endian; getNext<T> is BE; strings are readUTF (u16 len +
 * modified-UTF8, ASCII for our names); pixel "parameters" are a u32 read BE then bits
 * extracted LSB-first; empty chunks are an i32 == -1.
 */

class Reader {
  constructor(buf) { this.b = buf; this.p = 0; this.len = buf.length; }
  eof() { return this.p >= this.len; }
  u8() { return this.b[this.p++]; }
  i8() { const v = this.b[this.p++]; return v < 128 ? v : v - 256; }
  u16() { const v = (this.b[this.p] << 8) | this.b[this.p + 1]; this.p += 2; return v; }
  i16() { const v = this.u16(); return v < 32768 ? v : v - 65536; }
  u32() { const v = ((this.b[this.p] << 24) | (this.b[this.p + 1] << 16) | (this.b[this.p + 2] << 8) | this.b[this.p + 3]) >>> 0; this.p += 4; return v; }
  i32() { const v = this.u32(); return v < 0x80000000 ? v : v - 0x100000000; }
  peekI32() { return ((this.b[this.p] << 24) | (this.b[this.p + 1] << 16) | (this.b[this.p + 2] << 8) | this.b[this.p + 3]); }
  skip(n) { this.p += n; }
  remaining() { return this.len - this.p; }
  mutf() { const len = this.u16(); const s = this.b.toString('latin1', this.p, this.p + len); this.p += len; return s; }
}

/** Bit cursor over a u32, LSB-first (matches Xaero's BitView). */
class Bits {
  constructor(v) { this.v = v >>> 0; this.pos = 0; }
  get(n) { const out = (this.v >>> this.pos) & ((n >= 32 ? 0xFFFFFFFF : (1 << n) - 1) >>> 0); this.pos += n; return out; }
  skip(n) { this.pos += n; }
  toNextByte() { this.pos = ((this.pos >> 3) + 1) << 3; }
}

/** Read one NBT compound (rooted: type byte + name + body…TAG_End). Returns the
 *  top-level "Name" string (the block id) and advances the reader. Minimal but covers
 *  every tag type so it never desyncs on a block state's Properties. */
function readNbtCompound(r) {
  const type = r.u8();              // expect 10 (TAG_Compound)
  r.skip(r.u16());                  // compound's own name (usually empty)
  let blockName = null;
  for (;;) {
    const t = r.u8();
    if (t === 0) break;             // TAG_End
    const nameLen = r.u16();
    const tagName = r.b.toString('latin1', r.p, r.p + nameLen); r.p += nameLen;
    const val = readNbtPayload(r, t);
    if (tagName === 'Name' && typeof val === 'string') blockName = val;
  }
  return blockName;
}

// Every count/length comes from UNTRUSTED bytes. Bounding each against the remaining
// buffer (each list/array element is ≥1 byte, so a valid count can't exceed the bytes
// left) turns a crafted `n = 0x7FFFFFFF` from a ~2-billion-iteration CPU hang / OOM into
// an immediate throw. Harmless while pinpoint() is dead code, but this parser is slated
// to run on untrusted uploads — cap before that wiring lands. `arr(n, bytes)` validates.
function readNbtPayload(r, t) {
  const arr = (n, bytes) => { if (!Number.isFinite(n) || n < 0 || n * bytes > r.remaining()) throw new Error('NBT length out of bounds: ' + n); return n; };
  switch (t) {
    case 1: return r.i8();
    case 2: return r.i16();
    case 3: return r.i32();
    case 4: r.skip(8); return null;                 // long
    case 5: r.skip(4); return null;                 // float
    case 6: r.skip(8); return null;                 // double
    case 7: { const n = arr(r.i32(), 1); r.skip(n); return null; }            // byte array
    case 8: { const n = arr(r.u16(), 1); const s = r.b.toString('latin1', r.p, r.p + n); r.p += n; return s; } // string
    case 9: { const et = r.u8(); const n = arr(r.i32(), 1); for (let i = 0; i < n; i++) readNbtPayload(r, et); return null; } // list
    case 10: { for (;;) { if (r.eof()) throw new Error('NBT compound not terminated'); const tt = r.u8(); if (tt === 0) break; r.skip(r.u16()); readNbtPayload(r, tt); } return null; } // compound
    case 11: { const n = arr(r.i32(), 4); r.skip(n * 4); return null; }       // int array
    case 12: { const n = arr(r.i32(), 8); r.skip(n * 8); return null; }       // long array
    default: throw new Error('bad NBT tag ' + t);
  }
}

/**
 * Decode a region.xaero buffer. Returns { major, minor, ok, chunks } where chunks is
 * a Map of "cx,cz" (chunk coords 0..31 within the region) → Set(block names present).
 * `ok` is true if the walk consumed the buffer cleanly (no desync).
 */
function decodeRegion(buf, onPixel) {
  const r = new Reader(buf);
  const statePalette = [];   // block-state names by index
  const biomePalette = [];
  const chunks = new Map();  // "cx,cz" -> Set(names)
  let major = 0, minor = 0;

  if (buf[r.p] === 0xFF) { r.skip(1); major = r.i16(); minor = r.i16(); if (major === 2 && minor >= 5) r.u8(); }
  const usesColorTypes = minor < 5 || (major <= 2);
  const COLOR_NONE = 0, COLOR_CUSTOM_BIOME = 3; // enum order in reference

  for (let tc = 0; tc < 64 && !r.eof(); tc++) {
    const coord = new Bits(r.u8());
    const tileZ = coord.get(4), tileX = coord.get(4);
    for (let cx = 0; cx < 4; cx++) {
      for (let cz = 0; cz < 4; cz++) {
        if (r.peekI32() === -1) { r.skip(4); continue; }
        const relCx = tileX * 4 + cx, relCz = tileZ * 4 + cz;
        const names = new Set();
        for (let pz = 0; pz < 16; pz++) {
          for (let px = 0; px < 16; px++) {
            const par = new Bits(r.u32());
            const isNotGrass = par.get(1);
            const hasOverlays = par.get(1);
            let colorType = COLOR_NONE;
            if (usesColorTypes) colorType = par.get(2); else par.skip(2);
            const hasSlope = (minor === 2) ? par.get(1) : (par.skip(1), 0);
            par.skip(1);
            const heightInParams = !par.get(1);
            par.toNextByte();
            par.skip(4); // light
            let pixHeight = 0;
            if (heightInParams) pixHeight = par.get(8); else par.skip(8);
            const hasBiome = par.get(1);
            const newState = par.get(1);
            const newBiome = par.get(1);
            const biomeAsInt = par.get(1);
            const topHeightDontMatch = (minor >= 4) ? par.get(1) : 0;
            if (heightInParams) { pixHeight |= par.get(4) << 8; pixHeight &= 0xFFF; if (pixHeight & 0x800) pixHeight |= ~0xFFF; }

            // ── block state ──
            let stateName = null;
            if (isNotGrass) {
              if (major === 0) { r.i32(); stateName = null; }
              else if (newState) { stateName = readNbtCompound(r); statePalette.push(stateName); }
              else { stateName = statePalette[r.i32()]; }
            } else stateName = 'minecraft:grass_block';
            if (stateName) names.add(stateName);

            if (!heightInParams) pixHeight = r.u8();  // height byte
            if (topHeightDontMatch) r.u8();           // topHeight byte
            if (onPixel) onPixel(relCx * 16 + px, relCz * 16 + pz, stateName, pixHeight);

            if (hasOverlays) {
              const size = r.u8();
              for (let o = 0; o < size; o++) {
                const op = new Bits(r.u32());
                const isWater = !op.get(1);
                op.get(1);                  // legacyOpacity
                const customColor = op.get(1);
                op.get(1);                  // hasOpacity
                op.get(4);                  // light
                if (usesColorTypes) op.get(2); else op.skip(2);
                const newOverlayState = op.get(1);
                if (minor >= 8) op.get(4);  // opacity
                if (!isWater) {
                  if (major === 0) r.i32();
                  else if (newOverlayState) { const n = readNbtCompound(r); statePalette.push(n); }
                  else r.u32();
                }
                if (minor < 1) { /* legacyOpacity skip handled by version */ }
                if (customColor) r.skip(4);
                if (minor < 8) { /* hasOpacity i32 — not for v7.8 */ }
              }
            }

            if (colorType !== COLOR_NONE && colorType !== COLOR_CUSTOM_BIOME || hasBiome) {
              if (major < 4) {
                const bb = r.u8();
                if (minor >= 3 && bb >= 255) r.i32();
              } else if (newBiome) {
                if (biomeAsInt) r.i32(); else r.mutf();
                biomePalette.push(1);
              } else r.u32();
            }
            if (minor === 2 && hasSlope) r.skip(1);
          }
        }
        if (relCx < 32 && relCz < 32) chunks.set(relCx + ',' + relCz, names);
        if (minor >= 4) r.i8();              // chunkInterpretationVersion
        if (minor >= 6) { r.i32(); if (minor >= 7) r.i8(); } // caveStart / caveDepth
      }
    }
  }
  return { major, minor, ok: Math.abs(r.p - r.len) <= 2, consumed: r.p, len: r.len, chunks };
}

const { SIGNAL } = require('./XaeroDecoder');

/** Full-decode + return only the chunks (16×16) containing player-placed blocks,
 *  with chunk coords 0..31 within the region. Plus the region-level signal union.
 *
 *  TODO (#10, DEFERRED): DEAD CODE in production — pinpoint() is not wired into the
 *  upload path. processUpload (XaeroDecoder.js) uses the coarse region-level decode, so
 *  stored regions have empty chunks[] and candidates never reach chunk granularity. To
 *  enable per-chunk stash pinpointing, call pinpoint() from processUpload (the wiring
 *  lives in index.js) and persist the returned chunks[]. Not done in this pass because it
 *  changes behavior and touches a file this package does not own. */
function pinpoint(buf) {
  const { ok, major, minor, chunks } = decodeRegion(buf);
  // A desync'd walk (ok=false) can leave garbage block names in `chunks`; don't
  // emit candidates from it. Clean v7.8 data always walks fully (ok=true).
  if (!ok) return { ok, major, minor, chunks: [], signals: [] };
  const out = [], union = new Set();
  for (const [k, names] of chunks) {
    const sig = [];
    for (const n of names) if (SIGNAL.test(n)) { const s = n.replace('minecraft:', ''); sig.push(s); union.add(s); }
    if (sig.length) { const [cx, cz] = k.split(',').map(Number); out.push({ cx, cz, signals: [...new Set(sig)] }); }
  }
  return { ok, major, minor, chunks: out, signals: [...union] };
}

// TODO (#10, DEFERRED): `pinpoint` is exported but not required anywhere in prod. Wire it
// into processUpload (index.js) to deliver per-chunk stash candidates — see followUps.
module.exports = { decodeRegion, pinpoint };
