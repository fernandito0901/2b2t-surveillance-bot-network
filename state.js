/**
 * state.js — Persistent runtime state manager.
 * Tracks bot statuses, queue positions, placed flags, and activity summaries.
 * Automatically saves to disk so the system can resume after restart.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { writeJsonAtomic } = require('./lib/atomicWrite');

class StateManager {
  constructor() {
    this.filePath = path.resolve(config.paths.state);
    this.state = this._load();
    // Migrate older state files that predate the placed-flag.
    if (!this.state.placedBots) this.state.placedBots = {};
    this._saveInterval = null;
    // Only warn once about implausible coords so a stuck queue-room bot doesn't
    // spam the log every poll.
    this._warnedBadPos = false;
    // Lowercased IGNs of every account we own — so the monitor never logs our
    // own bots (incl. the one it's spectating) as detected players. In-memory.
    this._networkIgns = new Set();
  }

  /** Register the IGNs of all network accounts (own bots). Call on load + when
   *  accounts change. */
  registerNetworkIgns(igns) {
    this._networkIgns = new Set((igns || []).filter(Boolean).map(n => String(n).toLowerCase()));
  }

  /** Load state from disk or create fresh default */
  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        // Drop a retired top-level key that older state files still carry:
        // supplyRequests has zero readers but was re-serialized on every save.
        if (parsed && parsed.supplyRequests) delete parsed.supplyRequests;
        return parsed;
      }
    } catch (err) {
      console.error('[State] Failed to load state file, starting fresh:', err.message);
    }
    return this._defaultState();
  }

  _defaultState() {
    return {
      bots: {},
      // { botId: { status, queuePosition, spotId, lastPosition, lastSeen, ... } }
      placedBots: {},
      // { botId: true } — user has placed this bot at its spot, so mineflayer
      // should hold the slot and monitor. Absent/false → user is driving it
      // (via ZenithProxy), so mineflayer stays disconnected. Survives restarts.
      activitySummary: {},
      // { spotId: { totalDetections, lastDetection, ... } }
    };
  }

  /** Save current state to disk */
  save() {
    try {
      // Crash-safe write (temp file + fsync + atomic rename) via the shared helper,
      // so a crash mid-write can't corrupt state.json (which would lose the placed
      // flags and stop bots from auto-reconnecting their monitors on next boot).
      writeJsonAtomic(this.filePath, this.state);
    } catch (err) {
      console.error('[State] Failed to save state:', err.message);
    }
  }

  /** Start periodic auto-save */
  startAutoSave() {
    // Reset all bot statuses to 'offline' on fresh startup
    // so the dashboard doesn't show ghost bots from last session
    for (const [botId, info] of Object.entries(this.state.bots)) {
      info.status = 'offline';
      info.queuePosition = null;
    }
    this.save();

    if (this._saveInterval) return;
    this._saveInterval = setInterval(() => this.save(), config.timing.stateSaveInterval);
  }

  /** Stop auto-save and do a final save */
  stopAutoSave() {
    if (this._saveInterval) {
      clearInterval(this._saveInterval);
      this._saveInterval = null;
    }
    this.save();
  }

  // ── Bot state helpers ────────────────────────────────────

  /** Update a bot's status */
  setBotStatus(botId, status, extra = {}) {
    if (!this.state.bots[botId]) {
      this.state.bots[botId] = {};
    }
    Object.assign(this.state.bots[botId], {
      status,
      lastUpdated: Date.now(),
      ...extra,
    });
  }

  /** Get a bot's current status object */
  getBotStatus(botId) {
    return this.state.bots[botId] || null;
  }

  /** Get all bot statuses */
  getAllBotStatuses() {
    return { ...this.state.bots };
  }

  /** Check if a given username belongs to any account/bot in the network */
  isBotUsername(username) {
    if (!username) return false;
    const target = username.toLowerCase();
    if (this._networkIgns.has(target)) return true;
    for (const info of Object.values(this.state.bots)) {
      if (info.username && info.username.toLowerCase() === target) {
        return true;
      }
    }
    return false;
  }

  /** Record last known position */
  setBotPosition(botId, position, dimension) {
    if (!position) return;
    const { x, y, z } = position;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    // Reject implausible coords before persisting — the 2b2t End queue room reports
    // garbage like y:-1199260, which would poison state.json (and downstream
    // sightings). Guard the vertical bounds and the ±30M world border.
    if (y < -2048 || y > 2048 || Math.abs(x) > 30_000_000 || Math.abs(z) > 30_000_000) {
      if (!this._warnedBadPos) {
        console.warn(`[State] Rejecting implausible position for ${botId}: (${x}, ${y}, ${z})`);
        this._warnedBadPos = true;
      }
      return;
    }
    if (!this.state.bots[botId]) {
      this.state.bots[botId] = {};
    }
    this.state.bots[botId].lastPosition = {
      x: Math.round(x),
      y: Math.round(y),
      z: Math.round(z),
      dimension: dimension || 'minecraft:overworld'
    };
  }

  // ── Activity summary helpers ──────────────────────────────

  /** Increment detection count for a spot */
  recordDetection(spotId, playerName) {
    if (!this.state.activitySummary[spotId]) {
      this.state.activitySummary[spotId] = { totalDetections: 0, uniquePlayers: [] };
    }
    const summary = this.state.activitySummary[spotId];
    summary.totalDetections++;
    summary.lastDetection = Date.now();
    summary.lastPlayer = playerName;
    if (!summary.uniquePlayers.includes(playerName)) {
      summary.uniquePlayers.push(playerName);
      // Cap to prevent unbounded growth in state.json
      if (summary.uniquePlayers.length > 500) {
        summary.uniquePlayers = summary.uniquePlayers.slice(-500);
      }
    }
  }

  /** Get activity summary for all spots */
  getActivitySummary() {
    return { ...this.state.activitySummary };
  }

  /** Clear the activity summary (all spots, or just one) */
  clearActivitySummary(spotId) {
    if (spotId) delete this.state.activitySummary[spotId];
    else this.state.activitySummary = {};
    this.save();
  }

  /** Remove a bot from state entirely */
  removeBot(botId) {
    delete this.state.bots[botId];
    delete this.state.placedBots[botId];
  }

  // ── Placed-flag helpers (hybrid ZenithProxy model) ────────

  /** Mark whether the user has placed this bot at its spot */
  setPlaced(botId, placed) {
    if (placed) this.state.placedBots[botId] = true;
    else delete this.state.placedBots[botId];
    this.save();
  }

  /** True if the bot is flagged as placed (mineflayer should hold the slot) */
  isPlaced(botId) {
    return !!this.state.placedBots[botId];
  }

  /** Map of all placed flags, for the dashboard */
  getAllPlaced() {
    return { ...this.state.placedBots };
  }
}

// Singleton
module.exports = new StateManager();
