#!/usr/bin/env python3
"""
ops/fix-dimension-mislabels.py — one-off: correct nether sightings that were stored
with dimension "overworld" (the bot.game.dimension transient-default bug fixed in
PlayerMonitor._resolveDimension).

Only sightings FAR from spawn are corrected: this fleet monitors NETHER highways
only, so a spectator physically cannot see an overworld player 50k+ blocks out — a
far "overworld" sighting is a mislabeled nether one (its coords are already nether
coords, so only the label is wrong). Near-spawn overworld sightings (post-death
spawn traffic) are genuine and left untouched.

Run on the box:  python3 ~/2b2t/ops/fix-dimension-mislabels.py [--apply]
Without --apply it's a DRY RUN (prints what it would change). Back up first.
"""
import sys, os, json, glob, tempfile

ACT_DIR = os.path.expanduser("~/2b2t/data/activity")
FAR = 50000          # blocks from spawn beyond which an "overworld" label is bogus here
APPLY = "--apply" in sys.argv

def is_overworld(d):
    return d in ("overworld", "minecraft:overworld")

changed = 0
scanned = 0
for path in sorted(glob.glob(os.path.join(ACT_DIR, "*.jsonl"))):
    out = []
    file_changed = False
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            s = line.rstrip("\n")
            if not s.strip():
                continue
            scanned += 1
            try:
                e = json.loads(s)
            except Exception:
                out.append(s)            # keep unparseable lines verbatim
                continue
            c = e.get("coords") or {}
            x, z = c.get("x"), c.get("z")
            if (is_overworld(e.get("dimension")) and isinstance(x, (int, float))
                    and isinstance(z, (int, float)) and max(abs(x), abs(z)) > FAR):
                print(f"  fix {os.path.basename(path)}: {e.get('playerName')} "
                      f"({x},{z}) overworld -> the_nether")
                e["dimension"] = "the_nether"
                changed += 1
                file_changed = True
                out.append(json.dumps(e))
            else:
                out.append(s)
    if file_changed and APPLY:
        fd, tmp = tempfile.mkstemp(dir=ACT_DIR, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as w:
            w.write("\n".join(out) + "\n")
        os.replace(tmp, path)            # atomic

print(f"\n{'APPLIED' if APPLY else 'DRY RUN'} — {changed} sighting(s) relabelled "
      f"of {scanned} scanned. {'' if APPLY else 'Re-run with --apply to write.'}")
