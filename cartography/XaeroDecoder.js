/**
 * cartography/XaeroDecoder.js — Decode Xaero's World Map region data for stash hunting.
 *
 * A Xaero world-map region is `<X>_<Z>.zip` (one per 512×512 blocks = 32×32 chunks)
 * containing a single `region.xaero` binary. That binary embeds an NBT block-state
 * palette (`{Name:"minecraft:<block>"}` compounds) + biome names, then indexed pixel
 * data. For the MVP we read just the block palette and flag PLAYER-PLACED blocks —
 * which don't occur naturally in the nether, so they mark likely bases/stashes.
 *
 * Dependency-free: a minimal central-directory ZIP reader (handles store + deflate)
 * so we can process an uploaded zip-of-region-zips without external packages.
 */
const zlib = require('zlib');

// Player-placed blocks = strong base/stash signal. Obsidian/chest are intentionally
// excluded — both occur naturally in the nether (lava obsidian, fortress/bastion chests).
// Ubiquitous highway litter (crafting_table, plain furnace, glass, lantern, chain) is also
// excluded: nearly every explored highway region carries it, which drowned out the real
// candidates. Stronger/rarer variants (blast_furnace, smoker, sea_lantern) are kept.
const SIGNAL = /^minecraft:(.*shulker_box|ender_chest|.*_bed|blast_furnace|smoker|anvil|chipped_anvil|damaged_anvil|.*_concrete|.*_concrete_powder|.*_wool|.*_terracotta|.*_glazed_terracotta|reinforced_deepslate|respawn_anchor|barrel|hopper|dispenser|dropper|note_block|jukebox|.*_banner|.*_wall_banner|beacon|sea_lantern|bookshelf|chiseled_bookshelf|enchanting_table|tnt|sponge|wet_sponge|.*_shulker|loom|smithing_table|cartography_table|fletching_table|grindstone|stonecutter|lectern|composter|bee_nest|beehive|conduit|lodestone|target|.*_carpet|bell|.*_candle|scaffolding)$/;

// Biome names to skip when tallying "blocks" (the palette mixes blocks + biomes).
// `jungle$`/explicit `end_*` biomes are anchored so they don't swallow real block ids
// (jungle_planks/log, end_stone/rod) via the substring .test() below.
const BIOME = /(_wastes|crimson_forest|warped_forest|soul_sand_valley|basalt_deltas|the_nether|the_end|the_void|plains|forest|desert|taiga|swamp|jungle$|savanna|badlands|ocean|beach|river|tundra|mountains?|hills?|biome|end_barrens|end_highlands|end_midlands|small_end|deep_dark|grove|meadow|cherry_grove|mangrove_swamp|frozen_|snowy_|stony_|windswept|lush_caves|dripstone_caves|sunflower|mushroom_fields|ice_spikes|sparse_jungle|bamboo_jungle|flower_forest|dark_forest|birch_forest|old_growth|cold_ocean|warm_ocean|lukewarm|savanna_plateau|wooded_badlands|eroded_badlands)/;

// Zip-bomb / OOM guards. This decoder also runs server-side on upload (a ~1.9 GB box),
// so a crafted or oversized ZIP must not balloon RAM and OOM-kill the orchestrator. We
// cap per-entry decompressed size, the running total across a whole ZIP, and the entry
// count. Per-entry over-cap is skipped; a blown total/count throws so the upload route
// returns an error instead of the process dying. (See SYSTEM_AUDIT #2.)
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;    // 16 MB per decompressed entry
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;   // 256 MB decompressed across one ZIP
const MAX_ENTRIES = 20000;                   // entries processed across one ZIP

/** Locate + read a ZIP's entries via the End-Of-Central-Directory record. Returns
 *  [{ name, buffer }] with each entry decompressed (store/deflate), bounded by the
 *  MAX_* caps above. */
function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) return [];
  // EOCD signature 0x06054b50, scan backward (there may be a trailing comment).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return [];
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // central directory offset
  const out = [];
  let totalBytes = 0;
  for (let n = 0; n < total && p + 46 <= buf.length; n++) {
    if (n >= MAX_ENTRIES) throw new Error('cartography ZIP exceeds ' + MAX_ENTRIES + '-entry cap');
    if (buf.readUInt32LE(p) !== 0x02014b50) break; // central file header sig
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('latin1', p + 46, p + 46 + nameLen);
    // Local header → data start (its own name/extra lengths can differ). Bounds-check
    // localOff FIRST: a crafted/garbage offset past the buffer would make readUInt32LE
    // throw a RangeError that isn't caught by the inflate try/catch below, aborting the
    // ENTIRE zip parse — so one junk entry would silently discard an otherwise-valid
    // multi-region upload. Guard it and skip the bad entry instead.
    if (localOff + 30 <= buf.length && buf.readUInt32LE(localOff) === 0x04034b50) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const comp = buf.subarray(dataStart, dataStart + compSize);
      let data = null;
      try {
        // maxOutputLength makes zlib throw (→ skipped below) instead of allocating an
        // unbounded buffer for a single crafted entry.
        data = method === 0 ? comp : zlib.inflateRawSync(comp, { maxOutputLength: MAX_ENTRY_BYTES });
      } catch (e) { /* skip unreadable or over-cap entry */ }
      if (data) {
        totalBytes += data.length;
        // Running total across the whole ZIP: a blown cap aborts (throws past the skip
        // catch above) so the caller/upload route fails cleanly rather than OOM-ing.
        if (totalBytes > MAX_TOTAL_BYTES) {
          throw new Error('cartography ZIP exceeds ' + MAX_TOTAL_BYTES + '-byte decompression cap');
        }
        out.push({ name, buffer: data });
      }
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Scan a region.xaero buffer for its block palette + flag base-signal blocks.
 *  NOTE (#10, DEFERRED): this is the coarse REGION-level scan that processUpload wires
 *  in — so stored regions carry an empty chunks[] and candidates stay region-granular.
 *  XaeroRegion.pinpoint() already does the full per-pixel decode down to the exact 16×16
 *  chunk, but it is currently UNWIRED (see the TODO on its export). Wiring it lives in
 *  index.js (processUpload), so it is intentionally NOT done here; see followUps:
 *  "wire pinpoint into processUpload". */
function decodeRegion(regionBuf) {
  const s = regionBuf.toString('latin1');
  const names = new Set(s.match(/minecraft:[a-z0-9_]+/g) || []);
  const blocks = [], signals = [];
  for (const n of names) {
    if (BIOME.test(n)) continue;
    const short = n.replace('minecraft:', '');
    blocks.push(short);
    if (SIGNAL.test(n)) signals.push(short);
  }
  return { blocks, signals };
}

/** Parse "<x>_<z>.zip" → [x, z] (Xaero region coords), or null. */
function regionCoords(name) {
  const m = String(name).match(/(-?\d+)_(-?\d+)\.zip$/);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
}

/**
 * Process an uploaded zip that contains region zips (e.g. a zipped `mw$default`
 * folder). Returns one summary per region: coords (Xaero + nether/overworld blocks),
 * the signal blocks found, and total block variety. Nested zips are handled (the
 * outer entries are themselves `<x>_<z>.zip`).
 */
function processUpload(outerZipBuffer) {
  const entries = readZip(outerZipBuffer);
  const regions = [];
  for (const e of entries) {
    const coords = regionCoords(e.name);
    if (!coords) continue;
    // The entry is a region zip; pull its region.xaero (or any .xaero inside).
    const inner = readZip(e.buffer);
    const rx = inner.find(x => x.name.endsWith('.xaero'));
    if (!rx) continue;
    const { blocks, signals } = decodeRegion(rx.buffer);
    const [x, z] = coords;
    regions.push({
      x, z,
      netherX: x * 512, netherZ: z * 512,
      blocks: blocks.length,
      signals: [...new Set(signals)],
    });
  }
  return regions;
}

module.exports = { readZip, decodeRegion, regionCoords, processUpload, SIGNAL, BIOME };
