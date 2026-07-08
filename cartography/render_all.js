/**
 * cartography/render_all.js — Batch render all Xaero region zips to 512×512 PNG tiles.
 *
 * Usage:
 *   node cartography/render_all.js <input-dir> <output-dir> [--dim nether|overworld]
 *
 * Example:
 *   node cartography/render_all.js "C:\Users\...\mw$default" "C:\tiles\overworld"
 *
 * Reads every <x>_<z>.zip in the input directory, extracts region.xaero via the
 * built-in ZIP reader, decodes it with the fixed XaeroRegion.js, and writes a
 * 512×512 PNG terrain tile (with relief shading) to the output directory.
 * Skips subdirectories (cache/, caves/). Skips already-rendered tiles when the
 * output PNG exists and is newer than the source zip.
 */
const fs = require('fs');
const path = require('path');
const { renderRegion } = require('./renderRegion');
const { readZip } = require('./XaeroDecoder');

const args = process.argv.slice(2);
const inputDir = args[0];
const outputDir = args[1];

if (!inputDir || !outputDir) {
  console.error('Usage: node render_all.js <input-dir-with-region-zips> <output-dir-for-pngs>');
  process.exit(1);
}

if (!fs.existsSync(inputDir)) { console.error('Input directory not found: ' + inputDir); process.exit(1); }
fs.mkdirSync(outputDir, { recursive: true });

const files = fs.readdirSync(inputDir).filter(f => f.match(/^-?\d+_-?\d+\.zip$/));
console.log(`Found ${files.length} region zips in ${inputDir}`);
console.log(`Output: ${outputDir}\n`);

let rendered = 0, skipped = 0, failed = 0, empty = 0;
const start = Date.now();

for (let i = 0; i < files.length; i++) {
  const f = files[i];
  const outName = f.replace(/\.zip$/, '.png');
  const outPath = path.join(outputDir, outName);

  // Skip if the output exists and is newer than the source
  if (fs.existsSync(outPath)) {
    const srcStat = fs.statSync(path.join(inputDir, f));
    const outStat = fs.statSync(outPath);
    if (outStat.mtimeMs >= srcStat.mtimeMs) { skipped++; continue; }
  }

  try {
    const zipBuf = fs.readFileSync(path.join(inputDir, f));
    const entries = readZip(zipBuf);
    const rx = entries.find(e => e.name.endsWith('.xaero') || e.name === 'region.xaero');
    if (!rx) { empty++; continue; }
    const png = renderRegion(rx.buffer);
    if (!png) { empty++; continue; }
    fs.writeFileSync(outPath, png);
    rendered++;
  } catch (e) {
    failed++;
    if (failed <= 5) console.error(`  FAIL ${f}: ${e.message}`);
  }

  // Progress every 500 regions or at the end
  if ((i + 1) % 500 === 0 || i === files.length - 1) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const pct = ((i + 1) / files.length * 100).toFixed(1);
    console.log(`  [${pct}%] ${i + 1}/${files.length} — ${rendered} rendered, ${skipped} skipped, ${empty} empty, ${failed} failed (${elapsed}s)`);
  }
}

const totalSec = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\nDone in ${totalSec}s. Rendered: ${rendered}, skipped: ${skipped}, empty: ${empty}, failed: ${failed}`);
