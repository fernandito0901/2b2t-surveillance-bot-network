/**
 * lib/wealthScore.js — Pure wealth-estimate scoring (no I/O, no config require).
 *
 * CAVEAT: wealthScore is an ESTIMATE of time+money invested that CORRELATES WITH
 * BUT DOES NOT EQUAL resource/dupe-stash wealth. It misses low-playtime dupers and
 * fresh alts, and can overrate AFK bots unless the bot filter is applied. Also:
 * api.2b2t.vc backfills playtime/kills/deaths only from when it began tracking, so
 * those fields are 0 for legacy/OG accounts — such accounts are scored from
 * joinCount + firstSeen + observed gear and are inherently lower-confidence. Never
 * present wealth as fact; always surface confidence/source.
 *
 * Kept dependency-free (cfg is passed in, never required) so it can be unit-tested
 * in isolation and reused without pulling in the app's config/I/O layers.
 */

/** Clamp n into [lo, hi]. */
function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

/** Safe base-10 log: log10(x) for x > 0, else 0 (never NaN/-Infinity). */
function log10(x) {
  return x > 0 ? Math.log(x) / Math.LN10 : 0;
}

/**
 * Fractional years elapsed since an ISO firstSeen date, or null when the date is
 * missing/invalid/in the future/before the server epoch (→ age term ABSENT).
 */
function yearsSince(firstSeen, now, serverEpochYear) {
  if (!firstSeen) return null;
  const t = Date.parse(firstSeen);
  if (Number.isNaN(t)) return null;
  if (t > now) return null; // guard future dates
  if (new Date(t).getUTCFullYear() < serverEpochYear) return null; // before 2b2t existed
  return (now - t) / (365.25 * 24 * 3600 * 1000);
}

/**
 * Gear wealth points — EXACT math moved verbatim from the old index.js _threatScore.
 * @param {string[]} gearNames
 * @returns {number} integer points
 */
function gearWealthPoints(gearNames) {
  let pts = 0;
  for (const raw of gearNames || []) {
    const n = String(raw).toLowerCase();
    if (n.includes('netherite')) pts += 3;
    else if (n.includes('diamond')) pts += 1;
    if (n.includes('elytra')) pts += 2;
    if (n.includes('totem')) pts += 2;
    if (n.includes('end_crystal') || n.includes('respawn_anchor') || n.includes('obsidian')) pts += 1;
  }
  return pts;
}

/** Coarse label for raw gear points. */
function gearWealthLabel(pts) {
  return pts >= 8 ? 'high' : pts >= 4 ? 'medium' : pts >= 1 ? 'low' : 'none';
}

/**
 * Compute a blended wealth estimate from API stats, prio status and observed gear.
 *
 * Each sub-signal is clamped [0,1]; a signal whose inputs are MISSING is ABSENT —
 * excluded from the weighted denominator, NOT scored 0. See the file-header CAVEAT.
 *
 * @param {object} args
 * @param {object|null} args.apiStats { chatsCount, joinCount, leaveCount, killCount,
 *   deathCount, firstSeen, lastSeen, playtimeSeconds, playtimeSecondsMonth } | null
 * @param {boolean|null} args.prio  true/false/null (unknown)
 * @param {boolean} args.isBot
 * @param {number} args.gearPoints  integer from gearWealthPoints()
 * @param {number} [args.maxDistance] farthest sighting distance from spawn, NETHER-normalized
 *   blocks (overworld coords /8); feeds the "remoteness" stash-proximity signal. Absent (0/
 *   undefined) on the API-only /api/wealth path.
 * @param {number} args.now         ms epoch
 * @param {object} cfg              config.wealth
 * @returns {{score:number|null,label:string,source:string,confidence:number,components:object}}
 */
function computeWealth({ apiStats, prio, isBot, gearPoints, maxDistance, now }, cfg) {
  const s = apiStats || {};
  const currentYear = new Date(now).getUTCFullYear();

  // --- gear (weighted by wGear; positive-only) ---
  const gearScore01 = gearPoints > 0 ? Math.min(1, gearPoints / cfg.gearRef) : null;

  // --- prio ---
  const prioScore = prio === true ? 1 : prio === false ? 0 : null;

  // --- age (account longevity) ---
  const yrs = yearsSince(s.firstSeen, now, cfg.serverEpochYear);
  const ageScore = yrs === null ? null : clamp(yrs / (currentYear - cfg.serverEpochYear), 0, 1);

  // --- tenure (session count) ---
  const tenureScore = s.joinCount > 0
    ? Math.min(1, log10(1 + s.joinCount) / log10(1 + cfg.joinRef))
    : null;

  // --- play (tracked playtime hours) — 0 => UNTRACKED => ABSENT (never 0) ---
  const playScore = s.playtimeSeconds > 0
    ? Math.min(1, log10(1 + s.playtimeSeconds / 3600) / log10(1 + cfg.hoursRef))
    : null;

  // --- recency (low month/total => veteran coasting => higher) ---
  // playtimeSecondsMonth must be a real number: `1 - undefined/x` is NaN, which
  // would pass the !==null present check and poison the whole weighted sum.
  const recencyScore = (s.playtimeSeconds > 0 && Number.isFinite(s.playtimeSecondsMonth))
    ? clamp(1 - s.playtimeSecondsMonth / s.playtimeSeconds, 0, 1)
    : null;

  // --- kd ---
  const kills = s.killCount || 0;
  const deaths = s.deathCount || 0;
  const kdScore = (kills + deaths) >= cfg.kdFloor ? clamp(kills / (kills + deaths), 0, 1) : null;

  // --- remoteness (STASH-PROXIMITY signal) — only a sighting notably FAR from spawn counts.
  // Stashes/bases live deep on the highways (spawn is griefed bare), so a player caught out
  // past cfg.remoteMin is more likely to have stored goods nearby. Near-spawn/mid-highway
  // sightings are ABSENT (null) — NOT 0 — so the common pass doesn't dilute the blend.
  // CAVEAT: biased by where OUR bots sit (we only see players near a sensor), so it mainly
  // discriminates once bots are placed at varied depths; harmless when it can't (stays null).
  const remoteScore = (Number.isFinite(maxDistance) && maxDistance > cfg.remoteMin && cfg.remoteRef > cfg.remoteMin)
    ? clamp((maxDistance - cfg.remoteMin) / (cfg.remoteRef - cfg.remoteMin), 0, 1)
    : null;

  // Weighted blend over PRESENT terms only (ABSENT terms drop out of the denominator).
  // Weights are RE-TARGETED toward dupe-stash likelihood (not generic account investment):
  // gear (carried wealth = direct evidence) and age (OG dupe-era stashes) lead; remoteness
  // adds observed base-proximity; K/D (combat) and recency (coasting) are de-emphasized as
  // weak predictors of hoarding.
  const terms = [
    [cfg.wGear, gearScore01],
    [cfg.wPrio, prioScore],
    [cfg.wAge, ageScore],
    [cfg.wTenure, tenureScore],
    [cfg.wPlay, playScore],
    [cfg.wRecency, recencyScore],
    [cfg.wKd, kdScore],
    [cfg.wRemote, remoteScore],
  ];
  let raw = 0;
  let denom = 0;
  let presentTermCount = 0;
  for (const [w, score] of terms) {
    if (score === null || !Number.isFinite(score)) continue; // absent or NaN-poisoned → drop from blend
    raw += w * score;
    denom += w;
    presentTermCount += 1;
  }
  const base01 = denom > 0 ? raw / denom : null;

  // Activity density gates AFK bots — but ONLY when playtime is actually tracked.
  // Tolerate both chatsCount and chatCount — the exact api.2b2t.vc field name is unverified.
  const activityDensity = ((s.chatsCount || s.chatCount || 0) + kills + deaths) / Math.max(1, (s.playtimeSeconds || 0) / 3600);
  const botGate = isBot
    ? cfg.botPenalty
    : (s.playtimeSeconds > 0 && activityDensity < cfg.afkEps) ? cfg.afkPenalty : 1.0;

  let score = base01 === null ? null : 100 * botGate * base01;

  // Gear floor (positive-only, API-down safe): guarantees a visible score from gear
  // alone even when every API term is ABSENT.
  const gearPresent = gearScore01 !== null;
  if (gearPresent) {
    score = Math.max(score || 0, 100 * cfg.gearFloor * gearScore01);
  }

  const label = score == null
    ? 'none'
    : score >= 60 ? 'high' : score >= 35 ? 'medium' : score >= 1 ? 'low' : 'none';

  const confidence = presentTermCount / terms.length;

  const anyApiTermPresent = prioScore !== null || ageScore !== null || tenureScore !== null
    || playScore !== null || recencyScore !== null || kdScore !== null;
  const source = (gearPresent && anyApiTermPresent) ? 'blend'
    : anyApiTermPresent ? 'api'
    : gearPresent ? 'gear'
    : 'none';

  const components = {
    gear: gearScore01,
    prio: prioScore,
    age: ageScore,
    tenure: tenureScore,
    play: playScore,
    recency: recencyScore,
    kd: kdScore,
    remote: remoteScore,
    botGate, // the multiplier actually applied
  };

  return { score, label, source, confidence, components };
}

module.exports = { gearWealthPoints, gearWealthLabel, computeWealth };
