/**
 * bot/modules/PlayerMonitor.js — Core surveillance module.
 * Scans for nearby players, calculates movement data, and triggers alerts.
 */
const config = require('../../config');
const state = require('../../state');
const discord = require('../../logging/DiscordNotifier');

class PlayerMonitor {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {import('../../logging/Logger').Logger} logger
   * @param {object} spotConfig - { id, highway, netherCoords, ... }
   * @param {object} account - the monitored spot-holder account (for attribution)
   */
  constructor(bot, logger, spotConfig, account) {
    this.bot = bot;
    this.logger = logger;
    this.spotConfig = spotConfig;
    this.account = account || null;
    this._interval = null;
    this._running = false;

    /** Tracks players currently in render distance */
    this._activePlayers = new Map();
    // playerName → { entryPos, lastPos, entryTime, lastTime, equipment }

    /** lowerName → ts of last watchlist alert, to avoid spamming on re-entry. */
    this._watchAlertedAt = new Map();

    /** lowerName → ts of last RECORDED sighting, to suppress render-edge flicker
     *  so a single lingering/re-entering player is not re-logged every scan. */
    this._lastSightingAt = new Map();

    /** Confirmed dimension for stamping sightings, resolved once per scan. See
     *  _resolveDimension — mineflayer's bot.game.dimension transiently reads
     *  'overworld' for this spectator, which mislabeled nether sightings. */
    this._confirmedDim = null;   // last TRUSTED dimension (minecraft:-prefixed)
    this._owConfirm = 0;         // consecutive 'overworld' reads pending confirmation
    this._scanDimension = null;  // dimension to stamp on THIS scan's sightings
  }

  /** Cooldown between watchlist alerts for the same player (ms). */
  get WATCH_COOLDOWN_MS() { return 10 * 60 * 1000; }

  /** Consecutive scans an 'overworld' read must hold before we switch a
   *  known nether/end spectator to overworld (~4s at the 1s scan interval). */
  get OVERWORLD_CONFIRM() { return 4; }

  /**
   * Resolve the spectator's CURRENT dimension robustly, called ONCE per scan.
   *
   * mineflayer's `bot.game.dimension` is unreliable for a ZenithProxy spectator: it
   * transiently reports 'overworld' (its default before the dimension packet lands
   * at attach, and in the brief window after the watched account dies + respawns at
   * spawn). That stamped nether-highway sightings as 'overworld', so they plotted on
   * the OVERWORLD map's rings (the 100k-spot-in-overworld bug).
   *
   * Fix: a specific dimension (the_nether / the_end) is trustworthy immediately;
   * an 'overworld' reading is only accepted after it holds for OVERWORLD_CONFIRM
   * consecutive scans, so a transient default can't retag a nether bot's sightings.
   * A genuine, sustained overworld presence still resolves within a few seconds.
   * @returns {string} minecraft:-prefixed dimension
   */
  _resolveDimension() {
    const raw = this.bot.game && this.bot.game.dimension;
    const norm = raw ? (String(raw).startsWith('minecraft:') ? String(raw) : 'minecraft:' + raw) : null;
    if (!norm) return this._confirmedDim || 'minecraft:overworld';
    if (!norm.endsWith('overworld')) {         // the_nether / the_end → trust now
      this._confirmedDim = norm; this._owConfirm = 0; return norm;
    }
    // 'overworld' read:
    if (!this._confirmedDim || this._confirmedDim.endsWith('overworld')) {
      this._confirmedDim = norm; this._owConfirm = 0; return norm; // already OW / nothing better known
    }
    // We were confidently in nether/end — require the OW read to persist.
    if (++this._owConfirm >= this.OVERWORLD_CONFIRM) {
      this._confirmedDim = norm; this._owConfirm = 0; return norm;
    }
    return this._confirmedDim;                  // hold the last trusted dim meanwhile
  }

  /** Cooldown before a re-appearance of the same player is treated as a NEW pass
   *  (and thus re-logged/re-counted). Bridges render-edge flicker so a continuous
   *  presence is one recorded sighting, not one per 1s scan; a genuine return after
   *  this window still records a fresh pass. */
  get RESIGHT_COOLDOWN_MS() { return 60 * 1000; }

  /** Live check: is this player on the priority watchlist? Read live so dashboard
   *  edits apply on the next scan. (Ignore-listed players never reach here.) */
  _isWatched(lowerName) {
    return (config.watchlist || []).some(n => String(n).toLowerCase() === lowerName);
  }

  /** Attribution key for logged sightings: which account/spot saw the player. */
  _key() {
    return (this.account && (this.account.username || this.account.id)) || this.spotConfig?.id || 'unknown';
  }

  /** Live check: is this player on the ignore list (owner IGN + whitelist)?
   *  Read live so dashboard whitelist edits apply on the next scan. */
  _isIgnored(lowerName) {
    if (config.owner.ign && config.owner.ign.toLowerCase() === lowerName) return true;
    return (config.whitelist || []).some(n => String(n).toLowerCase() === lowerName);
  }

  /** Start the monitoring loop */
  start() {
    if (this._running) return;
    this._running = true;
    this.logger.info('Player monitoring started');

    this._interval = setInterval(() => {
      try {
        this._scan();
      } catch (err) {
        this.logger.error('Monitor scan error:', err.message);
      }
    }, config.timing.entityScanInterval);
  }

  /** Stop the monitoring loop */
  stop() {
    this._running = false;
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this._activePlayers.clear();
    this._lastSightingAt.clear();
    // Reset dimension confirmation so a re-attach re-resolves from scratch.
    this._confirmedDim = null; this._owConfirm = 0; this._scanDimension = null;
    this.logger.info('Player monitoring stopped');
  }

  /** Perform a single entity scan */
  _scan() {
    if (!this.bot.entity || !this.bot.entity.position) return;

    const botPos = this.bot.entity.position;
    const botName = (this.bot.username || '').toLowerCase();
    // Resolve the spectator's dimension ONCE per scan (mutates the confirm counter),
    // then stamp every enter/exit this scan with it — see _resolveDimension.
    this._scanDimension = this._resolveDimension();

    const currentlyVisible = new Set();

    // Scan all entities for players
    for (const entityId of Object.keys(this.bot.entities)) {
      const entity = this.bot.entities[entityId];
      if (!entity || entity.type !== 'player') continue;
      if (!entity.username) continue;

      const username = entity.username;
      const lowerName = username.toLowerCase();
      
      // Skip self, friendly network bots, and ignore-listed players completely.
      if (lowerName === botName || state.isBotUsername(lowerName) || this._isIgnored(lowerName)) continue;

      // A player entity without a position can't be measured; skip it (but still count it
      // as visible so it doesn't fire a spurious EXIT). Guard each entity in its own
      // try/catch so ONE malformed entity can't throw out of the loop and skip the EXIT
      // pass below — which would strand every tracked player in _activePlayers (no EXIT
      // ever fires) until the bad entity disappears.
      if (!entity.position) { if (this._activePlayers.has(username)) currentlyVisible.add(username); continue; }

      currentlyVisible.add(username);

      try {
        if (!this._activePlayers.has(username)) {
          this._onPlayerEnter(entity, botPos);
        } else {
          this._onPlayerMove(entity, botPos);
        }
      } catch (e) {
        this.logger.warn(`PlayerMonitor: skipped entity ${username}: ${e.message}`);
      }
    }

    // Check for players who left
    for (const [username, data] of this._activePlayers.entries()) {
      if (!currentlyVisible.has(username)) {
        this._onPlayerExit(username);
      }
    }

    this._pruneSightingHistory();
  }

  /** Bounded plausibility clamp for a SIGHTING coordinate (the OTHER player's position),
   *  mirroring state.setBotPosition's guard. A malformed/teleporting entity (or the End
   *  queue-room y:-1199260 case) must not write garbage coords into the activity feed/map.
   *  Returns rounded {x,y,z}, or null if implausible. */
  _plausibleCoords(pos) {
    if (!pos) return null;
    const x = pos.x, y = pos.y, z = pos.z;
    if (![x, y, z].every(Number.isFinite)) return null;
    if (y < -2048 || y > 2048 || Math.abs(x) > 30000000 || Math.abs(z) > 30000000) return null;
    return { x: Math.round(x), y: Math.round(y), z: Math.round(z) };
  }

  /** Drop _lastSightingAt entries older than the re-sight cooldown so the map doesn't
   *  grow one permanent entry per unique player ever seen (a slow leak over days on a
   *  busy highway). Safe: an entry older than the cooldown would count as a fresh pass
   *  anyway, so forgetting it changes nothing. */
  _pruneSightingHistory() {
    const cutoff = Date.now() - this.RESIGHT_COOLDOWN_MS;
    for (const [name, t] of this._lastSightingAt) {
      if (t < cutoff) this._lastSightingAt.delete(name);
    }
  }

  _onPlayerEnter(entity, botPos) {
    const pos = entity.position;
    const distance = botPos.distanceTo(pos);
    const equipment = this._getEquipment(entity);
    const lower = entity.username.toLowerCase();

    // Is this a genuinely new pass, or the same player flickering at the render edge
    // (deleted on exit, re-seen on the next scan)? A re-appearance within the cooldown
    // is the SAME pass: we still track it for move/exit math and still evaluate the
    // (separately-debounced) watchlist alert, but we do NOT emit a fresh ENTER ping,
    // re-write the sighting record, or re-increment the counter.
    const last = this._lastSightingAt.get(lower) || 0;
    const recorded = (Date.now() - last) >= this.RESIGHT_COOLDOWN_MS;

    const data = {
      entity,
      entryPos: { x: pos.x, y: pos.y, z: pos.z },
      entryTime: Date.now(),
      lastPos: { x: pos.x, y: pos.y, z: pos.z },
      lastTime: Date.now(),
      equipment,
      distance: Math.round(distance),
      recorded // gates the matching EXIT record so a suppressed flicker stays silent
    };

    this._activePlayers.set(entity.username, data);

    const watched = this._isWatched(lower);
    const detection = {
      playerName: entity.username,
      coords: this._plausibleCoords(pos), // null (→ not plotted) rather than garbage on the map
      distance: Math.round(distance),
      direction: 'Entering',
      speed: 0,
      equipment,
      dimension: this._scanDimension || 'minecraft:overworld', // resolved once per scan
      watched,
      event: 'enter', // distinguishes the enter ping from the exit record (counts once)
      timestamp: new Date().toISOString()
    };

    // The recorded sighting: console ENTER ping + activity log + counter (+ optional
    // per-sighting Discord ping). Skipped entirely for a within-cooldown re-sight.
    if (recorded) {
      this._lastSightingAt.set(lower, Date.now());

      this.logger.info(`[ENTER] ${entity.username} spotted at X:${Math.round(pos.x)} Z:${Math.round(pos.z)} | Dist: ${Math.round(distance)} | Equip: [${this._equipSummary(equipment)}]`);

      this.logger.logActivity(this._key(), detection);
      state.recordDetection(this._key(), entity.username);

      // Per-sighting Discord ping only when set to 'all' (off/exit skip the enter to
      // avoid flooding — the dashboard feed + map always show it). Watchlist still fires.
      if (config.discord.sightingAlerts === 'all') {
        discord.playerDetected({ botId: this.bot._accountId, spotId: this._key(), ...detection });
      }
    }

    // Priority watchlist alert (debounced per player), on top of the normal log.
    // Evaluated on every appearance (incl. re-sights) so a watched player is never
    // missed; WATCH_COOLDOWN_MS is what prevents spam here.
    if (watched) {
      const lastAlert = this._watchAlertedAt.get(lower) || 0;
      if (Date.now() - lastAlert >= this.WATCH_COOLDOWN_MS) {
        this._watchAlertedAt.set(lower, Date.now());
        this.logger.warn(`[WATCHLIST] ${entity.username} spotted at the ${this._key()} spot`);
        discord.watchlistHit({ spotId: this._key(), ...detection });
      }
    }
  }

  _onPlayerMove(entity, botPos) {
    const data = this._activePlayers.get(entity.username);
    data.lastPos = { x: entity.position.x, y: entity.position.y, z: entity.position.z };
    data.lastTime = Date.now();
    data.distance = Math.round(botPos.distanceTo(entity.position));
  }

  _onPlayerExit(username) {
    const data = this._activePlayers.get(username);
    this._activePlayers.delete(username);

    // Restart the re-sight cooldown from the moment the player left view, so an
    // immediate flicker back does not register as a brand-new pass on the next scan.
    this._lastSightingAt.set(username.toLowerCase(), Date.now());

    // If the matching ENTER was a suppressed re-sight (flicker), stay silent — emitting
    // an EXIT record here would re-introduce the double-log / flicker spam we just fixed.
    if (!data.recorded) return;

    const dx = data.lastPos.x - data.entryPos.x;
    const dz = data.lastPos.z - data.entryPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const dt = (data.lastTime - data.entryTime) / 1000;

    let direction = 'Unknown';
    let speed = 0;
    
    if (dist > 5 && dt > 0) {
      const angle = Math.atan2(-dx, dz) * (180 / Math.PI);
      const heading = ((angle % 360) + 360) % 360;
      direction = this._angleToCardinal(heading);
      speed = dist / dt;
    }

    this.logger.info(`[EXIT] ${username} left render distance at X:${Math.round(data.lastPos.x)} Z:${Math.round(data.lastPos.z)} | Dir: ${direction} | Avg Speed: ${speed.toFixed(1)} b/s`);

    const detection = {
      playerName: username,
      coords: this._plausibleCoords(data.lastPos), // null (→ not plotted) rather than garbage on the map
      distance: data.distance,
      direction: direction,
      speed: speed,
      duration: Math.round(dt),
      equipment: data.equipment,
      dimension: this._scanDimension || 'minecraft:overworld', // resolved once per scan
      watched: this._isWatched(username.toLowerCase()),
      event: 'exit', // pass-completion record (carries direction + speed); not re-counted
      timestamp: new Date().toISOString()
    };

    this.logger.logActivity(this._key(), detection);

    // On exit we have direction + speed. Ping for 'exit' or 'all'; 'off' is dashboard-only.
    if (config.discord.sightingAlerts === 'exit' || config.discord.sightingAlerts === 'all') {
      discord.playerDetected({ botId: this.bot._accountId, spotId: this._key(), ...detection });
    }
  }

  /** Convert angle to cardinal direction */
  _angleToCardinal(angle) {
    const dirs = ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE'];
    const idx = Math.round(angle / 45) % 8;
    return dirs[idx];
  }

  /** Read another player's visible equipment (armor + both hands). Each slot becomes
   *  { item, count? }.
   *
   *  ENCHANTMENT CAPTURE WAS REMOVED (2026-07-01): reading the 1.20.5+ `enchantments`
   *  data-component off ANOTHER player's entity items produced garbage — every piece
   *  came back as "Protection I" (enchant id 0 / level defaulting to 1), including items
   *  that can't hold Protection (elytra, pickaxes). The equipment the server broadcasts
   *  for other players doesn't carry reliable enchantment component data, so any value we
   *  showed was fabricated and misleading. Item NAMES are accurate and still captured
   *  (and gear-based wealth scoring uses names only, so it's unaffected). If a correct,
   *  verified 1.21.x component parse is found later, re-add a per-slot enchants array. */
  _getEquipment(entity) {
    const equipment = {};
    try {
      if (entity.equipment) {
        // Indexed against the raw protocol Entity-Equipment slots that
        // prismarine-entity stores by index: 0=mainhand, 1=offhand, 2=boots,
        // 3=leggings, 4=chestplate, 5=helmet. The order below MUST match that.
        const slots = ['hand', 'off-hand', 'feet', 'legs', 'torso', 'head'];
        for (let i = 0; i < entity.equipment.length && i < slots.length; i++) {
          const item = entity.equipment[i];
          if (!item || !item.name || item.name === 'air') continue;
          const slot = { item: item.name.replace('minecraft:', '') };
          if (item.count && item.count > 1) slot.count = item.count;
          equipment[slots[i]] = slot;
        }
      }
    } catch (e) {
      // Equipment reading is best-effort
    }
    return Object.keys(equipment).length > 0 ? equipment : null;
  }

  /** One-line equipment summary for console logs. */
  _equipSummary(equipment) {
    if (!equipment) return 'None';
    return Object.entries(equipment).map(([slot, e]) => `${slot}:${e.item}`).join(' ');
  }


  /** Get current player history (for dashboard) */
  getRecentDetections() {
    const detections = [];
    for (const [name, data] of this._activePlayers) {
      detections.push({
        playerName: name,
        lastSeen: data.lastTime,
        lastCoords: { ...data.lastPos },
      });
    }
    return detections;
  }
}

module.exports = PlayerMonitor;
