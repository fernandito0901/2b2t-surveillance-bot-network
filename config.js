/**
 * config.js — Central configuration for the 2b2t bot network.
 * All settings in one place. Override via .env where noted.
 */
require('dotenv').config();

// Parse env numbers WITHOUT the `parseFloat(x) || default` idiom, which silently
// swallows a legitimate 0 (e.g. setting a wealth weight to 0 to disable that signal
// would revert to the default). These treat only NaN/missing as "use the default".
const numf = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const numi = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

const config = {
  // ── Server Connection ───────────────────────────────────────
  server: {
    // In the hybrid model, mineflayer connects to a local ZenithProxy endpoint
    // (which holds the real 2b2t session). Point it there with:
    //   SERVER_HOST=127.0.0.1  SERVER_PORT=<zenith port>  SERVER_AUTH=offline
    host: process.env.SERVER_HOST || '127.0.0.1', // Set SERVER_HOST=2b2t.org for direct prod
    port: parseInt(process.env.SERVER_PORT, 10) || 25565,
    version: process.env.SERVER_VERSION || '1.21.4',
    auth: process.env.SERVER_AUTH || 'microsoft', // 'offline' when going through ZenithProxy
  },

  // ── Gameplay Constants ──────────────────────────────────────
  gameplay: {
    /** Default Y for spots added via the dashboard */
    highwayY: 121,
    /** Nether-to-overworld coordinate multiplier (map rendering) */
    netherScale: 8,
    /** mineflayer monitor view distance — kept low to save RAM/CPU. Player
     *  entities still arrive within the proxy's tracking range, so detection
     *  is unaffected. 'tiny'|'short'|'normal'|'far' or a chunk count. */
    monitorViewDistance: process.env.MONITOR_VIEW_DISTANCE || 'short',
  },

  // ── Timing ──────────────────────────────────────────────────
  timing: {
    /** Seconds to wait after a monitor kick before reconnecting */
    kickReconnectDelay: 30,
    /** Milliseconds between entity scan ticks */
    entityScanInterval: 1000,
    /** Milliseconds between position saves */
    stateSaveInterval: 60_000,
    /** Seconds to wait for the mineflayer spectator's 'spawn' before quitting for a
     *  clean reconnect (guards a zombie monitor that logs in but never spawns). */
    monitorSpawnTimeout: numi(process.env.MONITOR_SPAWN_TIMEOUT, 45),
  },

  // ── Stuck remediation ───────────────────────────────────────
  // Auto-remediation swaps a dead proxy + restarts an account's ZenithProxy, which sends
  // it to the BACK of the hours-long non-priority queue — the most expensive resource in
  // the system. So beyond an explicit proxy error, it fires ONLY on a positive "truly
  // stuck" signal: a long idle stretch AND a frozen pane (no new output) across several
  // polls — never merely because the pane momentarily lacked a queue line.
  remediation: {
    /** Min ms an account must look idle/offline before the frozen-pane path can remediate. */
    stuckIdleMs: parseInt(process.env.STUCK_IDLE_MS, 10) || 180_000,
    /** Consecutive 15s polls the pane must show NO new output (frozen) to confirm stuck. */
    stuckFrozenTicks: parseInt(process.env.STUCK_FROZEN_TICKS, 10) || 8,
    /** Debounce between auto-remediations for the same account. */
    cooldownMs: parseInt(process.env.STUCK_COOLDOWN_MS, 10) || 600_000,
  },

  // ── Owner ───────────────────────────────────────────────────
  owner: {
    ign: process.env.OWNER_IGN || 'YourIGN',
  },

  // ── Whitelist ───────────────────────────────────────────────
  // Players that should NOT trigger a proximity disconnect. They are still
  // tracked and logged like anyone else — useful for testing. The owner IGN
  // is always whitelisted automatically. Override via WHITELIST=Name1,Name2.
  whitelist: (process.env.WHITELIST || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),

  // ── Watchlist (priority alerts) ─────────────────────────────
  // Players that, when spotted by the monitor, fire a dedicated high-priority
  // Discord alert (on top of the normal sighting log) — rivals, known griefers,
  // people whose movements you care about. Managed live from dashboard Settings.
  // Override via WATCHLIST=Name1,Name2.
  watchlist: (process.env.WATCHLIST || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),

  // ── Proxy access whitelist ──────────────────────────────────
  // Real Minecraft accounts allowed to CONNECT to the ZenithProxy instances to
  // drive/control the bots (ZenithProxy `server.extra.whitelist`). Each account's
  // own IGN is auto-added by ZenithProxy; this is for your personal account(s).
  // Override via PROXY_WHITELIST=Name1,Name2.
  proxyWhitelist: (process.env.PROXY_WHITELIST || process.env.OWNER_IGN || 'YourIGN')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),

  // ── Discord ─────────────────────────────────────────────────
  discord: {
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
    /** Per-sighting Discord pings: 'off' (watchlist + ops alerts only — recommended,
     *  avoids flooding a busy highway), 'exit' (one ping per completed pass), or 'all'
     *  (enter + exit). The dashboard feed + map always log every sighting regardless. */
    sightingAlerts: process.env.DISCORD_SIGHTING_ALERTS || 'off',
  },

  // ── Fleet ───────────────────────────────────────────────────
  // Each account runs its own ZenithProxy (in a detached tmux session) holding
  // its 2b2t session; the shared monitor IGN spectates them to log players.
  fleet: {
    /** Base bind port; new accounts auto-assign the next free port from here. */
    basePort: parseInt(process.env.FLEET_BASE_PORT, 10) || 25571,
    monitorIgn: process.env.MONITOR_IGN || '', // shared spectator identity (a real IGN)
    /** Public host/IP players use to connect + drive the bots (shown in the
     *  "IN THE SERVER" Discord ping). Set per-host via PUBLIC_HOST. */
    publicHost: process.env.PUBLIC_HOST || '',
  },

  // ── Dashboard ───────────────────────────────────────────────
  dashboard: {
    port: parseInt(process.env.DASHBOARD_PORT, 10) || 3000,
    host: process.env.DASHBOARD_HOST || '0.0.0.0',
    /** Only trust X-Forwarded-For when actually behind a reverse proxy. Direct
     *  access (default) uses the socket IP so the IP log can't be spoofed. */
    trustProxy: process.env.TRUST_PROXY === 'true',
  },

  // ── Logging ─────────────────────────────────────────────────
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    activityDir: './data/activity',
    /** Auto-delete activity files older than N days on startup (0 = keep forever) */
    retentionDays: parseInt(process.env.ACTIVITY_RETENTION_DAYS, 10) || 0,
  },

  // ── Proxies ─────────────────────────────────────────────────
  // SOCKS pool. Synced from the Webshare API when WEBSHARE_API_KEY is set
  // (cached to localFile as a fallback). Each account past the first is assigned
  // a distinct, health-checked proxy IP — 2b2t rate-limits accounts per IP.
  proxies: {
    // Plan-specific Webshare download link (preferred — returns ONLY that plan's
    // proxies, e.g. your static residential set). Falls back to the account API
    // key, then the cached local file.
    listUrl: process.env.WEBSHARE_PROXY_LIST_URL || '',
    webshareApiKey: process.env.WEBSHARE_API_KEY || '',
    localFile: './data/proxies.txt',
    /** On (re)provision, swap an account off any proxy slower than this (ms) and
     *  pick the closest working one instead. Far proxies destabilise the game
     *  connection — from the US VPS, US proxies measure ~70-125ms, EU ~350-530ms,
     *  Asia ~800ms. Override via PROXY_MAX_LATENCY_MS. */
    maxLatencyMs: parseInt(process.env.PROXY_MAX_LATENCY_MS, 10) || 250,
    /** Preferred proxy countries (ISO codes via Webshare's country_code), tried
     *  first by the picker before anything else. From a US VPS, US (+CA) are the
     *  closest/fastest; it still falls back to other countries if none work.
     *  Override via PROXY_PREFER_COUNTRIES=US,CA,GB. */
    preferCountries: (process.env.PROXY_PREFER_COUNTRIES || 'US,CA')
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
  },

  // ── Wealth intel ────────────────────────────────────────────
  /*
   * wealthScore is an ESTIMATE of time+money invested that CORRELATES WITH BUT
   * DOES NOT EQUAL resource/dupe-stash wealth. It misses low-playtime dupers and
   * fresh alts, and can overrate AFK bots unless the bot filter is applied. Also:
   * api.2b2t.vc backfills playtime/kills/deaths only from when it began tracking,
   * so those fields are 0 for legacy/OG accounts — such accounts are scored from
   * joinCount + firstSeen + observed gear and are inherently lower-confidence.
   * Never present wealth as fact; always surface confidence/source.
   */
  wealth: {
    enabled: process.env.WEALTH_ENABLED !== 'false',                 // kill-switch, fail-open
    apiBase: process.env.WEALTH_API_BASE || 'https://api.2b2t.vc',
    userAgent: process.env.WEALTH_USER_AGENT || '2b2t-highway-surveillance/1.0 (+dashboard intel)',
    /** Min ms between outbound API requests (client-side rate limit). */
    minRequestSpacingMs: parseInt(process.env.WEALTH_MIN_REQUEST_SPACING_MS, 10) || 1500,
    /** Exponential backoff floor/ceiling on API errors. */
    backoffStartMs: parseInt(process.env.WEALTH_BACKOFF_START_MS, 10) || 2000,
    backoffMaxMs: parseInt(process.env.WEALTH_BACKOFF_MAX_MS, 10) || 60000,
    /** Per-request network timeout. */
    requestTimeoutMs: parseInt(process.env.WEALTH_REQUEST_TIMEOUT_MS, 10) || 8000,
    /** Max pending lookups held in the fetch queue. */
    maxQueue: parseInt(process.env.WEALTH_MAX_QUEUE, 10) || 200,
    /** Cap on lookups auto-enqueued from a single peek/sighting burst. */
    peekEnqueueCap: parseInt(process.env.WEALTH_PEEK_ENQUEUE_CAP, 10) || 25,
    cacheTtlMs: parseInt(process.env.WEALTH_CACHE_TTL_MS, 10) || 43200000,      // 12h positive
    negativeTtlMs: parseInt(process.env.WEALTH_NEGATIVE_TTL_MS, 10) || 3600000,    // 1h  (204 no-data)
    errorTtlMs: parseInt(process.env.WEALTH_ERROR_TTL_MS, 10) || 300000,        // 5m  (transient error)
    priorsTtlMs: parseInt(process.env.WEALTH_PRIORS_TTL_MS, 10) || 1800000,      // 30m (/players/priority + /bots/month)
    /** Scoring feature weights. numf() so a weight can be set to 0 to disable that signal.
     *  RE-TARGETED for dupe-stash likelihood (2026-07-01): gear (carried wealth = direct
     *  evidence) and age (OG dupe-era stashes) lead; remoteness (deep-highway = base nearby)
     *  added; K/D (combat) and recency (coasting) cut as weak stash predictors. */
    wGear: numf(process.env.WEALTH_W_GEAR, 0.24),
    wPrio: numf(process.env.WEALTH_W_PRIO, 0.17),
    wAge: numf(process.env.WEALTH_W_AGE, 0.17),
    wTenure: numf(process.env.WEALTH_W_TENURE, 0.11),
    wPlay: numf(process.env.WEALTH_W_PLAY, 0.10),
    wRecency: numf(process.env.WEALTH_W_RECENCY, 0.06),
    wKd: numf(process.env.WEALTH_W_KD, 0.04),
    wRemote: numf(process.env.WEALTH_W_REMOTE, 0.14),
    /** Normalisation reference points for the scoring features. */
    joinRef: parseInt(process.env.WEALTH_JOIN_REF, 10) || 1000,
    hoursRef: parseInt(process.env.WEALTH_HOURS_REF, 10) || 2000,
    // gearRef calibration: plain netherite armor (4×3=12 pts) is the DEFAULT highway
    // kit and must not saturate the gear signal (was 12 → armor alone scored 100 on
    // the gear-only path). At 24: armor-only → 0.5 ('medium'); a full kit with
    // elytra+totem+netherite weapon (~16-17 pts) → ~0.7 ('high'); 1.0 needs
    // armor+elytra+totem+weapon+crystals — genuinely stacked.
    gearRef: parseInt(process.env.WEALTH_GEAR_REF, 10) || 24,
    kdFloor: parseInt(process.env.WEALTH_KD_FLOOR, 10) || 50,
    // Remoteness (stash-proximity) window, NETHER blocks from spawn: sightings inside
    // remoteMin don't count (common mid-highway pass); remoteRef is where it saturates to 1.
    remoteMin: parseInt(process.env.WEALTH_REMOTE_MIN, 10) || 150000,
    remoteRef: parseInt(process.env.WEALTH_REMOTE_REF, 10) || 1000000,
    serverEpochYear: parseInt(process.env.WEALTH_SERVER_EPOCH_YEAR, 10) || 2011,
    gearFloor: numf(process.env.WEALTH_GEAR_FLOOR, 0.5),
    /** Bot/AFK score penalties and the AFK detection epsilon (numf → 0 is honored). */
    botPenalty: numf(process.env.WEALTH_BOT_PENALTY, 0.15),
    afkPenalty: numf(process.env.WEALTH_AFK_PENALTY, 0.30),
    afkEps: numf(process.env.WEALTH_AFK_EPS, 0.5),
    persistPath: process.env.WEALTH_PERSIST_PATH || './data/wealth/cache.json',
  },

  // ── Paths ───────────────────────────────────────────────────
  paths: {
    accounts: './data/accounts.json',
    groups: './data/groups.json',
    settings: './data/settings.json',
    state: './data/state.json',
  },
};

module.exports = config;
