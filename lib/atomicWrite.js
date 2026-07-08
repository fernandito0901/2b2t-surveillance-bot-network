/**
 * lib/atomicWrite.js — Crash-safe file writes (temp file + fsync + atomic rename).
 *
 * A bare fs.writeFileSync can leave a truncated/torn file if the process is killed
 * (e.g. an OOM kill on the memory-constrained VPS) between truncate and full write.
 * On the next boot JSON.parse then throws and the caller falls back to an empty
 * default — silently losing accounts.json, users.json or settings.json. These
 * helpers write to a sibling temp file, fsync it, then rename() over the target.
 * rename is atomic on the same filesystem, so any reader (or the next boot) always
 * sees either the old or the new *complete* file, never a partial one.
 *
 * Mirrors the approach already used inline in state.js; extracted here so every
 * critical JSON write in the app can share one hardened implementation.
 */
const fs = require('fs');
const path = require('path');

/** Atomically write a string or Buffer to filePath. */
function writeFileAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // pid-scoped temp name so two writers to the same path can't clobber each
  // other's temp file; each rename is still atomic for its own writer.
  const tmp = `${filePath}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  let renamed = false;
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd); // flush to disk before the rename so a power loss can't lose it
    fs.closeSync(fd);
    fs.renameSync(tmp, filePath);
    renamed = true;
  } finally {
    // If we threw before the rename (e.g. disk full mid-write), close the fd if still
    // open and remove the orphaned temp file so failures don't accumulate .tmp litter.
    if (!renamed) {
      try { fs.closeSync(fd); } catch (e) {}
      try { fs.unlinkSync(tmp); } catch (e) {}
    }
  }
  // Best-effort directory fsync so the rename (the directory entry, not just the file
  // contents) is durable across a true power loss on ext4-style filesystems. Not fatal
  // if unsupported (e.g. Windows throws EPERM/EISDIR on a dir fd) — the rename already
  // gives crash/kill safety; this only hardens the power-loss corner.
  try { const dfd = fs.openSync(dir, 'r'); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch (e) {}
}

/** Atomically write an object as pretty JSON (2-space indent by default). */
function writeJsonAtomic(filePath, obj, { spaces = 2 } = {}) {
  writeFileAtomic(filePath, JSON.stringify(obj, null, spaces));
}

module.exports = { writeFileAtomic, writeJsonAtomic };
