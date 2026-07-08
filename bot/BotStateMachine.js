/**
 * bot/BotStateMachine.js — Thin lifecycle for a mineflayer monitor.
 *
 * In the ZenithProxy model, mineflayer connects (as a spectator) to a local
 * ZenithProxy that is already in-world, so there is no queue / travel / supply /
 * outpost work to do. The whole lifecycle is just: connect → monitor →
 * disconnect. All the old autonomous states were removed (see ARCHITECTURE.md).
 */
const EventEmitter = require('events');
const config = require('../config');
const state = require('../state');
const PlayerMonitor = require('./modules/PlayerMonitor');

const STATES = {
  CONNECTING: 'connecting',
  MONITORING: 'monitoring',
  DISCONNECTING: 'disconnecting',
  STOPPED: 'stopped',
};

class BotStateMachine extends EventEmitter {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {import('../logging/Logger').Logger} logger
   * @param {object} account - { id, email, ... }
   * @param {object|null} spotConfig - { id, highway, netherCoords }
   */
  constructor(bot, logger, account, spotConfig) {
    super();
    this.bot = bot;
    this.logger = logger;
    this.account = account;
    this.spotConfig = spotConfig;
    this.state = STATES.CONNECTING;
    this.playerMonitor = null;
    this._positionTracker = null;
    // Last kick reason, kept for the orchestrator's 'disconnected' handling: a
    // "Not connected to server!" kick from ZenithProxy is ground truth that its
    // 2b2t session is NOT in-world (whatever the stale pane suggests).
    this.lastKickReason = null;
    this._setupEventHandlers();
  }

  _setupEventHandlers() {
    // mineflayer joins the ZenithProxy's already-spawned, in-world session.
    this.bot.on('spawn', () => {
      if (this._spawnTimer) { clearTimeout(this._spawnTimer); this._spawnTimer = null; }
      if (this.state === STATES.CONNECTING) this._startMonitoring();
    });

    this.bot.on('end', (reason) => {
      this.logger.info('Connection ended:', reason);
      this._cleanup();
      this.emit('disconnected', reason);
    });

    this.bot.on('kicked', (reason) => {
      this.lastKickReason = typeof reason === 'string' ? reason : JSON.stringify(reason);
      this.logger.warn('Kicked:', this.lastKickReason);
    });

    this.bot.on('error', (err) => {
      this.logger.error('Error:', err.message);
    });

    // NOTE: there is deliberately NO mineflayer 'death' handler here. This bot is a
    // pure spectator on ZenithProxy's already-in-world session, so mineflayer's 'death'
    // event never fires (the underlying account dies, not this spectator). The
    // authoritative death path is index.js `_parseDeaths`, which reads the ZenithProxy
    // pane, un-places the account, and tears the monitor down. Do NOT re-add a 'death'
    // handler here expecting it to work — it would be dead code (see SYSTEM_AUDIT #6/#37).
  }

  /** Called after the bot is created. */
  start() {
    this.logger.info('Monitor connecting...');
    state.setBotStatus(this.account.id, STATES.CONNECTING, { spotId: this.spotConfig?.id });
    // No Discord ping here: monitor connect/reconnect is internal plumbing (and
    // retries on a loop). The operator-facing pings (in-world, drops, login) come
    // from the orchestrator; monitor attach state is shown on the dashboard.
    // Spawn watchdog: if 'spawn' never fires (the client logs in but the spectator
    // session never fully spawns — a known ZenithProxy edge), we'd otherwise sit in
    // CONNECTING forever, looking attached on the dashboard while seeing nothing and
    // blocking re-attach. Quit after a timeout so the orchestrator's reconnect path
    // (index.js 'disconnected' → relaunch) gets a clean retry.
    const timeoutMs = (config.timing.monitorSpawnTimeout || 45) * 1000;
    this._spawnTimer = setTimeout(() => {
      this._spawnTimer = null;
      if (this.state === STATES.CONNECTING) {
        this.logger.warn(`Monitor never spawned within ${timeoutMs / 1000}s — quitting for a clean reconnect`);
        try { this.bot.quit('spawn-timeout'); } catch (e) { /* already gone; 'end' will fire */ }
      }
    }, timeoutMs);
    if (this._spawnTimer.unref) this._spawnTimer.unref();
  }

  /** Stop monitoring and disconnect. */
  stop() {
    this.logger.info('Monitor stopping');
    this._cleanup();
    this.state = STATES.STOPPED;
    state.setBotStatus(this.account.id, STATES.STOPPED);
    try { this.bot.quit('stopped'); } catch (e) { /* already gone */ }
  }

  _startMonitoring() {
    this.state = STATES.MONITORING;
    this.logger.info(`=== MONITORING ACTIVE as ${this.bot.username} ===`);
    this.emit('connected');
    state.setBotStatus(this.account.id, STATES.MONITORING, {
      spotId: this.spotConfig?.id,
      username: this.bot.username,
    });
    // Monitor attach/detach is dashboard + log only (it can flap on reconnect) —
    // no Discord ping. Death pings are the pane parser's job (index.js _parseDeaths),
    // since mineflayer's 'death' event never fires for this spectator (see above).

    if (!this.playerMonitor) {
      this.playerMonitor = new PlayerMonitor(this.bot, this.logger, this.spotConfig, this.account);
    }
    this.playerMonitor.start();

    const savePos = () => {
      const pos = this.bot.entity?.position;
      if (!pos) return;
      const dim = this.bot.game?.dimension;
      // Defense-in-depth with state.setBotPosition's clamp: only persist a position we
      // can confirm as a real in-world coordinate. The 2b2t queue lives in the End room
      // (minecraft:the_end) and reports garbage coords (e.g. y:-1199260), and savePos
      // also fires the instant we spawn — before the position may be synced. Skip rather
      // than poison lastPosition (it feeds the dashboard + fallback sighting coords).
      const plausible =
        Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z) &&
        pos.y >= -2048 && pos.y <= 2048 &&
        Math.abs(pos.x) <= 30000000 && Math.abs(pos.z) <= 30000000;
      if (dim === 'minecraft:the_end' || !plausible) return;
      state.setBotPosition(this.account.id, pos, dim);
    };
    savePos();
    this._positionTracker = setInterval(savePos, config.timing.stateSaveInterval);
  }

  _cleanup() {
    if (this._spawnTimer) { clearTimeout(this._spawnTimer); this._spawnTimer = null; }
    if (this.playerMonitor) this.playerMonitor.stop();
    if (this._positionTracker) {
      clearInterval(this._positionTracker);
      this._positionTracker = null;
    }
  }
}

BotStateMachine.STATES = STATES;
module.exports = BotStateMachine;
