/**
 * index.js — Main orchestrator for the 2b2t bot network.
 * Loads config, manages bot lifecycles, starts dashboard, handles CLI.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const state = require('./state');
const { systemLogger, loggerEvents } = require('./logging/Logger');
const discord = require('./logging/DiscordNotifier');
const BotFactory = require('./bot/BotFactory');
const proxyPool = require('./proxy/ProxyPool');
const BotStateMachine = require('./bot/BotStateMachine');
const metrics = require('./metrics/MetricsStore');
const parsers = require('./lib/parsers');
const { writeJsonAtomic, writeFileAtomic } = require('./lib/atomicWrite');
const wealth = require('./metrics/WealthEstimator');
const { gearWealthPoints, gearWealthLabel, computeWealth } = require('./lib/wealthScore');

// ── Silence protodef's partial-packet spam ──────────────────────────────────
// node-minecraft-protocol's FullPacketParser does a bare console.log() —
// "Chunk size is N but only M was read ; partial packet : {entity_teleport…}" —
// for every packet it can't fully deserialize. Near busy areas (e.g. the 100k
// highway) that's ~50MB/hour of pure noise into app.log, drowning the real logs
// and bloating the file to hundreds of MB between rotations. The packets are
// benign (the monitor still tracks positions), and the lib's `noErrorLogging`
// flag is buried in mineflayer's deserializer, so we drop exactly those lines
// here. Our own Logger always prefixes a timestamp, so real logs pass through.
const _origConsoleLog = console.log.bind(console);
console.log = (...args) => {
  const first = args[0];
  if (typeof first === 'string' &&
      (first.startsWith('Chunk size is ') || first.includes('; partial packet :'))) return;
  _origConsoleLog(...args);
};

class Orchestrator {
  constructor() {
    this.accounts = [];
    this.groups = [];
    this.activeBots = new Map(); // botId → { bot, sm, logger } (mineflayer monitors)
    this.dashboardServer = null;
    this._externalState = new Map(); // accountId → {state, queuePosition} from the tmux poller
    this._externalPoller = null;
    this._authPending = new Map();   // accountId → {url, code, since} when a login is required
    this._queueMarks = new Map();    // accountId → Set of queue milestones already pinged
    this._inGameNotified = new Set(); // accountIds already pinged "in the server"
    this._stuckSince = new Map();     // accountId → ts it first looked stuck (idle/offline)
    this._remediatedAt = new Map();   // accountId → ts of last auto-remediation (debounce)
    this._vrSeen = new Map();         // accountId → Set of ZenithProxy visualRange event sigs already logged
    this._vrBaselined = new Set();    // accountIds whose pre-existing visualRange pane lines were baselined
    this._deathSeen = new Map();      // accountId → Set of death event sigs already alerted
    this._deathBaselined = new Set(); // accountIds whose pre-existing death pane lines were baselined
    this._dropSeen = new Map();       // accountId → Set of drop event sigs already alerted
    this._dropBaselined = new Set();  // accountIds whose pre-existing drop pane lines were baselined
    this._dropPingAt = new Map();     // accountId → { last, suppressed } — coalesce drop pings
    this._dropWindow = new Map();     // accountId → [drop timestamps] in a rolling window (dead-proxy detect)
    this._launching = new Set();      // accountIds with a monitor launch in flight (single-flight)
    this._launchWaiting = new Set();  // placed accountIds waiting to reach the world (log-once flag)
    this._provisionTimers = new Map();// accountId → the 24s post-provision send-keys timer handle
    this._provisioning = new Set();   // accountIds with a _provisionAndLaunch in flight (single-flight)
    this._reconnectTimers = new Map();// accountId → the ONE pending monitor-reconnect timer (deduped)
    this._monitorHoldUntil = new Map();// accountId → ts before which monitor attach is suppressed
                                       // (ZenithProxy kicked us "Not connected to server!")
    this._offlineTicks = new Map();   // accountId → consecutive poll ticks a capture came back 'offline'
    this._paneProgress = new Map();   // accountId → {sig, frozenTicks} pane-freeze tracking for stuck-remediation
    this._cartographyCache = new Map();// cartography file path → parsed store (invalidated on write)
  }

  /**
   * Initialize and start the entire system.
   */
  async start() {
    systemLogger.info('========================================');
    systemLogger.info('  2b2t Highway Surveillance Bot Network');
    systemLogger.info('========================================');

    // Load data files
    this._loadData();

    // Initialize state manager
    state.startAutoSave();

    // Prune old activity per retention policy
    if (config.logging.retentionDays > 0) {
      await this.clearActivity({ beforeDays: config.logging.retentionDays });
    }

    // Sync the proxy pool from the Webshare API (if a key is set) so assignments
    // use the current, valid list. Non-blocking — the pool falls back to the
    // cached proxies.txt while this runs.
    if (config.proxies.webshareApiKey) {
      proxyPool.refresh().catch(e => systemLogger.warn(`Initial Webshare sync failed: ${e.message}`));
    }

    // Start dashboard
    await this._startDashboard();

    // Hook up real-time websocket broadcasting
    loggerEvents.on('activity', (entry) => {
      this._broadcastDashboard({ type: 'player_detected', ...entry });
    });

    // Poll queue/state for any hand-run (tmux) instances so they still show up.
    // Run the FIRST poll and await it before reconnecting monitors, so _externalState
    // is populated: the reconnect loop then attaches only bots actually in-world (via
    // _launchBot) and no placed-but-queuing bot fires the boot-time "not in-world yet"
    // log. Subsequent attach/detach is event-driven off the poller (_syncMonitorAttach).
    await this._startExternalPoller();

    // Reconnect mineflayer monitors for any bots the user had already placed
    // before the last shutdown (the placed flag persists across restarts). By now the
    // poller has already attached any placed bot that's in-world, so this mostly no-ops.
    for (const account of this.accounts) {
      if (state.isPlaced(account.id)) {
        systemLogger.info(`${this._name(account)} was placed before the restart — re-attaching its monitor`);
        this._launchBot(account.id);
      }
    }

    // Daily housekeeping so a long-lived process doesn't grow unbounded between
    // restarts (retention also runs once above, at boot).
    this._startMaintenance();

    // Handle graceful shutdown
    this._setupShutdownHandlers();

    // CLI input
    this._setupCLI();

    systemLogger.info('System started. Waiting for bots to connect...');
    systemLogger.info(`Dashboard: http://localhost:${config.dashboard.port}`);
  }

  /** Daily housekeeping — prune activity + metrics beyond their retention windows so
   *  the disk doesn't fill on a long-running process. Activity retention also runs at
   *  boot; this covers processes that stay up for weeks. Unref'd so it never blocks exit. */
  _startMaintenance() {
    const run = async () => {
      try {
        if (config.logging.retentionDays > 0) this.clearActivity({ beforeDays: config.logging.retentionDays });
        if (typeof metrics.prune === 'function') metrics.prune();
        // Wealth estimator keeps its own on-disk cache of api.2b2t.vc stats; prune stale
        // entries and persist so the profile board survives restarts without re-fetching.
        if (config.wealth && config.wealth.enabled) { try { wealth.prune(); wealth.persist(); } catch (e) {} }
        await this._checkProxyBandwidth();
      } catch (e) { systemLogger.warn(`Maintenance task failed: ${e.message}`); }
    };
    this._maintenanceTimer = setInterval(run, 24 * 60 * 60 * 1000);
    if (this._maintenanceTimer.unref) this._maintenanceTimer.unref();
  }

  /** Once-daily: warn (once) if Webshare bandwidth usage crosses 85% of the plan, so
   *  the proxies never silently cap mid-operation. Resets when usage drops back. */
  async _checkProxyBandwidth() {
    const plan = await proxyPool.getPlanInfo().catch(() => null);
    if (!plan || !plan.bandwidthLimitGB || plan.bandwidthUsedGB == null) return;
    const frac = plan.bandwidthUsedGB / plan.bandwidthLimitGB;
    if (frac >= 0.85 && !this._bandwidthWarned) {
      this._bandwidthWarned = true;
      discord.message(`⚠️ **Proxy bandwidth at ${Math.round(frac * 100)}%** — ${plan.bandwidthUsedGB}/${plan.bandwidthLimitGB} GB used (last 30d). Consider upgrading before it caps.`);
    } else if (frac < 0.85) {
      this._bandwidthWarned = false;
    }
  }

  /**
   * Load accounts and spots from data files.
   */
  _loadData() {
    try {
      const accountsPath = path.resolve(config.paths.accounts);

      if (fs.existsSync(accountsPath)) {
        this.accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf-8'));
        // Keep any real account (id present); new accounts have no email.
        this.accounts = this.accounts.filter(a => a.id && a.email !== 'your-email@outlook.com');
      }
      const groupsPath = path.resolve(config.paths.groups);
      if (fs.existsSync(groupsPath)) {
        this.groups = JSON.parse(fs.readFileSync(groupsPath, 'utf-8'));
      }
      // Runtime settings (dashboard-editable) override config defaults.
      const settingsPath = path.resolve(config.paths.settings);
      if (fs.existsSync(settingsPath)) {
        this.updateSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')), false);
      }

      systemLogger.info(`Loaded ${this.accounts.length} accounts, ${this.groups.length} groups`);
    } catch (err) {
      systemLogger.error('Failed to load data files:', err.message);
      systemLogger.info('Starting with empty config. Use the dashboard or CLI to add accounts.');
    }
    this._syncNetworkIgns();
  }

  /** Display name for log/alert lines: the account's IGN when known, else its id.
   *  Accepts an account object or an id. */
  _name(idOrAcc) {
    const a = (idOrAcc && typeof idOrAcc === 'object') ? idOrAcc : this.accounts.find(x => x.id === idOrAcc);
    return (a && (a.username || a.id)) || String(idOrAcc);
  }

  /** Tell the monitor which IGNs are our own accounts, so it never logs them
   *  as detected players. Re-run whenever the account set or IGNs change. */
  _syncNetworkIgns() {
    const igns = this.accounts.map(a => a.username).filter(Boolean);
    if (config.fleet.monitorIgn) igns.push(config.fleet.monitorIgn);
    if (config.owner.ign) igns.push(config.owner.ign);
    state.registerNetworkIgns(igns);
  }

  /**
   * Launch a bot for a given account ID.
   */
  async _launchBot(botId) {
    // Don't launch if already active
    if (this.activeBots.has(botId)) {
      systemLogger.debug(`Bot ${botId} already active, skipping launch`);
      return;
    }

    // Hybrid model: mineflayer only holds the slot for bots the user has placed
    // at their spot. Un-placed bots are left for the user to drive via ZenithProxy.
    if (!state.isPlaced(botId)) {
      systemLogger.debug(`Bot ${botId} is not placed — leaving the slot free for manual control`);
      return;
    }

    // Hold-off after a "Not connected to server!" kick: ZenithProxy told us its 2b2t
    // session is NOT in-world, so re-attaching now (off the pane's stale in_game) just
    // burns login attempts until "Login Rate Limited". The poller re-promotes the state
    // on the next real signal; a couple of minutes of monitor gap during a re-queue is
    // free (the queue is hours).
    if ((this._monitorHoldUntil.get(botId) || 0) > Date.now()) {
      systemLogger.debug(`Bot ${botId} monitor attach on hold (proxy reported not-in-world)`);
      return;
    }

    const account = this.accounts.find(a => a.id === botId);
    if (!account) {
      systemLogger.error(`Unknown account: ${botId}`);
      return;
    }

    // Spots model retired — player attribution is by the account's IGN. The monitor
    // no longer needs a spot config; PlayerMonitor keys sightings off the account.
    const spotConfig = null;

    // The monitor connects to this account's ZenithProxy as the shared offline
    // spectator IGN. Port + in-world state come from the account + tmux poller;
    // local-dev (no port) falls back to config.server.
    const monitorAccount = { ...account };
    // Keep the bot's real IGN for log tags — `username` below becomes the shared
    // spectator identity, which would make every bot's log read as the monitor.
    monitorAccount.displayName = account.username || account.id;
    const ext = this._externalState.get(botId);
    const port = account.port;
    const inWorld = ext && ext.state === 'in_game';
    if (port) {
      if (!inWorld) {
        // Not in-world yet (queuing/connecting). Attach is EVENT-DRIVEN off the poller's
        // queuing→in_game transition (_syncMonitorAttach), so we do NOT self-reschedule
        // here — that 15s self-retry loop was ~99% of the log volume during the hours-long
        // queue. Log at most once per waiting episode, at debug.
        if (!this._launchWaiting.has(botId)) {
          this._launchWaiting.add(botId);
          systemLogger.debug(`Bot ${botId} placed but its proxy isn't in-world yet — will attach when it reaches the world`);
        }
        return;
      }
      monitorAccount.upstream = { host: '127.0.0.1', port };
      monitorAccount.username = config.fleet.monitorIgn || account.username; // spectator identity
    }
    this._launchWaiting.delete(botId);

    // Single-flight: BotFactory.create is awaited below, so without this two callers
    // (a place toggle + the poller's transition) could both pass the activeBots.has
    // guard above, both open a spectator connection, and the second overwrite the first
    // — leaking an untracked monitor. A per-account flag + a post-await re-check make it
    // safe.
    if (this._launching.has(botId)) {
      systemLogger.debug(`Bot ${botId} launch already in flight, skipping`);
      return;
    }
    this._launching.add(botId);

    systemLogger.info(`Attaching spectator monitor to ${this._name(account)}`);

    try {
      const { bot, logger } = await BotFactory.create(monitorAccount);
      // Re-check after the await: another launch may have won the race while we were
      // connecting. If so, quit this loser rather than overwrite (and leak) the winner.
      if (this.activeBots.has(botId)) {
        systemLogger.debug(`Bot ${botId} already attached during launch — quitting duplicate`);
        try { bot.quit('Duplicate monitor'); } catch (e) { /* already gone */ }
        return;
      }
      const sm = new BotStateMachine(bot, logger, account, spotConfig);
      this.activeBots.set(botId, { bot, sm, logger, account, spotConfig });

      sm.on('disconnected', () => {
        this.activeBots.delete(botId);
        // Ground truth beats the pane: ZenithProxy kicks the spectator with "Not
        // connected to server!" when its own 2b2t session is NOT in-world (a drop →
        // re-queue). The poller's in_game can stay stale for minutes after a drop
        // (hours of world chat outrank sparse queue lines), and each blind retry armed
        // ANOTHER 10s timer — a stampede that ended in "Login Rate Limited". Downgrade
        // the stale state, hold attaches briefly, and let the poller re-promote.
        if (/not connected to server/i.test(String(sm.lastKickReason || ''))) {
          const cur = this._externalState.get(botId);
          if (cur && cur.state === 'in_game') this._externalState.set(botId, { state: 'idle' });
          this._monitorHoldUntil.set(botId, Date.now() + 120_000);
          return;
        }
        // If still placed AND still in-world (e.g. its ZenithProxy blipped), reconnect
        // the monitor. If it left the world, the poller's _syncMonitorAttach handles it.
        const ext2 = this._externalState.get(botId);
        if (state.isPlaced(botId) && ext2 && ext2.state === 'in_game') this._scheduleMonitorReconnect(botId, 10000);
      });

      sm.start();
      this._broadcastDashboard({ type: 'bot_launched', botId });
    } catch (err) {
      systemLogger.error(`Failed to launch monitor ${botId}:`, err.message);
      const ext2 = this._externalState.get(botId);
      if (state.isPlaced(botId) && ext2 && ext2.state === 'in_game') this._scheduleMonitorReconnect(botId, config.timing.kickReconnectDelay * 1000);
    } finally {
      this._launching.delete(botId);
    }
  }

  /**
   * Schedule the ONE pending monitor reconnect for an account, replacing any earlier
   * timer. Bare setTimeout calls here compounded: every failed attempt armed another
   * 10s timer, so several stacked timers fired attempts every ~4-6s until ZenithProxy
   * answered "Login Rate Limited" (seen live on acc-mqlomnmf, 2026-07-01).
   */
  _scheduleMonitorReconnect(botId, delayMs) {
    const prev = this._reconnectTimers.get(botId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this._reconnectTimers.delete(botId);
      this._launchBot(botId);
    }, delayMs);
    if (t.unref) t.unref();
    this._reconnectTimers.set(botId, t);
  }

  /**
   * Mark a bot as placed (mineflayer holds the slot + monitors) or not placed
   * (mineflayer steps aside so the user can drive it via ZenithProxy).
   */
  _setPlaced(botId, placed) {
    placed = !!placed;
    // Idempotent: a repeated place toggle (double-click, overlapping requests) must not
    // start a second launch/teardown. No-op if already in the desired state.
    if (state.isPlaced(botId) === placed) return true;
    state.setPlaced(botId, placed);
    systemLogger.info(`${this._name(botId)} ${placed ? 'marked PLACED — attaching its monitor' : 'released — slot free for manual control'}`);
    if (placed) {
      this._launchBot(botId);
    } else {
      this._stopBot(botId);
    }
    this._broadcastDashboard({ type: 'placed_changed', botId, placed });
    return true;
  }

  /**
   * Stop a specific bot.
   */
  _stopBot(botId) {
    // A pending reconnect must not undo this stop (or a release/un-place) seconds later.
    const rt = this._reconnectTimers.get(botId);
    if (rt) { clearTimeout(rt); this._reconnectTimers.delete(botId); }
    const entry = this.activeBots.get(botId);
    if (!entry) return;

    entry.sm.stop();
    try {
      entry.bot.quit('Manual stop');
    } catch (e) {
      // Already disconnected
    }
    this.activeBots.delete(botId);
    this._launchWaiting.delete(botId); // no longer waiting to attach
    systemLogger.info(`Monitor detached from ${this._name(botId)}`);
  }

  /**
   * Start the web dashboard.
   */
  async _startDashboard() {
    try {
      const DashboardServer = require('./dashboard/server');
      this.dashboardServer = new DashboardServer(this);
      await this.dashboardServer.start();
    } catch (err) {
      systemLogger.warn('Dashboard failed to start:', err.message);
      systemLogger.info('Continuing without dashboard...');
    }
  }

  /**
   * Broadcast a message to all dashboard WebSocket clients.
   */
  _broadcastDashboard(data) {
    if (this.dashboardServer) {
      this.dashboardServer.broadcast(data);
    }
  }

  /**
   * Poll the tmux pane of each account's ZenithProxy (account.tmuxSession),
   * parsing its queue position / in-world / login state for the dashboard, and
   * firing queue-milestone + in-game + login-required Discord notifications.
   * This is the single source of truth for proxy state.
   */
  _startExternalPoller() {
    const { execFile } = require('child_process');
    // Consecutive failed captures required before an account is declared 'offline' (with
    // 15s polls, 2 ≈ 30s) — debounces a transient tmux/capture blip into a no-op.
    const OFFLINE_DEBOUNCE_TICKS = 2;
    // Evaluated each tick so newly-added accounts are picked up automatically.
    const external = () => this.accounts.filter(a => a.tmuxSession);

    // Capture + classify one account's pane. Resolves (never rejects) when done, so the
    // tick can await the whole fan-out.
    const captureOne = (acc) => new Promise((resolve) => {
      execFile('tmux', ['capture-pane', '-t', acc.tmuxSession, '-p', '-J', '-S', '-300'], (err, stdout) => {
        const prev = this._externalState.get(acc.id) || {};
        try {
          if (err) {
            // Debounce: a SINGLE failed `tmux capture-pane` (a load/OOM spike on the 2GB
            // box, a PATH hiccup) must not fire a 🔴 OFFLINE alert AND tear down the
            // mineflayer monitor for one tick, then flap back ~15s later. Require a few
            // consecutive failed captures before committing to 'offline'; until then hold
            // the previous state so a blip is a no-op.
            const ticks = (this._offlineTicks.get(acc.id) || 0) + 1;
            this._offlineTicks.set(acc.id, ticks);
            if (ticks < OFFLINE_DEBOUNCE_TICKS && prev.state && prev.state !== 'offline') {
              metrics.recordSample(acc.id, prev.state, prev.queuePosition != null ? prev.queuePosition : null);
              return; // treat as a transient blip: no state change, no alert, no detach
            }
            this._externalState.set(acc.id, { state: 'offline' });
            metrics.recordSample(acc.id, 'offline', null);
            if (prev.state && prev.state !== 'offline') this._notifyProxyDown(acc, prev.state, 'offline');
            this._syncMonitorAttach(acc, prev, this._externalState.get(acc.id));
            return;
          }
          this._offlineTicks.delete(acc.id); // a good capture clears the offline streak
          // Capture the IGN for a freshly-added (pending) account after it logs in,
          // so Add Account finalizes itself with no manual step.
          if (acc.pending || !acc.username) {
            const ign = parsers.loggedInAs(stdout);
            if (ign && ign !== acc.username) { acc.username = ign; this._onAccountAuthenticated(acc.id, ign); }
          }
          // Drop server-list ping noise (the operator's client pinging the proxy).
          const lines = stdout.split('\n').filter(l => l.trim() && !/\[Ping\]|Request from:/.test(l));
          const lastPos = parsers.lastQueuePosition(stdout);
          const recentQueue = /Position in queue/.test(lines.slice(-6).join('\n'));
          const recent = lines.slice(-40).join('\n');
          // In-world vs queue by RECENCY over the whole captured pane: the queue prints
          // "Position in queue" periodically, while in-world emits chat/respawn lines —
          // whichever is most recent wins. This is authoritative when not null and fixes
          // a quiet in-world bot being mislabeled "queuing" off a stale scrollback queue
          // line (e.g. right after an app restart, when there's no prior sticky in_game
          // state to fall back on).
          const recencyInWorld = parsers.inWorldByRecency(lines.join('\n'));
          // NOTE: "as controlling player" is a CLIENT connecting to the proxy (you
          // driving/checking it) — NOT the account being in-world; it can happen
          // mid-queue, so it must NOT count as in-game.
          const inGame = recencyInWorld === true || parsers.isInGame(recent);
          // Login required: ZenithProxy prints a device-code prompt (newer builds embed
          // the code in the URL .../link?otc=CODE; older printed "with code: CODE"). Only
          // flag it when the prompt is RECENT and we're not already queuing/in-world — a
          // successful login leaves the old prompt lingering in the scrollback, which must
          // not re-flag login (and a stale prompt also made the stuck-remediation re-provision).
          if (!recentQueue && !inGame) {
            const dc = parsers.deviceCode(recent);
            if (dc) {
              this._externalState.set(acc.id, { state: 'login_required' });
              metrics.recordSample(acc.id, 'login_required', null);
              this._onLoginRequired(acc.id, { url: dc.url, code: dc.code });
              this._syncMonitorAttach(acc, prev, this._externalState.get(acc.id));
              return;
            }
          }
          // Recovered (queuing or in-world again) → clear any pending login flag.
          if ((recentQueue || inGame) && this._authPending.has(acc.id)) this._authPending.delete(acc.id);
          if (recencyInWorld === true) {
            // A REAL in-world signal is the MOST RECENT line (recent chat/respawn, or
            // "Connected to the server"/"joined the game" — see inWorldByRecency). A low
            // queue number (<=2) is deliberately NOT treated as in_game any more: the 2b2t
            // End queue room shows tiny positions while still queuing, and attaching there
            // recorded garbage coords (y:-1199260). Requiring the recency signal also stops
            // a stale in-world line behind a fresh queue line from flipping a queuing bot.
            this._externalState.set(acc.id, { state: 'in_game', queuePosition: null });
          } else if (recencyInWorld === false || recentQueue) {
            // Most recent signal is a queue position (actively queuing).
            this._externalState.set(acc.id, { state: 'queuing', queuePosition: lastPos });
          } else if (prev.state === 'in_game') {
            this._externalState.set(acc.id, { state: 'in_game', queuePosition: null }); // sticky: no fresh signal, keep last known
          } else if (lastPos != null) {
            this._externalState.set(acc.id, { state: 'queuing', queuePosition: lastPos });
          } else {
            this._externalState.set(acc.id, { state: 'idle' });
          }
          const cur = this._externalState.get(acc.id);
          metrics.recordSample(acc.id, cur.state, cur.queuePosition);
          // Attach/detach the mineflayer monitor off the state transition (event-driven):
          // attach once when a placed account reaches in-world, tear down when it leaves.
          this._syncMonitorAttach(acc, prev, cur);
          // Every real 2b2t disconnect (in-world OR in-queue) is parsed off the pane
          // with its actual reason + whether you were driving — so drops self-document
          // instead of needing a forensic dig. (Was: a state-transition alert that only
          // caught in-world drops and couldn't see a queue-time drop losing its spot.)
          this._parseDrops(acc, lines);
          this._notifyQueueProgress(acc, cur);
          // Stuck "Connecting…": a SOCKS proxy error in the pane, or idle/offline too long
          // with a FROZEN pane → it'll never queue. Auto-remediate (swap proxy + restart).
          this._checkStuck(acc, cur, stdout);
          // Native visualRange = bulletproof detection (no mineflayer protocol parse
          // issues). Safety net: log sightings here only when the mineflayer monitor
          // ISN'T covering this placed account (a flap, or before it attaches), so we
          // never miss a passer-by and never double-count what mineflayer logged.
          if (state.isPlaced(acc.id) && !this.activeBots.has(acc.id)) this._parseVisualRange(acc, lines);
          else this._vrBaselined.delete(acc.id); // monitor covering → re-baseline on the next gap
          // Death detection runs straight off the pane (2b2t's own death broadcast),
          // so it's reliable even while the mineflayer monitor is detached — unlike
          // mineflayer's death event, which never fires for a pure spectator.
          if (state.isPlaced(acc.id)) this._parseDeaths(acc, lines);
        } catch (e) {
          systemLogger.error(`Poller error for ${this._name(acc)}: ${e.message}`);
        } finally {
          resolve();
        }
      });
    });

    // One tick = fan out captures across all accounts, awaiting the whole batch. Skip a
    // tick while the previous fan-out is still unresolved so slow captures can't overlap
    // and interleave state writes.
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try { await Promise.all(external().map(captureOne)); }
      finally {
        polling = false;
        // Push the fresh fleet snapshot to every open dashboard after each tick, so
        // queue positions / drops / state changes appear live. Without this the page
        // only re-fetched on rare events (place, add-account…) and sat stale until a
        // manual refresh. Viewers get the redacted projection (dashboard/server.js).
        this._broadcastDashboard({ type: 'status', data: this.getSystemStatus() });
      }
    };
    this._externalPoller = setInterval(poll, 15000);
    // Return the FIRST poll so start() can await it before reconnecting monitors.
    return poll();
  }

  /**
   * Event-driven monitor attach/detach, driven by the poller's per-account state
   * transitions (replaces the old self-rescheduling _launchBot retry timer that logged
   * every 15s for the whole hours-long queue). Attach the mineflayer monitor once when a
   * PLACED account reaches in-world; tear it down when it leaves (the pane visualRange
   * fallback then covers sightings until it's back in-world).
   */
  _syncMonitorAttach(acc, prev, cur) {
    if (!state.isPlaced(acc.id)) return;
    const isInGame = cur && cur.state === 'in_game';
    const wasInGame = prev && prev.state === 'in_game';
    if (isInGame) {
      if (!this.activeBots.has(acc.id)) this._launchBot(acc.id); // idempotent (single-flight)
    } else if (wasInGame && this.activeBots.has(acc.id)) {
      this._stopBot(acc.id);
    }
  }

  /**
   * Setup graceful shutdown.
   */
  _setupShutdownHandlers() {
    const shutdown = async () => {
      systemLogger.info('Shutting down...');

      // Stop all mineflayer monitors
      for (const [botId] of this.activeBots) {
        this._stopBot(botId);
      }

      // The ZenithProxy tmux sessions are intentionally left running (decoupled
      // from this process so a restart never re-queues them).
      if (this._externalPoller) clearInterval(this._externalPoller);

      // Save state
      state.stopAutoSave();

      systemLogger.info('Shutdown complete');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  /**
   * Setup CLI commands via stdin.
   */
  _setupCLI() {
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '',
    });

    rl.on('line', (line) => {
      const parts = line.trim().split(/\s+/);
      const cmd = parts[0];

      switch (cmd) {
        case 'status':
          this._cmdStatus();
          break;

        case 'stop':
          if (parts[1]) {
            this._stopBot(parts[1]);
          } else {
            systemLogger.info('Usage: stop <botId>');
          }
          break;

        case 'launch':
          if (parts[1]) {
            this._launchBot(parts[1]);
          } else {
            systemLogger.info('Usage: launch <botId>');
          }
          break;

        case 'help':
          systemLogger.info('Commands:');
          systemLogger.info('  status            - Show all bot statuses');
          systemLogger.info('  launch <botId>    - Manually (re)launch a bot');
          systemLogger.info('  stop <botId>      - Stop a bot');
          systemLogger.info('  help              - Show this help');
          systemLogger.info('  (add accounts + manage coverage from the dashboard)');
          break;

        default:
          if (cmd) systemLogger.info(`Unknown command: ${cmd}. Type 'help' for commands.`);
      }
    });
  }

  /** Print status of all bots */
  _cmdStatus() {
    systemLogger.info('=== Bot Status ===');
    const statuses = state.getAllBotStatuses();
    for (const [botId, info] of Object.entries(statuses)) {
      const active = this.activeBots.has(botId) ? '🟢' : '⚪';
      systemLogger.info(`${active} ${botId}: ${info.status || 'unknown'} | queue: ${info.queuePosition || '-'}`);
    }
    if (Object.keys(statuses).length === 0) {
      systemLogger.info('No bots registered. Add accounts to data/accounts.json and restart.');
    }
    systemLogger.info('==================');
  }

  /**
   * Start adding an account via Microsoft device-code login. Provisions + launches
   * a fresh ZenithProxy (tmux) which triggers the login; the poller surfaces the
   * device code to the dashboard and finalizes the account once it captures the IGN.
   * @returns {{ accountId: string }}
   */
  addAccountViaLogin() {
    const accountId = 'acc-' + Date.now().toString(36);
    const account = { id: accountId, type: 'spot', pending: true };
    this.accounts.push(account);
    this._persistAccounts();
    // Auto-provision: assign a free port + pool proxy, launch its ZenithProxy in a
    // detached tmux session. The poller then surfaces the device code, captures the
    // IGN, and runs queue/in-game notifications — no manual per-account wiring.
    this._provisionAndLaunch(accountId).catch(e => {
      systemLogger.error(`Provision failed for ${accountId}: ${e.message}`);
      this._broadcastDashboard({ type: 'account_error', accountId, error: e.message });
    });
    systemLogger.info(`Add-account started (${accountId}) — provisioning + awaiting device login`);
    return { accountId };
  }

  // ── Auto-provisioning (port + proxy + tmux launch) ─────────

  _zenithRoot() {
    const os = require('os');
    return process.env.ZENITH_ROOT || path.join(os.homedir(), 'zenith');
  }

  /** Instance folder for an account. Usually ~/zenith/<id>, but legacy accounts
   *  (e.g. north) override it via account.zenithDir. */
  _accountDir(account) {
    return path.join(this._zenithRoot(), account.zenithDir || account.id);
  }

  /** Next free bind port in the fleet range, avoiding ports already assigned. */
  _nextFreePort() {
    const used = new Set(this.accounts.map(a => a.port).filter(Boolean));
    let p = config.fleet.basePort || 25571;
    while (used.has(p)) p++;
    return p;
  }

  /**
   * Ensure an account has a WORKING SOCKS proxy assigned (unless it's flagged
   * directIp). Health-checks the current proxy and swaps in a fresh working one
   * from the pool if it's dead. Returns true if the account ends up with a proxy
   * (or is directIp), false if no working proxy was available.
   */
  async _ensureWorkingProxy(account) {
    if (account.directIp) { account.proxyHost = null; return true; }
    const current = account.proxyHost
      ? { host: account.proxyHost, port: account.proxyPort, user: account.proxyUser, password: account.proxyPass }
      : null;
    // Keep the current proxy only if it works AND is fast enough (close to the VPS).
    // A far proxy (Asia/EU) that "works" but adds 400-800ms of latency destabilises
    // the game connection, so we swap it for a nearby one.
    if (current) {
      const ms = await proxyPool.measureLatency(current);
      if (ms != null && ms <= (config.proxies.maxLatencyMs || 250)) return true;
      if (ms != null) systemLogger.warn(`Proxy ${current.host} for ${this._name(account)} is slow (${ms}ms) — picking a closer one`);
    }
    const used = this.accounts.filter(a => a.id !== account.id).map(a => a.proxyHost).filter(Boolean);
    const exclude = current ? used.concat([current.host]) : used;
    const px = await proxyPool.getBestProxy(exclude);
    if (!px) {
      // Nothing better free — keep the current proxy if it at least still works.
      if (current && await proxyPool.healthCheck(current)) { systemLogger.warn(`No closer proxy free for ${this._name(account)} — keeping ${current.host}`); return true; }
      return false;
    }
    if (current && current.host !== px.host) systemLogger.warn(`Proxy for ${this._name(account)}: ${current.host} → ${px.host} (${px.country || '?'})`);
    account.proxyHost = px.host; account.proxyPort = px.port; account.proxyUser = px.user; account.proxyPass = px.password;
    account.proxyCountry = px.country || null;
    return true;
  }

  /**
   * Provision + (re)launch an account's ZenithProxy in a detached tmux session,
   * decoupled from this Node process (so app restarts never re-queue it). Clones
   * the template, auto-assigns a free port + a pool proxy (so each account uses a
   * distinct IP — 2b2t rate-limits multiple accounts per IP), patches config
   * (verifyUsers:false so it's monitorable, low render), launches, auto-connects,
   * and seeds the proxy-access whitelist. Idempotent: reuses an existing dir.
   */
  /** Single-flight wrapper: only one provision may run per account at a time. Concurrent
   *  triggers (a manual Start/Re-login overlapping auto-remediation, or a double-click)
   *  otherwise race — both mutate account.proxy*, both rewrite config.json, and both do
   *  kill-session→new-session, so one can kill the other's freshly-created tmux session
   *  or leave proxyHost inconsistent with the launched config. */
  async _provisionAndLaunch(accountId) {
    if (this._provisioning.has(accountId)) {
      systemLogger.warn(`Provision for ${accountId} already in flight — ignoring the concurrent trigger`);
      return;
    }
    this._provisioning.add(accountId);
    try {
      return await this._provisionAndLaunchImpl(accountId);
    } finally {
      this._provisioning.delete(accountId);
    }
  }

  async _provisionAndLaunchImpl(accountId) {
    const account = this.accounts.find(a => a.id === accountId);
    if (!account) throw new Error('Unknown account');
    const { execFileSync } = require('child_process');
    const root = this._zenithRoot();
    const dir = this._accountDir(account);
    const template = process.env.ZENITH_TEMPLATE || path.join(root, 'north');
    if (!fs.existsSync(template)) throw new Error('No ZenithProxy template (~/zenith/north) to clone');

    if (!account.port) account.port = this._nextFreePort();
    // Assign/verify a working proxy before launch, so it never sits stuck on a
    // dead proxy. directIp accounts (e.g. the first one) ride the VPS IP.
    const haveProxy = await this._ensureWorkingProxy(account);
    if (!haveProxy) {
      systemLogger.warn(`No working proxy available for ${account.id} — using VPS IP (2b2t rate-limit risk)`);
      discord.message(`⚠️ No working proxy available for **${account.username || account.id}** — it'll use the VPS IP and may be rate-limited. Top up the Webshare pool.`);
      account.proxyHost = null;
    }
    if (!account.tmuxSession) account.tmuxSession = 'z-' + account.id.replace(/[^a-z0-9]/gi, '').slice(0, 10);

    const freshClone = !fs.existsSync(dir);
    if (freshClone) {
      // Async so the recursive clone of the ZenithProxy dir (only on a fresh add — the
      // user-driven path) never blocks the shared event loop (poller/monitors/dashboard).
      await fs.promises.cp(template, dir, { recursive: true });
      try { await fs.promises.rm(path.join(dir, 'mc_auth_cache.json'), { force: true }); } catch (e) {} // fresh login
    }
    const f = path.join(dir, 'config.json');
    const c = JSON.parse(await fs.promises.readFile(f, 'utf-8'));
    c.authentication.email = account.email || 'not@set.com';
    if (account.username) c.authentication.username = account.username;
    c.server.bind.port = account.port;
    c.server.verifyUsers = false;
    c.server.connectionTestOnStart = false;
    // Connect to 2b2t automatically on launch (so start-fleet / a reboot brings the
    // account back into the queue without a manual `connect`).
    if (c.client) c.client.autoConnect = true;
    // Point the displayed "Proxy IP" at this host (cosmetic; players connect here).
    if (c.server.proxyIP) c.server.proxyIP = (config.fleet.publicHost || c.server.proxyIP.split(':')[0]) + ':' + account.port;
    // The mineflayer monitor connects offline, so it presents an offline UUID that
    // can never match the spectator whitelist (which stores the online Mojang UUID).
    // Disable the spectator-whitelist check so the monitor can attach. Driving stays
    // locked: the control whitelist (server.extra.whitelist) still verifies online
    // UUIDs, so nobody can impersonate a controller offline — only spectate.
    if (c.server.spectator) c.server.spectator.whitelistEnabled = false;
    if (c.client) c.client.defaultClientRenderDistance = 6;
    // Only clear the cloned template's control whitelist on a FRESH clone — never
    // wipe an existing account's drive-access whitelist on a re-provision.
    if (freshClone && c.server.extra && c.server.extra.whitelist) c.server.extra.whitelist.whitelist = [];
    if (account.proxyHost) {
      // Auth stays DIRECT — Java's HttpClient can't do SOCKS, so routing the
      // Microsoft login through the proxy fails ("Login Failed"). Only the game
      // connection to 2b2t goes through the SOCKS proxy (that's what 2b2t
      // rate-limits per IP; Microsoft auth from the VPS IP is fine).
      c.authentication.useClientConnectionProxy = false;
      c.client.connectionProxy = Object.assign(c.client.connectionProxy || {}, {
        enabled: true, type: 'SOCKS5', host: account.proxyHost, port: account.proxyPort, user: account.proxyUser || '', password: account.proxyPass || '',
      });
    }
    await fs.promises.writeFile(f, JSON.stringify(c, null, 2));

    const s = account.tmuxSession;
    try { execFileSync('tmux', ['kill-session', '-t', s]); } catch (e) {}
    // Crash-loop so a proxy that exits is relaunched (matches start-fleet.sh on boot).
    // Pass the working dir via tmux's -c (a literal argv element) rather than `cd
    // '${dir}'` inside a shell string — that way the account-derived path can never
    // break out of the quoting into command injection, whatever it contains.
    execFileSync('tmux', ['new-session', '-d', '-s', s, '-c', dir,
      `while true; do ./launch; echo '[provision] proxy exited, restarting in 5s'; sleep 5; done`]);
    // Whitelist values are typed into the ZenithProxy console via send-keys, so a
    // stray newline/control char in an IGN could inject a second console command.
    // They're admin-set, but validate to real Minecraft IGNs and skip anything else.
    const validIgn = (x) => typeof x === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(x);
    // Clear any prior pending send-keys timer for this account (a re-provision) so a
    // stale timer can't fire `connect`/whitelist at the freshly restarted session.
    const prevTimer = this._provisionTimers.get(accountId);
    if (prevTimer) clearTimeout(prevTimer);
    const timer = setTimeout(() => {
      this._provisionTimers.delete(accountId);
      try { execFileSync('tmux', ['send-keys', '-t', s, 'connect', 'Enter']); } catch (e) {}
      // Control whitelist: your personal account(s) so you can drive it.
      for (const n of (config.proxyWhitelist || [])) {
        if (!validIgn(n)) { systemLogger.warn(`Skipping invalid whitelist IGN: ${JSON.stringify(n)}`); continue; }
        try { execFileSync('tmux', ['send-keys', '-t', s, `whitelist add ${n}`, 'Enter']); } catch (e) {}
      }
      // Spectator whitelist: the monitor IGN, so it can attach and watch.
      if (validIgn(config.fleet.monitorIgn)) {
        try { execFileSync('tmux', ['send-keys', '-t', s, `spectator whitelist add ${config.fleet.monitorIgn}`, 'Enter']); } catch (e) {}
      }
    }, 24000);
    if (timer.unref) timer.unref(); // never keep the process alive just for this
    this._provisionTimers.set(accountId, timer);
    this._persistAccounts();
    systemLogger.info(`Provisioned ${this._name(account)}: port ${account.port}, proxy ${account.proxyHost || 'VPS IP'}, tmux ${s}`);
    return { port: account.port, proxy: account.proxyHost || 'VPS IP', tmuxSession: s };
  }

  /** Start (or restart) a stopped account's proxy. */
  async startAccount(id) { return this._provisionAndLaunch(id); }

  /** Finalize an account once ZenithProxy reports its IGN after login. */
  _onAccountAuthenticated(accountId, ign) {
    const acc = this.accounts.find(a => a.id === accountId);
    if (acc) {
      acc.username = ign;
      delete acc.pending;
      this._persistAccounts();
      this._syncNetworkIgns();
      systemLogger.info(`Account ${accountId} authenticated as ${ign}`);
      this._broadcastDashboard({ type: 'account_added', accountId, ign });
    }
  }

  // ── Login / auth health ───────────────────────────────────

  /**
   * Detect an account genuinely stuck on "Connecting…" and auto-remediate (swap a dead
   * proxy + restart). Because remediation kills + restarts the ZenithProxy (sending it to
   * the BACK of the hours-long queue — the most expensive resource in the system), it
   * requires a POSITIVE stuck signal, never mere absence of a queue line: either an
   * explicit proxy error in the RECENT pane, or a long idle stretch AND a FROZEN pane (no
   * new output across several polls). A transient parser gap (the pane momentarily lacked
   * a queue line while still printing chat/connecting output) resets the freeze counter
   * and never remediates. Debounced so it never loops.
   */
  _checkStuck(acc, cur, stdout) {
    const active = cur.state === 'queuing' || cur.state === 'in_game' || cur.state === 'login_required';
    if (active) { this._stuckSince.delete(acc.id); this._paneProgress.delete(acc.id); return; }
    if (!this._stuckSince.has(acc.id)) this._stuckSince.set(acc.id, Date.now());
    const stuckMs = Date.now() - this._stuckSince.get(acc.id);
    // Immediate-remediation signal: a dead SOCKS proxy, or ZenithProxy giving up
    // reconnecting (e.g. a proxy blip → "Login Failed" → AutoReconnect cancelled).
    // Scope to the RECENT pane only — a stale error lingering in the 300-line
    // scrollback (from an episode it already recovered from) must not trigger a
    // re-provision (which would needlessly re-queue the account).
    const recentTail = stdout.split('\n').slice(-25).join('\n');
    const proxyError = /ProxyConnectException|socks5, (?:password|no acceptable)|Cancelling AutoReconnect|not reconnectable/i.test(recentTail);
    // Pane-progress tracking: a session still printing output (connecting, auth, chat) is
    // making progress and must NOT be re-queued. Only a pane FROZEN (identical tail) across
    // N consecutive polls, on top of a long idle stretch, confirms it's truly stuck.
    const sig = `${recentTail.length}:${recentTail.slice(-160)}`;
    const prevProg = this._paneProgress.get(acc.id);
    const frozenTicks = (prevProg && prevProg.sig === sig) ? prevProg.frozenTicks + 1 : 0;
    this._paneProgress.set(acc.id, { sig, frozenTicks });
    const frozen = frozenTicks >= (config.remediation.stuckFrozenTicks || 8);
    const lastRemedy = this._remediatedAt.get(acc.id) || 0;
    const trulyStuck = proxyError || (stuckMs > (config.remediation.stuckIdleMs || 180000) && frozen);
    if (trulyStuck && Date.now() - lastRemedy > (config.remediation.cooldownMs || 600000)) {
      this._remediatedAt.set(acc.id, Date.now());
      this._remediateStuck(acc, proxyError).catch(e => systemLogger.error(`Remediation failed for ${acc.id}: ${e.message}`));
    }
  }

  async _remediateStuck(acc, proxyError) {
    const name = acc.username || acc.id;
    if (acc.directIp) {
      discord.message(`⚠️ **${name}** is stuck connecting on the VPS IP (no proxy to swap). Check the VPS — likely an auth or 2b2t-side issue.`);
      return;
    }
    systemLogger.warn(`${name} stuck connecting${proxyError ? ' (proxy error)' : ''} — re-provisioning with a working proxy`);
    const before = acc.proxyHost;
    await this._provisionAndLaunch(acc.id); // health-checks + swaps a dead proxy, then restarts
    if (acc.proxyHost && acc.proxyHost !== before) {
      metrics.recordEvent(acc.id, 'proxy_swap', `${before || '—'} → ${acc.proxyHost}`);
      discord.message(`🔧 **${name}** was stuck connecting (dead proxy \`${before || '—'}\`) — auto-swapped to \`${acc.proxyHost}\` and restarted.`);
    } else if (!acc.proxyHost) {
      discord.message(`🔴 **${name}** stuck connecting and **no working proxy available** to swap in. Top up the Webshare pool.`);
    } else {
      discord.message(`🔧 **${name}** was stuck connecting — restarted it (proxy still \`${acc.proxyHost}\`).`);
    }
  }

  /**
   * Parse ZenithProxy's native visualRange enter/leave/logout alerts from the pane
   * and log them as sightings — the reliable fallback used while the mineflayer
   * monitor is disconnected (it can't hit mineflayer's protocol parse issues). On the
   * first parse of a gap we baseline the existing lines silently so we only log NEW
   * events, not stale scrollback.
   */
  _parseVisualRange(acc, lines) {
    let seen = this._vrSeen.get(acc.id);
    if (!seen) { seen = new Set(); this._vrSeen.set(acc.id, seen); }
    const baseline = !this._vrBaselined.has(acc.id);
    for (const line of lines.slice(-30)) {
      const ev = parsers.visualRangeEvent(line);
      if (!ev) continue;
      const { player, kind } = ev;
      const tsm = line.match(/(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})/);
      const sig = `${player}|${kind}|${tsm ? tsm[1] : line.slice(0, 24)}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      if (baseline) continue; // first parse of this gap → record existing lines silently
      const low = player.toLowerCase();
      if (state.isBotUsername(low)) continue;                                            // our own bots/monitor
      if (config.owner.ign && config.owner.ign.toLowerCase() === low) continue;          // owner
      if ((config.whitelist || []).some(n => String(n).toLowerCase() === low)) continue; // ignore list
      this._recordVisualRangeSighting(acc, player, kind);
    }
    if (seen.size > 300) this._vrSeen.set(acc.id, new Set([...seen].slice(-150)));
    this._vrBaselined.add(acc.id);
  }

  /**
   * Detect THIS account's deaths from the pane and alert. 2b2t uses custom death/kill
   * flavour text (and the killer is often named first), so matching the wording is
   * unreliable — instead we anchor on ZenithProxy's "[AutoRespawn] Performing Respawn",
   * which fires only when OUR account dies, then read the cause from the nearby
   * broadcast that names our IGN. Like visualRange, the first parse of a gap is
   * baselined silently so stale scrollback deaths don't re-fire, and a `seen` set
   * dedupes. On a real death we ping Discord with the cause, record a metrics event,
   * and un-place the bot (it respawned at spawn — no longer holding its spot).
   */
  _parseDeaths(acc, lines) {
    if (!acc.username) return; // not authenticated yet — can't attribute a death
    let seen = this._deathSeen.get(acc.id);
    if (!seen) { seen = new Set(); this._deathSeen.set(acc.id, seen); }
    const baseline = !this._deathBaselined.has(acc.id);
    const L = lines;
    for (let i = 0; i < L.length; i++) {
      if (!parsers.isPlayerDeath(L[i])) continue; // our account's death event marker
      // The block is contiguous around the marker: the cause (a chat broadcast naming
      // us) just above, and the coordinates + dimension just below.
      let cause = '', coords = null, dim = '', ts = '';
      for (let j = i - 1; j >= 0 && j >= i - 7; j--) {
        const t = L[j].match(/(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})/); if (t && !ts) ts = t[1];
        if (!cause) { const c = parsers.deathBroadcast(L[j], acc.username); if (c) cause = c; }
      }
      for (let j = i + 1; j <= i + 7 && j < L.length; j++) {
        if (!coords) coords = parsers.deathCoords(L[j]);
        if (L[j].trim() === 'Dimension' && L[j + 1]) dim = L[j + 1].trim();
      }
      const sig = `death|${ts || i}|${coords ? coords.x + ',' + coords.z : cause.slice(0, 20)}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      if (baseline) continue; // first parse of this gap → record silently
      const name = acc.username || acc.id;
      const where = coords ? ` at ${coords.x}, ${coords.y}, ${coords.z}${dim ? ` (${dim})` : ''}` : '';
      systemLogger.warn(`${name} DIED${cause ? ': ' + cause : ''}${where}`);
      metrics.recordEvent(acc.id, 'death', (cause || 'died') + where);
      discord.message(`💀 **${name}** died on 2b2t${cause ? ` — ${cause}` : ''}${where}. It respawned at spawn (un-placed); drive it back to its spot and mark it Placed.`);
      // Route through _setPlaced (not raw state.setPlaced) so the still-attached monitor is
      // actually torn down. A dead spectator never fires mineflayer's death event, so without
      // this the monitor keeps scanning at spawn and attributes spawn traffic to the spot.
      this._setPlaced(acc.id, false);
    }
    if (seen.size > 100) this._deathSeen.set(acc.id, new Set([...seen].slice(-50)));
    this._deathBaselined.add(acc.id);
  }

  /**
   * Detect every real 2b2t disconnect from the pane (in-world OR in-queue) and alert
   * with the actual reason + whether it happened while you were driving. This closes the
   * gap where a queue-time drop (losing your queue spot) never alerted, and it stops the
   * "why did it drop?" guesswork — the reason is captured at the moment it happens.
   * Baselined + deduped like deaths so scrollback doesn't re-fire.
   */
  _parseDrops(acc, lines) {
    let seen = this._dropSeen.get(acc.id);
    if (!seen) { seen = new Set(); this._dropSeen.set(acc.id, seen); }
    const baseline = !this._dropBaselined.has(acc.id);
    const recent = lines.slice(-120);
    for (let i = 0; i < recent.length; i++) {
      const ev = parsers.disconnectEvent(recent[i]);
      if (!ev) continue;
      const tsm = recent[i].match(/(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})/);
      const sig = `drop|${tsm ? tsm[1] : i}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      if (baseline) continue; // first parse of this gap → record scrollback silently
      const tsOf = l => (l.match(/(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})/) || [])[1] || '';
      const dropTs = tsOf(recent[i]);
      const reason = parsers.kickReason(recent.slice(Math.max(0, i - 12), i + 2).join('\n')) || ev.reason;
      // Driving = a controlling player (you) logged in and hadn't left before this drop.
      // Scan the whole window (the login can be ~60s back). Ignore the controller
      // "Player disconnected" that shares the drop's timestamp — that's the drop
      // force-kicking your client (a cascade), not you leaving beforehand.
      let ctrlIn = -1, ctrlOut = -1;
      for (let j = 0; j < i; j++) {
        if (parsers.controllerActive(recent[j])) ctrlIn = j;
        else if (/\[Server\][^\]]*\]\s*Player disconnected:/i.test(recent[j]) && tsOf(recent[j]) && tsOf(recent[j]) !== dropTs) ctrlOut = j;
      }
      const driving = ctrlIn > ctrlOut;
      const name = acc.username || acc.id;
      systemLogger.warn(`${name} DROPPED (${driving ? 'while driving' : 'on its own'}): ${reason}`);
      metrics.recordEvent(acc.id, 'drop', `${reason}${driving ? ' [driving]' : ''}`);
      this._announceDrop(acc, name, reason, driving);
    }
    if (seen.size > 100) this._dropSeen.set(acc.id, new Set([...seen].slice(-50)));
    this._dropBaselined.add(acc.id);
  }

  /**
   * Alert on a drop, but two guards keep a DEAD proxy from spamming Discord:
   *  1. Coalesce — at most one drop ping per account per window; extra drops in that
   *     window are counted and summarized on the next allowed ping.
   *  2. Auto-swap — several connection drops in a short window on a proxied account
   *     means the proxy is dead (not an occasional stall), which _checkStuck misses
   *     because the session keeps briefly re-queuing. Re-provision onto a working
   *     proxy (debounced, shared with _checkStuck via _remediatedAt).
   */
  _announceDrop(acc, name, reason, driving) {
    const now = Date.now();
    const PING_COOLDOWN = 12 * 60 * 1000;
    let pd = this._dropPingAt.get(acc.id);
    if (!pd) { pd = { last: 0, suppressed: 0 }; this._dropPingAt.set(acc.id, pd); }
    if (now - pd.last >= PING_COOLDOWN) {
      const drive = driving ? ' *(while you were driving — check your client is on 1.21.4)*' : '';
      const extra = pd.suppressed > 0 ? ` *(plus ${pd.suppressed} more drop${pd.suppressed === 1 ? '' : 's'} since the last alert — proxy may be flaky)*` : '';
      discord.message(`⚠️ **${name}** dropped from 2b2t — ${reason}${drive}${extra}. Auto-reconnecting.`);
      pd.last = now; pd.suppressed = 0;
    } else {
      pd.suppressed++; // folded into the next allowed ping
    }

    // Dead-proxy auto-swap: skip driving drops (a client-version issue) and directIp
    // accounts (no proxy to swap).
    if (driving || acc.directIp) return;
    let w = this._dropWindow.get(acc.id);
    if (!w) { w = []; this._dropWindow.set(acc.id, w); }
    const WINDOW = 15 * 60 * 1000;
    w.push(now);
    while (w.length && w[0] < now - WINDOW) w.shift();
    const cooldownMs = (config.remediation && config.remediation.cooldownMs) || 600000;
    if (w.length >= 3 && now - (this._remediatedAt.get(acc.id) || 0) > cooldownMs) {
      this._remediatedAt.set(acc.id, now);
      w.length = 0;
      systemLogger.warn(`${name} dropped ≥3× in 15m — proxy likely dead, auto-swapping`);
      this._remediateStuck(acc, true).catch(e => systemLogger.error(`Auto-swap for ${acc.id} failed: ${e.message}`));
    }
  }

  /** Write a visualRange sighting into the activity pipeline (JSONL + live dashboard
   *  broadcast + summary + watchlist alert), mirroring PlayerMonitor. Coords are
   *  approximate — the bot's last known position (it's parked at its spot). */
  _recordVisualRangeSighting(acc, player, kind) {
    const spotId = acc.username || acc.id; // matches PlayerMonitor._key()
    const pos = (state.getBotStatus(acc.id) || {}).lastPosition || null;
    const detection = {
      timestamp: new Date().toISOString(),
      botId: acc.id, spotId, playerName: player,
      coords: pos ? { x: pos.x, y: pos.y, z: pos.z } : null,
      distance: null,
      // enter = live ping; leave/logout = a completed pass (counts as a sighting). No
      // coords delta is available, so direction is Unknown (won't pollute the dir mix).
      direction: kind === 'enter' ? 'Entering' : 'Unknown',
      speed: 0,
      dimension: (pos && pos.dimension) || 'minecraft:the_nether',
      source: 'visualRange',
      watched: (config.watchlist || []).some(n => String(n).toLowerCase() === player.toLowerCase()),
    };
    try {
      const dir = path.resolve(config.logging.activityDir);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, `${spotId}_${detection.timestamp.slice(0, 10)}.jsonl`), JSON.stringify(detection) + '\n');
    } catch (e) { systemLogger.error('visualRange log failed:', e.message); }
    loggerEvents.emit('activity', detection); // → dashboard player_detected broadcast
    state.recordDetection(spotId, player);
    systemLogger.info(`[VisualRange] ${player} ${kind} near ${spotId} (mineflayer offline — radar fallback)`);
    if (detection.watched && kind === 'enter') discord.watchlistHit({ spotId, ...detection });
  }

  /** Alert when an account's ZenithProxy goes fully offline (tmux session gone). 2b2t
   *  disconnects/re-queues are handled by _parseDrops (pane-based, with the real reason). */
  _notifyProxyDown(acc, prevState, curState) {
    const name = acc.username || acc.id;
    if (curState === 'offline') {
      metrics.recordEvent(acc.id, 'offline', `was ${prevState}`);
      discord.message(`🔴 **${name}** — ZenithProxy is **OFFLINE** (tmux session gone). The boot service / crash-loop should restart it; check the VPS if this persists.`);
    }
  }

  /**
   * Ping Discord as an account crosses queue milestones and when it gets in —
   * so the operator knows when to drive it, even while asleep. Covers every
   * tmux-run spot-holder (replaces the single-account bash notifier).
   */
  _notifyQueueProgress(acc, st) {
    if (!st) return;
    const name = acc.username || acc.id;
    if (st.state === 'queuing' && st.queuePosition != null) {
      this._inGameNotified.delete(acc.id); // back in queue → re-arm the in-game ping
      let marks = this._queueMarks.get(acc.id);
      if (!marks) {
        // First sight of this account (e.g. right after an app restart): record
        // which marks it's ALREADY past, silently — don't re-announce them.
        marks = new Set();
        for (const m of [250, 100, 50, 10]) if (st.queuePosition <= m) marks.add(m);
        this._queueMarks.set(acc.id, marks);
        return;
      }
      for (const m of [250, 100, 50, 10]) {
        if (st.queuePosition <= m && !marks.has(m)) {
          marks.add(m);
          discord.message(`🔔 **${name}** — queue position **${st.queuePosition}** (past the ${m} mark).`);
        }
      }
    } else if (st.state === 'in_game') {
      if (!this._inGameNotified.has(acc.id)) {
        this._inGameNotified.add(acc.id);
        this._queueMarks.delete(acc.id);
        metrics.recordEvent(acc.id, 'in_game', 'reached the server');
        const where = (acc.port && config.fleet.publicHost) ? `\`${config.fleet.publicHost}:${acc.port}\`` : 'its proxy (see dashboard)';
        discord.message(`✅ **${name}** is **IN THE SERVER**! Connect to ${where} (Minecraft **1.21.4**) to drive it to its spot.`);
      }
    }
  }

  /**
   * An account needs a Microsoft device-code login (token expired/revoked, or a
   * fresh add). Surfaces it on the dashboard and pings Discord once per episode.
   */
  _onLoginRequired(id, d) {
    const firstThisEpisode = !this._authPending.has(id);
    this._authPending.set(id, { url: d.url, code: d.code, since: Date.now() });
    this._broadcastDashboard({ type: 'device_code', accountId: id, url: d.url, code: d.code });
    if (firstThisEpisode) {
      metrics.recordEvent(id, 'login_required', 'device-code login needed');
      const acc = this.accounts.find(a => a.id === id);
      const name = (acc && acc.username) || id;
      systemLogger.warn(`Account ${name} (${id}) needs login — code ${d.code}`);
      discord.loginRequired({ name, url: d.url, code: d.code });
    }
  }

  /**
   * Force a fresh login for an account: clear its cached token and restart the
   * proxy so ZenithProxy re-runs the device-code flow (which surfaces here).
   */
  async reloginAccount(id) {
    const account = this.accounts.find(a => a.id === id);
    if (!account) throw new Error('Unknown account');
    // Clear the cached token + relaunch → ZenithProxy re-runs the device-code flow,
    // which the poller surfaces to the dashboard + Discord automatically.
    try { fs.rmSync(path.join(this._accountDir(account), 'mc_auth_cache.json'), { force: true }); } catch (e) {}
    this._authPending.delete(id);
    return this._provisionAndLaunch(id);
  }

  // ── Settings (dashboard-editable runtime config) ──────────

  /** Current settings (live from config). */
  getSettings() {
    return {
      whitelist: config.whitelist || [],
      watchlist: config.watchlist || [],
      proxyWhitelist: config.proxyWhitelist || [],
      discordWebhookUrl: config.discord.webhookUrl || '',
      sightingAlerts: config.discord.sightingAlerts || 'off',
      monitorIgn: config.fleet.monitorIgn || '',
      retentionDays: config.logging.retentionDays || 0,
      ownerIgn: config.owner.ign || '',
    };
  }

  /**
   * Apply a settings patch to the live config. whitelist, webhook, and proxy
   * access take effect immediately; monitorIgn + retentionDays need a restart.
   * @param {boolean} persist - write to settings.json (false during load)
   */
  updateSettings(patch = {}, persist = true) {
    if (Array.isArray(patch.whitelist)) {
      config.whitelist = patch.whitelist.map(s => String(s).trim()).filter(Boolean);
    }
    if (Array.isArray(patch.watchlist)) {
      config.watchlist = patch.watchlist.map(s => String(s).trim()).filter(Boolean);
    }
    if (Array.isArray(patch.proxyWhitelist)) {
      const prev = config.proxyWhitelist || [];
      config.proxyWhitelist = patch.proxyWhitelist.map(s => String(s).trim()).filter(Boolean);
      if (persist) this._applyProxyWhitelist(prev, config.proxyWhitelist);
    }
    if (patch.discordWebhookUrl !== undefined) config.discord.webhookUrl = String(patch.discordWebhookUrl).trim();
    if (patch.sightingAlerts !== undefined && ['off', 'exit', 'all'].includes(patch.sightingAlerts)) {
      config.discord.sightingAlerts = patch.sightingAlerts;
    }
    if (patch.monitorIgn !== undefined) config.fleet.monitorIgn = String(patch.monitorIgn).trim();
    if (patch.retentionDays !== undefined) config.logging.retentionDays = parseInt(patch.retentionDays, 10) || 0;
    if (patch.ownerIgn !== undefined) config.owner.ign = String(patch.ownerIgn).trim();
    if (persist) {
      try {
        writeJsonAtomic(path.resolve(config.paths.settings), this.getSettings());
      } catch (e) { systemLogger.error('Failed to persist settings:', e.message); }
      this._broadcastDashboard({ type: 'settings_changed' });
    }
    return this.getSettings();
  }

  /**
   * Reconcile each ZenithProxy instance's control whitelist (server.extra.whitelist)
   * to the desired proxy-access list, via the proxy's `whitelist add/remove` command
   * (which resolves the Mojang UUID and persists), sent over tmux send-keys.
   */
  _applyProxyWhitelist(prev = [], next = []) {
    const { execFile } = require('child_process');
    // Whitelist values are typed into the ZenithProxy console via send-keys, so a
    // stray newline/control char in an IGN could inject a second console command
    // across the whole fleet. Same guard as the provision path — validate to real
    // Minecraft IGNs and drop anything else (these are admin-set, but defense-in-depth).
    const validIgn = (x) => typeof x === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(x);
    const added = next.filter(n => validIgn(n) && !prev.some(p => p.toLowerCase() === n.toLowerCase()));
    const removed = prev.filter(p => validIgn(p) && !next.some(n => n.toLowerCase() === p.toLowerCase()));
    const cmds = [...added.map(n => `whitelist add ${n}`), ...removed.map(n => `whitelist remove ${n}`)];
    if (!cmds.length) return;
    for (const account of this.accounts) {
      if (!account.tmuxSession) continue;
      for (const cmd of cmds) {
        execFile('tmux', ['send-keys', '-t', account.tmuxSession, cmd, 'Enter'], () => {});
      }
    }
    systemLogger.info(`Proxy whitelist: +[${added.join(', ')}] -[${removed.join(', ')}] across ${this.accounts.length} accounts`);
  }

  // ── Group / coverage management ───────────────────────────

  /** Create a coverage group (nether x/z location + a coverage target for the map). */
  createGroup({ name, x, z, desiredOnline }) {
    const id = 'grp-' + Date.now().toString(36);
    const group = {
      id,
      name: (name && name.trim()) || id,
      x: parseInt(x, 10) || 0,
      z: parseInt(z, 10) || 0,
      desiredOnline: Math.max(1, parseInt(desiredOnline, 10) || 1), // coverage target (green when met)
      accounts: [],
    };
    this.groups.push(group);
    this._persistGroups();
    return group;
  }

  /** Update a group's name / location / coverage target. */
  updateGroup(id, fields) {
    const g = this.groups.find(x => x.id === id);
    if (!g) return false;
    if (fields.name !== undefined) g.name = String(fields.name).trim() || g.name;
    if (fields.x !== undefined) g.x = parseInt(fields.x, 10) || 0;
    if (fields.z !== undefined) g.z = parseInt(fields.z, 10) || 0;
    if (fields.desiredOnline !== undefined) g.desiredOnline = Math.max(1, parseInt(fields.desiredOnline, 10) || 1);
    this._persistGroups();
    return true;
  }

  /** Move an account into a group (removing it from any other group first). */
  assignAccount(accountId, groupId) {
    for (const g of this.groups) g.accounts = g.accounts.filter(a => a !== accountId);
    const g = this.groups.find(x => x.id === groupId);
    if (!g) return false;
    if (!g.accounts.includes(accountId)) g.accounts.push(accountId);
    this._persistGroups();
    return true;
  }

  /** Remove an account from all groups (unassigned). */
  unassignAccount(accountId) {
    for (const g of this.groups) g.accounts = g.accounts.filter(a => a !== accountId);
    this._persistGroups();
    return true;
  }

  /** Delete a group (its accounts become unassigned). */
  deleteGroup(id) {
    this.groups = this.groups.filter(g => g.id !== id);
    this._persistGroups();
    return true;
  }

  _persistGroups() {
    try {
      writeJsonAtomic(path.resolve(config.paths.groups), this.groups);
    } catch (e) {
      systemLogger.error('Failed to persist groups:', e.message);
    }
  }

  /** Persist the in-memory accounts list to disk. */
  _persistAccounts() {
    try {
      writeJsonAtomic(path.resolve(config.paths.accounts), this.accounts);
    } catch (e) {
      systemLogger.error('Failed to persist accounts:', e.message);
    }
  }

  /** Permanently remove an account: stop its monitor + ZenithProxy, and drop it
   *  from accounts, groups, and state. */
  deleteAccount(accountId) {
    if (this.activeBots.has(accountId)) this._stopBot(accountId);
    // Tear down its ZenithProxy tmux session if running.
    const acc = this.accounts.find(a => a.id === accountId);
    if (acc && acc.tmuxSession) {
      try { require('child_process').execFileSync('tmux', ['kill-session', '-t', acc.tmuxSession]); } catch (e) {}
    }
    this.accounts = this.accounts.filter(a => a.id !== accountId);
    this._persistAccounts();
    this._syncNetworkIgns();
    this.unassignAccount(accountId); // removes from groups + persists
    state.removeBot(accountId);       // clears bot status + placed flag
    // Cancel any pending post-provision send-keys timer so it can't fire at a killed
    // (or a future account reusing the id's) session.
    const pt = this._provisionTimers.get(accountId);
    if (pt) { clearTimeout(pt); this._provisionTimers.delete(accountId); }
    const rt = this._reconnectTimers.get(accountId);
    if (rt) clearTimeout(rt);
    // Drop all per-account in-memory state so nothing leaks across deletes.
    for (const m of [this._externalState, this._authPending, this._queueMarks, this._stuckSince, this._remediatedAt, this._paneProgress, this._vrSeen, this._deathSeen, this._dropSeen, this._dropPingAt, this._dropWindow, this._offlineTicks, this._reconnectTimers, this._monitorHoldUntil]) m.delete(accountId);
    for (const s of [this._inGameNotified, this._launching, this._launchWaiting, this._vrBaselined, this._deathBaselined, this._dropBaselined]) s.delete(accountId);
    systemLogger.info(`Deleted account ${(acc && acc.username) ? `${acc.username} (${accountId})` : accountId}`);
    this._broadcastDashboard({ type: 'account_deleted', accountId });
    return true;
  }

  // ── Dashboard API helpers ─────────────────────────────

  /** Get full system status for dashboard */
  getSystemStatus() {
    const placed = state.getAllPlaced();
    const bots = state.getAllBotStatuses();
    // Ensure every configured account shows up (even if it has never connected)
    // so the user can place it, and surface the placed flag for the toggle.
    for (const account of this.accounts) {
      if (!bots[account.id]) {
        bots[account.id] = { status: 'offline' };
      }
    }
    for (const id of Object.keys(bots)) {
      const account = this.accounts.find(a => a.id === id);
      bots[id].placed = !!placed[id];
      if (account) { bots[id].port = account.port || null; bots[id].proxyHost = account.proxyHost || null; }
      // Actual current connection (not stale lastPosition): a live mineflayer
      // monitor, or the account's ZenithProxy is in-world.
      const ext = this._externalState.get(id);
      bots[id].connected = this.activeBots.has(id) || (ext && ext.state === 'in_game');
      // Prefer the real Minecraft IGN (from accounts.json, else last seen on connect).
      bots[id].ign = (account && account.username) || bots[id].username || null;
      if (ext) {
        bots[id].proxyState = ext.state;
        bots[id].queuePosition = ext.queuePosition;
      }
      // Auth health: surfaced so the dashboard can show a "Login required" card.
      if (this._authPending.has(id)) {
        const p = this._authPending.get(id);
        bots[id].loginRequired = true;
        bots[id].deviceCode = { url: p.url, code: p.code };
        bots[id].connected = false;
      }
    }
    // The shared monitor identity is shown separately, not as a placeable alt.
    const monIgn = config.fleet.monitorIgn;
    if (monIgn) {
      for (const id of Object.keys(bots)) {
        if (bots[id].ign === monIgn) delete bots[id];
      }
    }
    // Aggregate fleet verdict for the dashboard hero. Deliberately non-identifying
    // (counts only) so the viewer role can see fleet health without bot names/IPs.
    const fleet = { inWorld: 0, queuing: 0, login: 0, offline: 0, total: 0, nearestQueue: null };
    for (const b of Object.values(bots)) {
      fleet.total++;
      if (b.loginRequired) fleet.login++;
      else if (b.proxyState === 'in_game') fleet.inWorld++;
      else if (b.proxyState === 'queuing') {
        fleet.queuing++;
        if (b.queuePosition != null && (fleet.nearestQueue == null || b.queuePosition < fleet.nearestQueue)) fleet.nearestQueue = b.queuePosition;
      } else fleet.offline++;
    }
    return {
      bots,
      fleet,
      accounts: this.accounts.map(a => ({
        id: a.id,
        active: this.activeBots.has(a.id),
        placed: !!placed[a.id],
      })),
      groups: this.groups,
      // The shared monitor identity that spectates the alts + logs.
      monitor: {
        ign: config.fleet.monitorIgn || null,
        active: this.activeBots.size,
      },
      activity: state.getActivitySummary(),
      uptime: process.uptime(),
    };
  }

  /** Parse a range string into milliseconds. */
  _rangeMs(range) {
    switch (range) {
      case '1h': return 60 * 60 * 1000;
      case '6h': return 6 * 60 * 60 * 1000;
      case '7d': return 7 * 24 * 60 * 60 * 1000;
      case '24h': default: return 24 * 60 * 60 * 1000;
    }
  }

  /**
   * Per-account operational metrics: availability %, drop/login counts, the 24h
   * state timeline, queue-position trend, and a recent events feed. Trusted-only
   * (exposes ports + proxy IPs). range: 1h|6h|24h|7d.
   */
  async getMetricsSummary(range = '24h') {
    const since = Date.now() - this._rangeMs(range);
    const accts = this.accounts.filter(a => a.tmuxSession);
    const ids = accts.map(a => a.id);
    let proxyList = [];
    try { proxyList = await proxyPool.list(); } catch (e) {}
    const proxyByHost = {}; for (const px of proxyList) proxyByHost[px.host] = px;
    const accounts = accts.map(a => {
      const ext = this._externalState.get(a.id) || {};
      const px = a.proxyHost ? proxyByHost[a.proxyHost] : null;
      return {
        id: a.id,
        ign: a.username || a.id,
        port: a.port || null,
        proxyHost: a.directIp ? 'VPS IP' : (a.proxyHost || null),
        proxyCountry: px ? (px.country || null) : null,
        proxyCity: px ? (px.city || null) : null,
        current: { state: ext.state || 'unknown', queuePosition: ext.queuePosition != null ? ext.queuePosition : null },
        availability: metrics.availability(a.id, since),   // { code: ms }
        drops: metrics.countEvents(a.id, 'drop', since),
        logins: metrics.countEvents(a.id, 'login_required', since),
        proxySwaps: metrics.countEvents(a.id, 'proxy_swap', since),
        lastDrop: (metrics.lastEvent(a.id, 'drop') || {}).t || null,
        lastInGame: (metrics.lastEvent(a.id, 'in_game') || {}).t || null,
        segments: metrics.segments(a.id, since),           // [{ s, t0, t1 }]
        queue: metrics.queueSeries(a.id, since),           // [{ t, q }]
      };
    });
    let pool = null;
    try {
      const plan = await proxyPool.getPlanInfo().catch(() => null);
      pool = { total: proxyList.length, assigned: accts.filter(a => a.proxyHost).length, plan };
    } catch (e) {}
    return {
      range,
      rangeMs: this._rangeMs(range),
      generatedAt: Date.now(),
      stateLabel: { G: 'in-world', Q: 'queuing', L: 'login needed', O: 'offline', I: 'connecting', U: 'unknown' },
      accounts,
      events: metrics.recentEvents(since, 200, ids),
      pool,
    };
  }

  /**
   * Aggregate stored sightings into per-player intelligence profiles: how often
   * and where each player has been seen, their dominant travel direction, gear,
   * a wealth ESTIMATE (see caveat below), and active-hours. Reads the activity
   * JSONL newest-first, capped. range: 1h|24h|7d|all.
   *
   * CAVEAT: wealthScore is an ESTIMATE of time+money invested that CORRELATES
   * WITH BUT DOES NOT EQUAL resource/dupe-stash wealth. It misses low-playtime
   * dupers and fresh alts, and can overrate AFK bots unless the bot filter is
   * applied. Also: api.2b2t.vc backfills playtime/kills/deaths only from when it
   * began tracking, so those fields are 0 for legacy/OG accounts — such accounts
   * are scored from joinCount + firstSeen + observed gear and are inherently
   * lower-confidence. Never present wealth as fact; always surface
   * confidence/source.
   */
  async getPlayerProfiles({ range = 'all', limit = 500, sort = 'recent' } = {}) {
    const fsp = fs.promises;
    const dir = path.resolve(config.logging.activityDir);
    if (!fs.existsSync(dir)) return [];
    const now = Date.now();
    let cutoff = 0;
    if (range === '1h') cutoff = now - 60 * 60 * 1000;
    else if (range === '24h') cutoff = now - 24 * 60 * 60 * 1000;
    else if (range === '7d') cutoff = now - 7 * 24 * 60 * 60 * 1000;

    const dateOf = f => (f.match(/_(\d{4}-\d{2}-\d{2})\.jsonl$/) || [])[1] || '';
    let files;
    try {
      files = (await fsp.readdir(dir)).filter(f => f.endsWith('.jsonl'))
        .sort((a, b) => dateOf(b).localeCompare(dateOf(a)) || b.localeCompare(a)); // newest DATE first across all accounts
    } catch (e) { return []; }

    const profiles = new Map();
    const watch = new Set((config.watchlist || []).map(s => String(s).toLowerCase()));
    const MAX_SCAN = 40000;
    // Date-sorted newest-first → stop once a file's day is before the range cutoff.
    const cutoffDate = cutoff > 0 ? new Date(cutoff).toISOString().slice(0, 10) : '';
    let scanned = 0;
    outer:
    for (const file of files) {
      if (cutoffDate) { const fd = dateOf(file); if (fd && fd < cutoffDate) break; }
      let raw;
      try { raw = await fsp.readFile(path.join(dir, file), 'utf-8'); } catch (e) { continue; }
      const lines = raw.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        if (++scanned > MAX_SCAN) break outer;
        let e; try { e = JSON.parse(lines[i]); } catch (err) { continue; }
        if (!e.playerName) continue;
        const t = new Date(e.timestamp).getTime();
        if (cutoff && (isNaN(t) || t < cutoff)) continue;
        let p = profiles.get(e.playerName);
        if (!p) {
          p = { name: e.playerName, count: 0, firstSeen: t, lastSeen: t, spots: {}, dirs: {}, gear: {}, hours: new Array(24).fill(0), maxSpeed: 0, maxDist: 0, lastCoords: null, lastDimension: null, watched: watch.has(e.playerName.toLowerCase()) };
          profiles.set(e.playerName, p);
        }
        // One pass = one enter + one exit. Count only the EXIT as a "sighting" so a
        // single fly-by isn't double-counted (the enter is the live map ping).
        const isExit = !!e.direction && e.direction !== 'Entering';
        if (isExit) p.count++;
        if (t < p.firstSeen) p.firstSeen = t;
        if (t >= p.lastSeen) { p.lastSeen = t; p.lastCoords = e.coords || p.lastCoords; p.lastDimension = e.dimension || p.lastDimension; }
        if (e.spotId) p.spots[e.spotId] = (p.spots[e.spotId] || 0) + 1;
        if (isExit && e.direction !== 'Unknown') p.dirs[e.direction] = (p.dirs[e.direction] || 0) + 1;
        if (e.equipment) {
          // Collect the set of item NAMES seen. Enchantments are intentionally ignored:
          // captured enchant data off other players' entities was unreliable (every piece
          // read as "Protection I"), so the system was removed — see PlayerMonitor
          // _getEquipment. Old JSONL entries may still carry an `enchants` array; we don't
          // read it, so that stale bad data never resurfaces on the board.
          for (const v of Object.values(e.equipment)) {
            const item = (typeof v === 'string') ? v : (v && v.item);
            if (!item) continue;
            p.gear[item] = true; // used as a set of item names (only the keys are read)
          }
        }
        if (typeof e.speed === 'number' && e.speed > p.maxSpeed) p.maxSpeed = e.speed;
        // Farthest sighting from spawn, NETHER-normalized (overworld coords /8), for the
        // wealth remoteness signal. Skip the End (queue-room coords are garbage).
        if (e.coords && Number.isFinite(e.coords.x) && Number.isFinite(e.coords.z)) {
          const dimc = String(e.dimension || '');
          if (!dimc.includes('end')) {
            const div = dimc.includes('nether') ? 1 : 8; // overworld is 8× the nether scale
            const d = Math.hypot(e.coords.x, e.coords.z) / div;
            if (d > p.maxDist) p.maxDist = d;
          }
        }
        if (isExit && !isNaN(t)) p.hours[new Date(t).getHours()]++;
      }
    }

    const survivors = [...profiles.values()].filter(p => p.count > 0);
    // Synchronously read whatever the estimator has cached for these players (api.2b2t.vc
    // stats, prio, bot flag). peek() NEVER awaits or fetches — a slow/failed API can't
    // block or break the profile board; missing entries just fall back to gear-only.
    const peekMap = wealth.peek(survivors.map(p => p.name));
    const out = survivors.map(p => {
      const dirEntries = Object.entries(p.dirs).sort((a, b) => b[1] - a[1]);
      const gearNames = Object.keys(p.gear);
      const gearPoints = gearWealthPoints(gearNames);
      // Per-profile guard: a wealth failure for one player must never abort the whole
      // board. On any error, fall back to a gear-only estimate (apiStats null).
      const raw = peekMap.get(p.name.toLowerCase());
      const st = raw && raw.apiStats;
      let w;
      try {
        w = computeWealth({ apiStats: st || null, prio: raw ? (raw.prio ?? null) : null, isBot: !!(raw && raw.isBot), gearPoints, maxDistance: p.maxDist, now: Date.now() }, config.wealth);
      } catch (e) {
        w = computeWealth({ apiStats: null, prio: null, isBot: false, gearPoints, maxDistance: p.maxDist, now: Date.now() }, config.wealth);
      }
      // Raw api.2b2t.vc values surfaced so the operator can read them directly (the
      // wealth bars only show the normalised 0–1). null when the API hasn't answered
      // yet; playtime/kills/deaths are 0 for legacy accounts (backfilled from tracking
      // start only) — that's real data, shown as-is with a hint on the frontend.
      const api = st ? {
        firstSeen: st.firstSeen || null,
        playtimeHours: Number.isFinite(st.playtimeSeconds) ? Math.round(st.playtimeSeconds / 3600) : null,
        playtimeMonthHours: Number.isFinite(st.playtimeSecondsMonth) ? Math.round(st.playtimeSecondsMonth / 3600) : null,
        joinCount: Number.isFinite(st.joinCount) ? st.joinCount : null,
        chats: Number.isFinite(st.chatsCount) ? st.chatsCount : (Number.isFinite(st.chatCount) ? st.chatCount : null),
        kills: Number.isFinite(st.killCount) ? st.killCount : null,
        deaths: Number.isFinite(st.deathCount) ? st.deathCount : null,
      } : null;
      return {
        name: p.name, count: p.count, firstSeen: p.firstSeen, lastSeen: p.lastSeen,
        spots: Object.keys(p.spots), spotCount: Object.keys(p.spots).length,
        topDirection: dirEntries.length ? dirEntries[0][0] : null, directions: p.dirs,
        gear: gearNames.map(item => ({ item })), // names only — enchant capture removed (was unreliable)
        wealth: w.label, wealthScore: w.score, wealthSource: w.source,
        wealthConfidence: w.confidence, wealthComponents: w.components,
        gearWealth: gearWealthLabel(gearPoints), gearWealthScore: gearPoints,
        api, prio: raw ? (raw.prio ?? null) : null, bot: !!(raw && raw.isBot),
        maxDistance: Math.round(p.maxDist),
        maxSpeed: Math.round(p.maxSpeed * 10) / 10, hours: p.hours,
        lastCoords: p.lastCoords, lastDimension: p.lastDimension, watched: p.watched,
      };
    });
    // 'wealth' sort: highest score first, NULLS LAST (unscored profiles sink), tiebreak
    // by sighting count desc. 'count' and 'recent' unchanged.
    out.sort((a, b) => {
      if (sort === 'count') return b.count - a.count;
      if (sort === 'wealth') {
        const as = a.wealthScore, bs = b.wealthScore;
        if (as == null && bs == null) return b.count - a.count;
        if (as == null) return 1;   // a sinks
        if (bs == null) return -1;  // b sinks
        return (bs - as) || (b.count - a.count);
      }
      return b.lastSeen - a.lastSeen;
    });
    return out.slice(0, Math.max(1, Math.min(2000, limit)));
  }

  // ── Cartography (Xaero World Map stash-hunting board) ──────

  _cartographyFile(dim) {
    const safe = String(dim || 'nether').replace(/[^a-z]/gi, '') || 'nether';
    return path.join(path.resolve('./data/cartography'), `${safe}.json`);
  }
  _loadCartography(dim) {
    // Cache the parsed store per dimension so we don't readFileSync + JSON.parse the
    // multi-MB overworld.json on every /api/cartography request (it blocks the shared
    // loop). Invalidated on write (ingestCartography). Keyed by the resolved file path.
    const file = this._cartographyFile(dim);
    const cached = this._cartographyCache.get(file);
    if (cached) return cached;
    let store;
    try {
      store = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (e) {
      // Only cache the empty default when the file is genuinely absent (ENOENT). A transient
      // read/parse failure (EMFILE, a torn read) must NOT be cached — otherwise the empty store
      // sticks for the whole process lifetime and a later ingestCartography would merge onto it
      // and atomically overwrite the real 2.3 MB file. Return empty, uncached, and retry next call.
      if (e.code !== 'ENOENT') return { regions: {}, updatedAt: 0 };
      store = { regions: {}, updatedAt: 0 };
    }
    this._cartographyCache.set(file, store);
    return store;
  }

  /** Merge decoded Xaero regions into storage (newest-wins per region), so the map
   *  builds up across uploads. `regions` = output of XaeroDecoder.processUpload. */
  ingestCartography(dim, regions) {
    const dir = path.resolve('./data/cartography');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const store = this._loadCartography(dim);
    let added = 0, updated = 0, flagged = 0;
    const now = Date.now();
    for (const r of (regions || [])) {
      const key = `${r.x}_${r.z}`;
      if (store.regions[key]) updated++; else added++;
      store.regions[key] = { x: r.x, z: r.z, signals: r.signals || [], chunks: r.chunks || [], blocks: r.blocks || 0, updatedAt: now };
      if ((r.signals || []).length) flagged++;
    }
    store.updatedAt = now;
    const file = this._cartographyFile(dim);
    writeJsonAtomic(file, store, { spaces: 0 }); // compact, like the original (2.3MB overworld)
    this._cartographyCache.set(file, store); // keep the cache in sync with what we just wrote
    systemLogger.info(`Cartography(${dim}): +${added} new, ${updated} updated, ${flagged} base-signal regions`);
    this._broadcastDashboard({ type: 'cartography_updated', dim });
    return { added, updated, flagged, total: Object.keys(store.regions).length };
  }

  /** Cartography view data: explored regions, ranked base candidates, and our logged
   *  highway sightings in the same dimension to overlay on the board. */
  async getCartography(dim = 'nether') {
    const store = this._loadCartography(dim);
    const regions = Object.values(store.regions);
    // Candidates are CHUNK-level when we have pinpoint data (blockX/blockZ = the exact
    // 16×16 chunk corner, in this dimension's coords), else region-level (512²) as a
    // fallback. The frontend converts to the other dimension per `dim`.
    const candidates = [];
    for (const r of regions) {
      const chunks = r.chunks || [];
      if (chunks.length) {
        for (const c of chunks) {
          const bx = r.x * 512 + c.cx * 16, bz = r.z * 512 + c.cz * 16;
          candidates.push({ blockX: bx, blockZ: bz, signals: c.signals, level: 'chunk', dist: (Math.abs(bx) + Math.abs(bz)) / 512, strength: this._signalStrength(c.signals) });
        }
      } else if (r.signals && r.signals.length) {
        const bx = r.x * 512, bz = r.z * 512;
        candidates.push({ blockX: bx, blockZ: bz, signals: r.signals, level: 'region', dist: (Math.abs(bx) + Math.abs(bz)) / 512, strength: this._signalStrength(r.signals) });
      }
    }
    candidates.sort((a, b) => b.strength - a.strength || b.dist - a.dist);
    const candidateTotal = candidates.length;
    // Overlay: our recent sightings in this dimension (deduped to a coarse grid).
    const dimKey = { nether: 'the_nether', overworld: 'overworld', end: 'the_end' }[dim] || 'the_nether';
    const sightings = [];
    try {
      const acts = await this.getRecentActivity(2000, '7d');
      const seen = new Set();
      for (const a of acts) {
        if (!a.coords || !a.dimension || !a.dimension.includes(dimKey)) continue;
        const k = `${a.playerName}|${Math.round(a.coords.x / 128)}|${Math.round(a.coords.z / 128)}`;
        if (seen.has(k)) continue; seen.add(k);
        sightings.push({ x: Math.round(a.coords.x), z: Math.round(a.coords.z), player: a.playerName, ts: a.timestamp });
        if (sightings.length >= 600) break;
      }
    } catch (e) { /* sightings optional */ }
    // Project regions to just {x,z} — the frontend only draws the explored-region grid
    // from x/z, so shipping the full per-region records (signals/chunks/blocks) would
    // bloat the response with data the browser never reads.
    const regionsOut = regions.map(r => ({ x: r.x, z: r.z }));
    return { dim, regionSize: 512, regions: regionsOut, candidates: candidates.slice(0, 3000), candidateTotal, sightings, updatedAt: store.updatedAt };
  }

  /** Score a flagged region by its signal blocks — strong base/stash indicators
   *  (shulkers, ender chests, beacons…) weigh more than incidental ones (crafting
   *  table, glass). Lets the dashboard surface real bases over one-off placements. */
  _signalStrength(signals) {
    const STRONG = /shulker_box|ender_chest|beacon|reinforced_deepslate|respawn_anchor|conduit|enchanting_table|glazed|smithing_table/;
    const WEAK = /crafting_table|_glass|_carpet|chain|lantern|scaffolding|candle|sea_lantern|target/;
    let s = 0;
    for (const x of (signals || [])) s += STRONG.test(x) ? 5 : WEAK.test(x) ? 1 : 3;
    return s;
  }

  /** Generate a Xaero waypoints file from a dimension's base candidates, so the user
   *  can import it and fly straight to each. Points at each region's centre; strongest
   *  first. Format mirrors Xaero's mw$default_N.txt. */
  getCartographyWaypoints(dim = 'nether', { min = 0, signal = '' } = {}) {
    const store = this._loadCartography(dim);
    const y = dim === 'nether' ? 80 : 64;
    const cands = [];
    for (const r of Object.values(store.regions)) {
      const chunks = r.chunks || [];
      if (chunks.length) {
        for (const c of chunks) cands.push({ bx: r.x * 512 + c.cx * 16 + 8, bz: r.z * 512 + c.cz * 16 + 8, signals: c.signals, strength: this._signalStrength(c.signals) });
      } else if (r.signals && r.signals.length) {
        cands.push({ bx: r.x * 512 + 256, bz: r.z * 512 + 256, signals: r.signals, strength: this._signalStrength(r.signals) });
      }
    }
    const sel = cands.filter(c => c.strength >= min && (!signal || c.signals.some(s => s.includes(signal)))).sort((a, b) => b.strength - a.strength).slice(0, 2000);
    const lines = ['#', '#waypoint:name:initials:x:y:z:color:disabled:type:set:rotate_on_tp:tp_yaw:visibility_type:destination', '#'];
    for (const c of sel) {
      const tag = c.signals.slice(0, 3).join(',').replace(/[:]/g, '');
      const name = `Stash ${c.bx},${c.bz} [${tag}]`.replace(/[:\n]/g, ' ');
      lines.push(`waypoint:${name}:📦:${c.bx}:${y}:${c.bz}:6:false:0:gui.xaero_default:false:0:0:false`);
    }
    return { count: sel.length, text: lines.join('\n') + '\n' };
  }

  /** Get recent activity log entries based on time range */
  async getRecentActivity(limit = 50, range = 'all') {
    const fsp = fs.promises;
    const activityDir = path.resolve(config.logging.activityDir);
    if (!fs.existsSync(activityDir)) return [];

    let cutoffTime = 0;
    const now = Date.now();
    if (range === '1h') cutoffTime = now - 60 * 60 * 1000;
    else if (range === '24h') cutoffTime = now - 24 * 60 * 60 * 1000;
    else if (range === '7d') cutoffTime = now - 7 * 24 * 60 * 60 * 1000;

    if (range === 'all' && limit < 5000) limit = 5000; // Cap to 5000 max for all time

    // Sort by the DATE in the filename (<key>_YYYY-MM-DD.jsonl), newest first —
    // not the whole name, which would skew toward whichever account/IGN sorts last.
    const dateOf = f => (f.match(/_(\d{4}-\d{2}-\d{2})\.jsonl$/) || [])[1] || '';
    let files;
    try {
      files = (await fsp.readdir(activityDir))
        .filter(f => f.endsWith('.jsonl'))
        .sort((a, b) => dateOf(b).localeCompare(dateOf(a)) || b.localeCompare(a));
    } catch (e) {
      return [];
    }

    // Files are date-sorted newest-first, so once we hit one whose DAY is entirely
    // before the cutoff, every remaining file is older too — stop. Without this a
    // sparse range would read every activity file ever (retention=0 keeps forever).
    const cutoffDate = cutoffTime > 0 ? new Date(cutoffTime).toISOString().slice(0, 10) : '';
    const entries = [];
    for (const file of files) {
      if (entries.length >= limit) break;
      if (cutoffDate) { const fd = dateOf(file); if (fd && fd < cutoffDate) break; }
      try {
        // Async read so a large activity file never blocks the event loop
        // (which would freeze entity scanning and pathfinding for all bots).
        const raw = await fsp.readFile(path.join(activityDir, file), 'utf-8');
        const lines = raw.split('\n').filter(l => l.trim());
        for (const line of lines.reverse()) {
          if (entries.length >= limit) break;
          try {
            const entry = JSON.parse(line);
            if (cutoffTime > 0) {
               const entryTime = new Date(entry.timestamp).getTime();
               if (entryTime < cutoffTime) continue; // Skip older entries
            }
            entries.push(entry);
          } catch (e) { /* skip bad lines */ }
        }
      } catch (e) { /* skip bad files */ }
    }

    // Return globally NEWEST-first by timestamp. Files are read per-bot (date-desc),
    // so without this the array is grouped by bot, not time-ordered — which pushed a
    // recent sighting from one bot past the dashboard feed's 30-item cap (it showed on
    // the map, which draws them all, but not in the feed). Sorting here fixes every
    // consumer (feed, map, cartography overlay) at once.
    entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return entries;
  }

  /**
   * Delete stored activity. Options:
   *   { spot }        — only that spot's files
   *   { beforeDays }  — only files older than N days (by mtime)
   *   (none)          — everything
   * Also resets the in-memory activity summary accordingly.
   */
  async clearActivity(opts = {}) {
    const dir = path.resolve(config.logging.activityDir);
    let removed = 0;
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        if (opts.spot && !f.startsWith(`${opts.spot}_`)) continue;
        if (opts.beforeDays) {
          const ageMs = Date.now() - fs.statSync(path.join(dir, f)).mtimeMs;
          if (ageMs < opts.beforeDays * 86400000) continue;
        }
        try { fs.unlinkSync(path.join(dir, f)); removed++; } catch (e) { /* ignore */ }
      }
    }
    // Only wipe the summary when clearing everything or a whole spot (not a
    // time-range prune, which leaves recent data for that spot intact).
    if (!opts.beforeDays) state.clearActivitySummary(opts.spot);
    systemLogger.info(`Cleared activity: ${removed} file(s)${opts.spot ? ` for ${opts.spot}` : ''}`);
    this._broadcastDashboard({ type: 'activity_cleared', spot: opts.spot || null });
    return removed;
  }

  /**
   * Delete specific activity entries (used by the map's click-to-delete).
   * Each entry is matched by spotId + timestamp + playerName; the relevant
   * day's .jsonl file is rewritten without the matching lines.
   * @param {Array<{spotId,timestamp,playerName}>} entries
   */
  async deleteActivityEntries(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return 0;
    const dir = path.resolve(config.logging.activityDir);
    const keys = new Set();
    const files = new Set();
    for (const e of entries) {
      if (!e || !e.spotId || !e.timestamp) continue;
      keys.add(`${e.spotId}|${e.timestamp}|${e.playerName || ''}`);
      files.add(`${e.spotId}_${String(e.timestamp).slice(0, 10)}.jsonl`);
    }
    let removed = 0;
    for (const fname of files) {
      const fp = path.join(dir, fname);
      if (!fs.existsSync(fp)) continue;
      const lines = fs.readFileSync(fp, 'utf-8').split('\n').filter(l => l.trim());
      const kept = [];
      for (const line of lines) {
        try {
          const o = JSON.parse(line);
          if (keys.has(`${o.spotId}|${o.timestamp}|${o.playerName || ''}`)) { removed++; continue; }
        } catch (e) { /* keep unparseable lines */ }
        kept.push(line);
      }
      // Atomic rewrite: a crash mid-write here would truncate a whole day of sightings
      // for that spot, not just the entries being deleted.
      if (kept.length) writeFileAtomic(fp, kept.join('\n') + '\n');
      else { try { fs.unlinkSync(fp); } catch (e) {} }
    }
    systemLogger.info(`Deleted ${removed} activity entr${removed === 1 ? 'y' : 'ies'}`);
    this._broadcastDashboard({ type: 'activity_cleared' });
    return removed;
  }
}

// ── Main ───────────────────────────────────────────────────

// Crash-resistance: a stray async error (e.g. in a poller callback) must NOT take
// the app down. The ZenithProxy bots are decoupled (separate tmux sessions) so they
// survive regardless, but keeping the app alive preserves the dashboard, the monitor,
// and Discord notifications. Log and continue rather than exit.
process.on('unhandledRejection', (err) => {
  systemLogger.error('Unhandled promise rejection:', (err && err.stack) || err);
});
process.on('uncaughtException', (err) => {
  systemLogger.error('Uncaught exception (continuing):', (err && err.stack) || err);
});

const orchestrator = new Orchestrator();
orchestrator.start().catch((err) => {
  systemLogger.error('Fatal error:', err.message);
  process.exit(1);
});

module.exports = orchestrator;