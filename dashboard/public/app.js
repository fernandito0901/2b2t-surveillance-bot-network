/**
 * dashboard/public/app.js — Client-side dashboard logic.
 * Manages WebSocket connection, map rendering, bot cards, and activity feed.
 */

// ── State ──────────────────────────────────────────────────
let ws = null;
let systemStatus = null;
let recentActivity = [];
let intelProfiles = [];      // cached player profiles for the Intel tab
let intelTargetsOnly = false; // Intel: show only likely-rich targets (High/Medium wealth)
let _metricsTimer = null;    // auto-refresh interval while the Metrics tab is open
let mapScale = 0.01; // pixels per nether block
let mapOffsetX = 0;
let mapOffsetY = 0;
let isDragging = false;
let mapDimension = 'nether'; // 'nether' or 'overworld'
let mapHeat = true;          // sighting-density heatmap layer
let mapRadar = localStorage.getItem('mapRadar') !== 'off'; // radar-sweep layer (persisted preference)
let dragStart = { x: 0, y: 0 };
let _mapRafPending = false;
let _didInitialFit = false; // frame spawn + bases once on first data load
let _userMovedMap = false;  // once the operator pans/zooms, stop auto-framing on data updates

// ── Connection health (reconnect UX) ──
let wsAlive = false;          // true only while the socket is OPEN
let wsBackoff = 1000;         // capped exponential reconnect delay (ms)
let _staleTimer = null;       // fires after a grace period to badge panels STALE
let _lastDataAt = 0;          // ts of the last live WS message (freshness badge)
const WS_BACKOFF_MAX = 30000;
let _wsConnectedBefore = false; // becomes true after the first connect → onopen re-syncs on RECONNECT
let _activitySig = '';        // signature of the last rendered feed, so the 30s backstop poll only
                              // re-renders when the data actually changed (no needless DOM churn)

// ── Overview queue block ──
let _queueMetrics = null;         // cached /api/metrics payload (queue series + drop events)
let _queueMetricsAt = 0;          // last successful metrics fetch (ms)
let _queueMetricsInflight = false;

// ── Live-ping pulse animation ──
let _pulseRAF = null;         // continuous rAF while the map wants animation
let _pulseLast = 0;
let _hasActivePings = false;
let _mapAnimate = false;      // true while anything on the map animates (pings, radar sweep, breathing ghosts)

// ── Time scrubber (map replay) ──
// While scrubbing, the sighting layer renders against a VIRTUAL clock (scrubT) instead
// of Date.now(): entries after scrubT are hidden, recency fading is relative to scrubT,
// and an enter with no (yet-visible) exit replays as a live "Active" contact — so
// dragging through the night shows the traffic exactly as it unfolded. The fleet layer
// (bots/radar/ghosts) intentionally stays live: the scrubber answers "what passed
// here?", not "where were my bots?" (bot positions aren't stored historically).
let scrubActive = false;      // true while the operator has scrubbed off the live edge
let scrubT = 0;               // the virtual "now" (ms epoch) while scrubbing
let scrubPlaying = false;     // ▶ sweep in progress
let _scrubTimer = null;       // the playback interval handle
const SCRUB_SWEEP_MS = 45000; // a full range sweep takes ~45s of wall time

/** The map's clock: the scrub position while replaying, else real time. */
function mapNow() { return scrubActive ? scrubT : Date.now(); }

// Map zoom bounds (pixels-per-block = mapScale * 100). The minimum is low
// enough to fit the entire ±3.75M nether / ±30M overworld border on screen.
const MIN_SCALE = 0.0000001; // 1e-7
const MAX_SCALE = 0.1;

// Current logged-in user { username, role }, loaded from /api/me at startup.
let currentUser = null;
const ROLE_LEVEL = { viewer: 0, trusted: 1, admin: 2, owner: 3 };
/** True if the logged-in user's role is at least `level` (1=trusted, 2=admin, 3=owner). */
function can(level) { return !!currentUser && (ROLE_LEVEL[currentUser.role] || 0) >= level; }
/** True only for the owner — gates owner-exclusive UI (login IPs, granting owner). */
function isOwner() { return !!currentUser && currentUser.role === 'owner'; }

/** fetch() that carries the session cookie and bounces to the login page on 401. */
async function apiFetch(url, options = {}) {
  const res = await fetch(url, Object.assign({ credentials: 'same-origin' }, options));
  if (res.status === 401) { location.href = '/login.html'; throw new Error('Not authenticated'); }
  return res;
}

// Highway definitions (mirrors config.js)
const HIGHWAYS = {
  '+X':   { vector: { x: 1, z: 0 }, label: 'East (+X)' },
  '-X':   { vector: { x: -1, z: 0 }, label: 'West (-X)' },
  '+Z':   { vector: { x: 0, z: 1 }, label: 'South (+Z)' },
  '-Z':   { vector: { x: 0, z: -1 }, label: 'North (-Z)' },
  '+X+Z': { vector: { x: 1, z: 1 }, label: 'SE (+X+Z)' },
  '+X-Z': { vector: { x: 1, z: -1 }, label: 'NE (+X-Z)' },
  '-X+Z': { vector: { x: -1, z: 1 }, label: 'SW (-X+Z)' },
  '-X-Z': { vector: { x: -1, z: -1 }, label: 'NW (-X-Z)' },
};

// ── Init ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Require a session — bounce to the login page if not authenticated.
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (!res.ok) { location.href = '/login.html'; return; }
    currentUser = await res.json();
  } catch (e) { location.href = '/login.html'; return; }
  applyRoleUI();

  connectWebSocket();
  setupMap();
  setupControls();
  setupScrubber();
  fetchInitialData();

  // Periodic refresh
  setInterval(() => {
    updateUptime();
    updateFreshBadge();
  }, 1000);

  // Activity backstop: live 'player_detected' WS events are the primary, instant path;
  // this 30s poll only catches the rare gap (a broadcast dropped on a still-open socket)
  // and no-ops when nothing changed. Reconnects re-sync immediately via ws.onopen.
  setInterval(() => { if (wsAlive) fetchActivity({ quiet: true }); }, 30000);

  document.getElementById('time-filter').addEventListener('change', fetchActivity);
});

/** Show the user chip + toggle admin/trusted-only elements by role. */
function applyRoleUI() {
  const chip = document.getElementById('user-chip');
  if (chip && currentUser) chip.textContent = `${currentUser.username} · ${currentUser.role}`;
  document.querySelectorAll('[data-role="admin"]').forEach(el => { el.style.display = can(2) ? '' : 'none'; });
  document.querySelectorAll('[data-role="trusted"]').forEach(el => { el.style.display = can(1) ? '' : 'none'; });
  const kpi = document.getElementById('kpi-strip'); // Overview KPI strip: trusted+ only (bot counts)
  if (kpi) kpi.style.display = can(1) ? '' : 'none';
}

async function logout() {
  try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) {}
  location.href = '/login.html';
}

// ── WebSocket ──────────────────────────────────────────────
function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`); // session cookie authenticates the WS

  ws.onopen = () => {
    wsAlive = true;
    wsBackoff = 1000;                       // reset backoff on a healthy connect
    clearTimeout(_staleTimer);
    setPanelsStale(false);                  // fresh data — clear the STALE badge/dimming
    const indicator = document.getElementById('ws-status');
    indicator.classList.remove('reconnecting');
    indicator.classList.add('connected');
    indicator.querySelector('.label').textContent = 'Connected';
    // Re-sync the activity feed on every RECONNECT: live 'player_detected' events keep
    // it real-time while connected, but anything logged during the outage would be
    // missed. (The first connect is already covered by fetchInitialData.)
    if (_wsConnectedBefore) fetchActivity();
    _wsConnectedBefore = true;
  };

  ws.onclose = (e) => {
    wsAlive = false;                        // freezes updateUptime (no more fake ticking)
    const indicator = document.getElementById('ws-status');
    indicator.classList.remove('connected');
    indicator.classList.add('reconnecting');
    indicator.querySelector('.label').textContent = 'Reconnecting…';
    if (e && e.code === 1008) { location.href = '/login.html'; return; } // session invalid
    // After a short grace period, mark every panel STALE so the operator can't act
    // on a hours-old snapshot as if it were live.
    clearTimeout(_staleTimer);
    _staleTimer = setTimeout(() => setPanelsStale(true), 4000);
    // Capped exponential backoff instead of a flat 3s retry.
    setTimeout(connectWebSocket, wsBackoff);
    wsBackoff = Math.min(wsBackoff * 2, WS_BACKOFF_MAX);
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleWSMessage(data);
    } catch (e) {
      console.error('WS parse error:', e);
    }
  };

  ws.onerror = () => {
    ws.close();
  };
}

/** Dim + badge all panels as STALE (or clear it) while the socket is down. */
function setPanelsStale(on) {
  document.body.classList.toggle('ws-stale', !!on);
}

function handleWSMessage(data) {
  _lastDataAt = Date.now();   // any live message = fresh data (drives the freshness badge)
  switch (data.type) {
    // 'status' = the poller's per-tick push (~15s): queue positions, drops, and state
    // changes render live instead of waiting for a manual refresh. 'initial' is the
    // same snapshot sent on (re)connect.
    case 'initial':
    case 'status':
      applyStatus(data.data);
      break;

    case 'bot_launched':
    case 'bot_status':
      fetchStatus();
      break;

    case 'player_detected':
      addActivityItem(data);
      renderMap();
      break;

    case 'device_code':
      showDeviceCode(data);
      break;

    case 'account_added': {
      const el = document.getElementById('add-account-status');
      if (el) el.innerHTML = `<span style="color:#22c55e">✅ Added <b>${escapeHtml(data.ign)}</b></span>`;
      fetchStatus();
      break;
    }

    // Keep OTHER open dashboards in sync: the acting client already refetches after
    // its own request, but without these the change never reached anyone else's tab.
    case 'placed_changed':
    case 'account_deleted':
    case 'settings_changed':
      fetchStatus();
      break;
    case 'activity_cleared':
      fetchActivity();
      break;

    default:
      // Generic update
      if (data.bots || data.groups) {
        systemStatus = data;
        renderBotList();
        renderQueuePanel();
        renderCoverage();
        renderMap();
      }
  }
}

// ── Data ───────────────────────────────────────────────────
async function fetchInitialData() {
  await fetchStatus();
  await fetchActivity();
}

/** Apply a fresh system snapshot to every surface that renders from it. Shared by
 *  the REST fetch and the WS 'initial'/'status' pushes so they can't drift apart. */
function applyStatus(s) {
  systemStatus = s;
  renderBotList();
  renderQueuePanel();
  refreshQueueMetrics();
  renderCoverage();
  populateDelSpot();
  updateKpis();
  // Auto-frame the action on every data update UNTIL the operator takes control (pans /
  // zooms). Activity loads separately from status, so a one-shot fit races the data — this
  // keeps re-framing to the real bots/sightings until the user grabs the map.
  if (!_userMovedMap) fitToContent(); else renderMap();
}

async function fetchStatus() {
  try {
    const res = await apiFetch('/api/status');
    applyStatus(await res.json());
  } catch (e) {
    console.error('Failed to fetch status:', e);
  }
}

/** Fetch the activity feed for the current range. `quiet:true` is the 30s backstop
 *  poll — it skips the re-render (and console noise) when nothing has changed, so it
 *  never causes DOM churn during idle periods. */
async function fetchActivity({ quiet = false } = {}) {
  try {
    const range = document.getElementById('time-filter').value;
    const limit = range === 'all' ? 5000 : 500;
    const res = await apiFetch(`/api/activity?limit=${limit}&range=${range}`);
    const data = await res.json();
    // Signature = newest entry + count. If the backstop poll sees no change, do nothing.
    const sig = data.length + '|' + (data[0] ? data[0].timestamp + '|' + data[0].playerName : '');
    if (quiet && sig === _activitySig) return;
    _activitySig = sig;
    recentActivity = data;
    renderActivityFeed();
    updateKpis();
    if (!_userMovedMap) fitToContent(); else renderMap();
  } catch (e) {
    if (!quiet) console.error('Failed to fetch activity:', e);
  }
}

// ── KPI strip (Overview) ───────────────────────────────────
function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
// Mirrors the backend gear-based wealth score so the strip can flag high-wealth players.
// (The browser can't require() the node scorer lib, so this stays an inline mirror.)
function clientGearWealth(gear) {
  let s = 0;
  for (const g of gear) { const n = String(g).toLowerCase();
    if (n.includes('netherite')) s += 3; else if (n.includes('diamond')) s += 1;
    if (n.includes('elytra')) s += 2; if (n.includes('totem')) s += 2;
    if (n.includes('end_crystal') || n.includes('respawn_anchor') || n.includes('obsidian')) s += 1; }
  return s;
}
function updateKpis() {
  const bots = (systemStatus && systemStatus.bots) || {};
  const vals = Object.values(bots);
  // In-world = the bot's actual game state (from the tmux poller), NOT the monitor's
  // attach state: ZenithProxy lets the spectator monitor stay attached while a bot is
  // still queuing, so `connected` would double-count a queuing bot as in-world too.
  const inworld = vals.filter(b => b.proxyState === 'in_game').length;
  const queuing = vals.filter(b => b.proxyState === 'queuing').length;
  const login = vals.filter(b => b.loginRequired).length;
  const total = Object.keys(bots).length;
  setText('kpi-inworld', inworld);   // legacy ids — no-op if the old strip is gone
  setText('kpi-queue', queuing);
  setText('kpi-bots', total);
  // Fleet-Status hero: the three counts + a one-line verdict.
  setText('hero-inworld', inworld);
  setText('hero-queue', queuing);
  setText('hero-offline', Math.max(0, total - inworld - queuing));
  const verdict = document.getElementById('hero-verdict');
  if (verdict) {
    verdict.classList.remove('warn', 'good');
    if (!total) verdict.textContent = 'No accounts configured';
    else if (login) { verdict.textContent = `⚠ ${login} account${login === 1 ? ' needs' : 's need'} login — see Bot Status`; verdict.classList.add('warn'); }
    else if (inworld === total) { verdict.textContent = 'Full coverage — every bot on station'; verdict.classList.add('good'); }
    else if (inworld > 0) verdict.textContent = `${inworld} on station · ${queuing} in queue${_heroNearestEta()}`;
    else if (queuing > 0) verdict.textContent = `All queuing — non-priority is slow${_heroNearestEta()}`;
    // idle/starting = the proxy is up and connecting — that's startup, not an outage.
    else if (vals.some(b => b.proxyState === 'idle' || b.proxyState === 'starting')) verdict.textContent = 'Fleet connecting…';
    else { verdict.textContent = 'Fleet offline — check the VPS'; verdict.classList.add('warn'); }
  }
  // Keep the "Seen" KPI label honest with the selected time range (it counts
  // recentActivity, which follows the map's time filter — not always 24h).
  const tf = document.getElementById('time-filter');
  const seenLabel = document.querySelector('#kpi-card-seen .kpi-label');
  if (tf && seenLabel) {
    seenLabel.textContent = 'Seen ' + ({ '1h': '1h', '24h': '24h', '7d': '7d', all: 'all time' }[tf.value] || tf.value);
  }
  const seen = new Set(), gearByPlayer = {};
  for (const e of recentActivity) {
    if (!e.playerName) continue;
    seen.add(e.playerName);
    if (e.equipment) { const g = gearByPlayer[e.playerName] || (gearByPlayer[e.playerName] = new Set());
      for (const v of Object.values(e.equipment)) { const it = (typeof v === 'string') ? v : (v && v.item); if (it) g.add(it); } }
  }
  let high = 0;
  for (const g of Object.values(gearByPlayer)) if (clientGearWealth([...g]) >= 8) high++;
  setText('kpi-seen', seen.size);
  setText('kpi-wealth', high);
}

/** " · nearest ETA ~2h 5m" from the queuing bot closest to the front, or ''.
 *  Uses the cached /api/metrics queue series (trusted-only; absent → ''). */
function _heroNearestEta() {
  const bots = (systemStatus && systemStatus.bots) || {};
  let best = null;
  for (const [id, b] of Object.entries(bots)) {
    if (b.proxyState !== 'queuing' || b.queuePosition == null) continue;
    const m = queueMetricsFor(id);
    const eta = m ? queueEtaMs(m.queue, b.queuePosition) : null;
    if (eta != null && (best == null || eta < best)) best = eta;
  }
  return best != null ? ` · nearest ETA ~${fmtDuration(best)}` : '';
}

// ── Overview queue block ───────────────────────────────────
// The map only plots in-world bots, so with the whole fleet queuing the Overview
// is an empty map. This block surfaces the dominant reality: per-bot queue
// position, a derived ETA, the non-priority reminder, and the last drop reason.
// Viewers get a redaction-safe status line only (the server sends them no bot
// data, so there is nothing identifying to render).

/** Lazily (re)load /api/metrics for the queue series + drop reasons. Trusted+ only
 *  — the endpoint is trusted-gated; throttled so the Overview doesn't hammer it. */
function refreshQueueMetrics(force) {
  if (!can(1)) return;
  const now = Date.now();
  if (!force && (_queueMetricsInflight || now - _queueMetricsAt < 15000)) return;
  _queueMetricsInflight = true;
  apiFetch('/api/metrics?range=6h')
    .then(r => r.json())
    .then(d => { _queueMetrics = d; _queueMetricsAt = Date.now(); _queueMetricsInflight = false; renderQueuePanel(); })
    .catch(() => { _queueMetricsInflight = false; });
}

/** Look up the cached metrics account record for a bot id. */
function queueMetricsFor(id) {
  const accts = (_queueMetrics && _queueMetrics.accounts) || [];
  return accts.find(a => a.id === id) || null;
}

/** Derive an ETA (ms until in-world) from the slope of a queue-position series.
 *  Returns null when there aren't enough points or the queue isn't advancing. */
function queueEtaMs(series, curQ) {
  if (!series || series.length < 2 || curQ == null) return null;
  const now = Date.now();
  const windowed = series.filter(p => p.t >= now - 30 * 60 * 1000);
  const use = windowed.length >= 2 ? windowed : series.slice(-6);
  if (use.length < 2) return null;
  const a = use[0], b = use[use.length - 1];
  const dt = b.t - a.t;                 // elapsed ms
  const dq = a.q - b.q;                 // positions advanced (queue counts down)
  if (dt <= 0 || dq <= 0) return null;  // stalled or moving backward → no honest ETA
  const etaMs = curQ / (dq / dt);
  return (isFinite(etaMs) && etaMs > 0) ? etaMs : null;
}

/** "2h 15m" / "45m" / "<1m" */
function fmtDuration(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return '<1m';
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** Most recent drop reason for a bot from the cached metrics events (newest-first). */
function lastDropReason(id) {
  const ev = (_queueMetrics && _queueMetrics.events) || [];
  for (const e of ev) { if (e.id === id && e.type === 'drop') return e.detail || 'dropped'; }
  return null;
}

function renderQueuePanel() {
  const el = document.getElementById('queue-body');
  const head = document.getElementById('queue-head-note');
  if (!el) return;

  // Viewers receive no bot data from the server — render a status-only line so we
  // never surface a redacted field (names/IPs/positions/counts we don't have).
  if (!can(1)) {
    if (head) head.textContent = '';
    el.innerHTML = '<div class="queue-empty">Bots spend most of their time in 2b2t’s regular (non-priority) queue. The map fills in when a bot reaches the world; live player sightings appear as they happen.</div>';
    return;
  }

  const bots = (systemStatus && systemStatus.bots) || {};
  const ids = Object.keys(bots);
  const queuing = ids.filter(id => bots[id].proxyState === 'queuing');
  const inWorld = ids.filter(id => bots[id].proxyState === 'in_game');

  if (head) {
    head.innerHTML = `${queuing.length} in queue · <span style="color:var(--green)">${inWorld.length} in-world</span>`
      + ` <span class="np-badge" title="These alts sit in the free regular queue — priority (paid) would skip ahead">non-priority</span>`;
  }

  if (!ids.length) { el.innerHTML = '<div class="queue-empty">No bots configured yet.</div>'; return; }
  if (!queuing.length) {
    el.innerHTML = inWorld.length
      ? '<div class="queue-empty">All monitored bots are in-world — see them on the map.</div>'
      : '<div class="queue-empty">No bots are queuing right now.</div>';
    return;
  }

  // Sort by closeness to the front (smallest position first); unknown positions last.
  const rank = id => (bots[id].queuePosition != null ? bots[id].queuePosition : Infinity);
  el.innerHTML = queuing.sort((a, b) => rank(a) - rank(b)).map(id => {
    const b = bots[id];
    const name = escapeHtml(b.ign || id);
    const pos = b.queuePosition != null ? `#${b.queuePosition}` : '—';
    const m = queueMetricsFor(id);
    const eta = m ? queueEtaMs(m.queue, b.queuePosition) : null;
    const etaTxt = eta != null ? `~${fmtDuration(eta)} to world` : 'estimating…';
    const drop = lastDropReason(id);
    const dropHtml = drop ? `<div class="q-drop" title="Most recent disconnect reason">last drop: ${escapeHtml(drop)}</div>` : '';
    // Progress through the line: peak observed position (this range) → now. Only
    // rendered once the metrics series exists; a fresh page shows position + ETA only.
    let progHtml = '';
    if (m && m.queue && m.queue.length && b.queuePosition != null) {
      const peak = Math.max(...m.queue.map(p => p.q), b.queuePosition);
      if (peak > 0) {
        const pct = Math.round(Math.max(0, Math.min(1, 1 - b.queuePosition / peak)) * 100);
        progHtml = `<div class="q-bar" title="Progress from peak #${peak}"><div class="q-fill" style="width:${pct}%"></div></div>`;
      }
    }
    return `
      <div class="queue-row">
        <div class="q-pos">${pos}</div>
        <div class="q-main">
          <div class="q-name">${name}</div>
          <div class="q-eta">${etaTxt}</div>
          ${progHtml}
          ${dropHtml}
        </div>
      </div>`;
  }).join('');
}

// ── Bot List ───────────────────────────────────────────────
function renderBotList() {
  const container = document.getElementById('bot-list');
  const countEl = document.getElementById('bot-count');

  if (!systemStatus || !systemStatus.bots) {
    container.innerHTML = '<div class="empty-state">No bots configured</div>';
    countEl.textContent = '0';
    return;
  }

  const bots = systemStatus.bots;
  const botIds = Object.keys(bots);
  countEl.textContent = botIds.length.toString();

  if (botIds.length === 0) {
    container.innerHTML = '<div class="empty-state">No accounts yet. Use “Add Account”.</div>';
    return;
  }

  // Split: actively monitoring (placed + connected) vs needs placing/assistance.
  const active = botIds.filter(id => bots[id].placed && bots[id].connected);
  const needs = botIds.filter(id => !(bots[id].placed && bots[id].connected));

  const label = (t, n) => `<div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;opacity:.5;margin:8px 4px 4px">${t} (${n})</div>`;

  // Monitor / supervisor identity (the shared spectator that watches the alts).
  const mon = (systemStatus && systemStatus.monitor) || {};
  const monText = mon.ign
    ? `${escapeHtml(mon.ign)} · <span style="color:${mon.active ? '#22c55e' : '#6b7280'}">spectating ${mon.active || 0}</span>`
    : `<span style="color:#f59e0b">not configured (set MONITOR_IGN)</span>`;
  let html = `<div style="font-size:11px;opacity:.75;padding:4px 4px 8px;border-bottom:1px solid rgba(255,255,255,.06);margin-bottom:6px">🛰️ Monitor account: ${monText}</div>`;
  if (needs.length) html += label('Needs placing / assistance', needs.length) + needs.map(id => renderBotCard(id, bots[id])).join('');
  if (active.length) html += label('Actively monitoring', active.length) + active.map(id => renderBotCard(id, bots[id])).join('');
  container.innerHTML = html;
}

function renderBotCard(id, bot) {
    const p = bot.lastPosition;
    const name = bot.ign || id; // real Minecraft IGN when known
    const coords = p ? `${p.x}, ${p.y}, ${p.z}${p.dimension ? ` · ${p.dimension.replace('minecraft:', '')}` : ''}` : '';
    let posText, dot;
    if (bot.loginRequired) {
      posText = '⚠️ Login required'; dot = '#ef4444';
    } else if (bot.proxyState === 'queuing') {
      // Check actual proxy state BEFORE the monitor-attached branch: the spectator
      // monitor stays attached while a bot queues, so `connected && p` would otherwise
      // show a queuing bot's stale last position as if it were in-world.
      posText = `In queue${bot.queuePosition != null ? ` · #${bot.queuePosition}` : '…'}`; dot = '#06b6d4';
    } else if (bot.proxyState === 'starting' || bot.proxyState === 'idle') {
      posText = 'Connecting…'; dot = '#f59e0b';
    } else if (bot.connected && p) {
      posText = coords; dot = '#22c55e';
    } else if (bot.proxyState === 'in_game') {
      // In-world via the proxy but no mineflayer monitor feeding position
      // (e.g. you're driving it, or it isn't monitorable yet).
      const at = bot.port ? ` (drive at :${bot.port})` : '';
      posText = p ? `In world · ${coords}` : `In world — drive to spot${at}`; dot = '#22c55e';
    } else if (p) {
      posText = `last seen ${coords}`; dot = '#6b7280';
    } else {
      posText = 'N/A — never joined'; dot = '#6b7280';
    }

    // Place toggle: green "Place" when not placed, amber "Release" when placed.
    const placedBtn = bot.placed
      ? `<button class="btn-warning" onclick="setPlaced('${id}', false)" title="Release slot for manual control">⏏</button>`
      : `<button class="btn-launch" onclick="setPlaced('${id}', true)" title="Mark placed — connect to monitor">📍</button>`;

    // When a login is pending, show a one-click "Sign in" that re-opens the code.
    const signInBtn = bot.loginRequired && bot.deviceCode
      ? `<button class="btn-sm" style="background:#ef4444;color:#fff;border-color:#ef4444" onclick='showDeviceCode(${JSON.stringify({ accountId: id, url: bot.deviceCode.url, code: bot.deviceCode.code })})' title="Show the login code">Sign in</button>`
      : '';
    // Offline (proxy not running) → offer Start.
    const isOffline = !bot.connected && !bot.loginRequired && (!bot.proxyState || bot.proxyState === 'offline');
    const startBtn = isOffline
      ? `<button class="btn-launch" onclick="startBot('${id}')" title="Start this account's proxy (queues it)">▶</button>`
      : '';
    // Connect address = the host serving this dashboard + the account's port.
    const addr = bot.port ? `${location.hostname}:${bot.port}` : null;
    const connectBtn = addr
      ? `<button class="btn-sm" style="background:#6366f1;color:#fff;border-color:#6366f1" onclick="copyConnect(${bot.port}, event)" title="Copy ${addr} — in Minecraft use Direct Connect">🔗</button>`
      : '';

    return `
      <div class="bot-card" data-bot-id="${id}">
        <div class="status-dot" style="background:${dot};box-shadow:0 0 8px ${dot}66"></div>
        <div class="bot-info">
          <div class="bot-name">${escapeHtml(name)}</div>
          <div class="bot-detail">${escapeHtml(posText)}</div>
          ${addr ? `<div class="bot-detail" style="font-family:'JetBrains Mono',monospace;opacity:.5;cursor:pointer" onclick="copyConnect(${bot.port}, event)" title="Click to copy">${addr}</div>` : ''}
        </div>
        <div class="bot-actions">
          ${can(2) ? signInBtn : ''}
          ${can(1) ? startBtn : ''}
          ${connectBtn}
          ${can(1) ? placedBtn : ''}
          ${can(2) ? `<button class="btn-sm" onclick="reloginBot('${id}')" title="Force a fresh Microsoft login (clears the cached token)">🔑</button>` : ''}
          ${can(2) ? `<button class="btn-danger" onclick="deleteBot('${id}')" title="Delete this account from the system">🗑</button>` : ''}
        </div>
      </div>
    `;
}

// Copy a bot's connect address (works on http:// too, where the clipboard API is blocked).
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text); return; }
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.focus(); ta.select();
  try { document.execCommand('copy'); } catch (e) { /* ignore */ }
  document.body.removeChild(ta);
}
function copyConnect(port, ev) {
  const addr = `${location.hostname}:${port}`;
  copyText(addr);
  showToast(`Copied ${addr} — in Minecraft: Multiplayer → Direct Connect → paste`);
  const b = ev && ev.currentTarget;
  if (b && b.tagName === 'BUTTON') { const old = b.innerHTML; b.innerHTML = '✓'; setTimeout(() => { b.innerHTML = old; }, 1300); }
}
function showToast(msg, type) {
  let t = document.getElementById('app-toast');
  if (!t) {
    t = document.createElement('div'); t.id = 'app-toast';
    t.style.cssText = 'position:fixed;bottom:22px;left:50%;transform:translateX(-50%);padding:10px 16px;border-radius:8px;border:1px solid;font-size:13px;z-index:9999;box-shadow:0 6px 20px rgba(0,0,0,.45);transition:opacity .3s;pointer-events:none;max-width:90vw;text-align:center';
    document.body.appendChild(t);
  }
  const err = type === 'error';
  t.style.background = err ? '#3b1518' : '#1e293b';
  t.style.color = err ? '#fecaca' : '#e5e7eb';
  t.style.borderColor = err ? 'rgba(239,68,68,.5)' : 'rgba(255,255,255,.12)';
  t.textContent = (err ? '⚠ ' : '') + msg; t.style.opacity = '1';
  clearTimeout(t._timer); t._timer = setTimeout(() => { t.style.opacity = '0'; }, err ? 4500 : 3200);
}
/** Pull a human message out of an apiFetch response or thrown error. */
async function errMsg(resOrErr) {
  if (resOrErr && typeof resOrErr.json === 'function') { try { const j = await resOrErr.json(); return j.error || j.note || 'Request failed'; } catch (e) { return 'Request failed'; } }
  return (resOrErr && resOrErr.message) || String(resOrErr);
}

async function startBot(id) {
  try {
    const res = await apiFetch(`/api/accounts/${id}/start`, { method: 'POST' });
    const j = await res.json();
    if (j.error) { showToast(j.error, 'error'); return; }
    fetchStatus();
  } catch (e) { showToast(e.message, 'error'); }
}

async function reloginBot(id) {
  if (!confirm('Force a fresh login for this account? It will drop the proxy session and re-run the Microsoft login (a device code will appear here).')) return;
  try {
    const res = await apiFetch(`/api/accounts/${id}/relogin`, { method: 'POST' });
    const j = await res.json();
    if (j.note) showToast(j.note);
    fetchStatus();
  } catch (e) { showToast(e.message, 'error'); }
}

// Fill the activity-delete "by source" dropdown. Activity files are keyed by the
// bot's IGN (acc.username || acc.id), so the options are the bots themselves.
function populateDelSpot() {
  const sel = document.getElementById('del-spot');
  if (!sel || !systemStatus || !systemStatus.bots) return;
  const current = sel.value;
  const keys = Object.entries(systemStatus.bots)
    .map(([id, b]) => (b && b.ign) || id)
    .filter((v, i, a) => v && a.indexOf(v) === i)
    .sort();
  sel.innerHTML = '<option value="">All sources</option>' +
    keys.map(k => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`).join('');
  sel.value = current;
}

// ── Coverage / Groups management ───────────────────────────
function renderCoverage() {
  const container = document.getElementById('coverage-list');
  if (!container) return;
  const groups = (systemStatus && systemStatus.groups) || [];
  const bots = (systemStatus && systemStatus.bots) || {};

  const assigned = new Set();
  groups.forEach(g => (g.accounts || []).forEach(a => assigned.add(a)));
  const unassigned = Object.keys(bots).filter(id => !assigned.has(id));
  const nameOf = id => (bots[id] && bots[id].ign) || id;
  const stateOf = id => {
    const b = bots[id]; if (!b) return 'unknown';
    if (b.connected) return 'monitoring';
    if (b.proxyState) return b.proxyState + (b.queuePosition != null ? ` #${b.queuePosition}` : '');
    return 'offline';
  };

  if (groups.length === 0) {
    container.innerHTML = '<div class="empty-state">No groups. Click “+ New Group”.</div>';
    return;
  }

  container.innerHTML = groups.map(g => {
    const acc = g.accounts || [];
    const inGame = acc.filter(a => bots[a] && bots[a].connected).length;
    const dot = inGame >= (g.desiredOnline || 1) ? '#22c55e' : '#ef4444';
    const members = acc.map(a =>
      `<div class="bot-detail" style="display:flex;justify-content:space-between">
         <span>${escapeHtml(nameOf(a))} — ${escapeHtml(stateOf(a))}</span>
         ${can(1) ? `<span style="cursor:pointer;color:#ef4444" onclick="unassignAccount('${a}')" title="Remove from group">×</span>` : ''}
       </div>`).join('') || '<div class="bot-detail" style="opacity:.5">no accounts assigned</div>';
    const addCtl = (can(1) && unassigned.length)
      ? `<select class="btn-sm" style="font-size:11px;width:100%;margin-top:6px" onchange="assignAccountToGroup('${g.id}', this.value); this.value=''">
           <option value="">+ add account…</option>
           ${unassigned.map(id => `<option value="${id}">${escapeHtml(nameOf(id))}</option>`).join('')}
         </select>` : '';
    return `
      <div class="bot-card" style="flex-direction:column;align-items:stretch">
        <div style="display:flex;align-items:center;gap:8px">
          <div class="status-dot" style="background:${dot}"></div>
          <div class="bot-name" style="flex:1">${escapeHtml(g.name || g.id)}</div>
          <span style="font-size:11px;opacity:.6" title="in-world / coverage target">${inGame}/${g.desiredOnline || 1}</span>
          ${can(1) ? `<span style="cursor:pointer" onclick="editGroup('${g.id}')" title="Edit name / location / coverage target">✏️</span>
          <span style="cursor:pointer;color:#ef4444" onclick="deleteGroup('${g.id}')" title="Delete group">🗑</span>` : ''}
        </div>
        <div style="margin-top:6px">${members}</div>
        ${addCtl}
      </div>
    `;
  }).join('');
}

// Group create/edit uses a small validated modal (replaces the old chained prompt()
// calls that offered no validation and were degraded on mobile).
let _groupModalCtx = null; // { mode: 'new'|'edit', id }

function openGroupModal(mode, group) {
  const modal = document.getElementById('group-modal');
  if (!modal) return;
  _groupModalCtx = { mode, id: group ? group.id : null };
  document.getElementById('group-modal-title').textContent = mode === 'edit' ? 'Edit group' : 'New group';
  document.getElementById('gm-name').value = group ? (group.name || '') : '';
  document.getElementById('gm-x').value = group && group.x != null ? group.x : 0;
  document.getElementById('gm-z').value = group && group.z != null ? group.z : 0;
  document.getElementById('gm-desired').value = group && group.desiredOnline != null ? group.desiredOnline : 1;
  document.getElementById('gm-error').textContent = '';
  modal.classList.remove('hidden');
  const nameEl = document.getElementById('gm-name');
  if (nameEl) nameEl.focus();
}

function closeGroupModal() {
  const modal = document.getElementById('group-modal');
  if (modal) modal.classList.add('hidden');
  _groupModalCtx = null;
}

async function submitGroupModal() {
  if (!_groupModalCtx) return;
  const err = document.getElementById('gm-error');
  const name = document.getElementById('gm-name').value.trim();
  const x = Number(document.getElementById('gm-x').value);
  const z = Number(document.getElementById('gm-z').value);
  const desiredOnline = parseInt(document.getElementById('gm-desired').value, 10);
  if (!name) { err.textContent = 'Enter a name.'; return; }
  if (!Number.isFinite(x) || !Number.isFinite(z)) { err.textContent = 'X and Z must both be numbers.'; return; }
  if (!Number.isFinite(desiredOnline) || desiredOnline < 1) { err.textContent = 'Coverage target must be a whole number ≥ 1.'; return; }
  const body = JSON.stringify({ name, x, z, desiredOnline });
  try {
    if (_groupModalCtx.mode === 'edit') {
      await apiFetch(`/api/groups/${_groupModalCtx.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
    } else {
      await apiFetch('/api/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    }
    closeGroupModal();
    fetchStatus();
  } catch (e) { err.textContent = e.message; }
}

function newGroup() { openGroupModal('new', null); }
function editGroup(groupId) {
  const g = (systemStatus.groups || []).find(x => x.id === groupId);
  if (!g) return;
  openGroupModal('edit', g);
}
async function assignAccountToGroup(groupId, accountId) {
  if (!accountId) return;
  try {
    await apiFetch(`/api/groups/${groupId}/assign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId }) });
    fetchStatus();
  } catch (e) { showToast(e.message, 'error'); }
}
async function unassignAccount(accountId) {
  try { await apiFetch(`/api/accounts/${accountId}/unassign`, { method: 'POST' }); fetchStatus(); }
  catch (e) { showToast(e.message, 'error'); }
}
async function deleteGroup(groupId) {
  if (!confirm('Delete this group? Its accounts become unassigned.')) return;
  try { await apiFetch(`/api/groups/${groupId}`, { method: 'DELETE' }); fetchStatus(); }
  catch (e) { showToast(e.message, 'error'); }
}

// ── Settings ───────────────────────────────────────────────
let whitelistDraft = [];
let watchlistDraft = [];
let proxyWlDraft = [];
async function loadSettings() {
  try {
    const res = await apiFetch('/api/settings');
    const s = await res.json();
    whitelistDraft = (s.whitelist || []).slice();
    watchlistDraft = (s.watchlist || []).slice();
    proxyWlDraft = (s.proxyWhitelist || []).slice();
    document.getElementById('set-webhook').value = s.discordWebhookUrl || '';
    document.getElementById('set-sightings').value = s.sightingAlerts || 'off';
    document.getElementById('set-monitor').value = s.monitorIgn || '';
    document.getElementById('set-owner').value = s.ownerIgn || '';
    document.getElementById('set-retention').value = s.retentionDays || 0;
    renderWhitelist();
    renderWatchlist();
    renderProxyWl();
  } catch (e) { /* ignore */ }
}
function chipRow(items, removeFn) {
  return items.length
    // The value lives in a data-* attribute (a safe HTML-attribute context) and is handled
    // by the delegated listener below — NOT interpolated into an onclick JS string, where an
    // admin value like "');alert(1)//" would break out (the HTML parser decodes &#39; back to
    // ' before the JS engine sees it, so escapeHtml alone can't protect that sink).
    ? items.map(n => `<span class="chip">${escapeHtml(n)}<span class="x" role="button" tabindex="0" data-remove="${removeFn}" data-val="${escapeHtml(n)}" title="Remove">×</span></span>`).join('')
    : '<span class="chip-empty">none yet</span>';
}
function renderWhitelist() {
  const c = document.getElementById('whitelist-items');
  if (c) c.innerHTML = chipRow(whitelistDraft, 'removeWhitelist');
}
function renderWatchlist() {
  const c = document.getElementById('watchlist-items');
  if (c) c.innerHTML = chipRow(watchlistDraft, 'removeWatchlist');
}
function renderProxyWl() {
  const c = document.getElementById('proxywl-items');
  if (c) c.innerHTML = chipRow(proxyWlDraft, 'removeProxyWl');
}
function removeWhitelist(n) { whitelistDraft = whitelistDraft.filter(x => x !== n); renderWhitelist(); }
function removeWatchlist(n) { watchlistDraft = watchlistDraft.filter(x => x !== n); renderWatchlist(); }
function removeProxyWl(n) { proxyWlDraft = proxyWlDraft.filter(x => x !== n); renderProxyWl(); }
// Delegated handler for chip removal — bound once. Reads the value from data-val (never
// from an interpolated JS string), so admin-entered watchlist/whitelist values can't inject.
if (!window.__chipDelegateBound) {
  window.__chipDelegateBound = true;
  const chipRemovers = { removeWhitelist, removeWatchlist, removeProxyWl };
  const runChipRemove = (el) => {
    const fn = el && chipRemovers[el.getAttribute('data-remove')];
    if (fn) fn(el.getAttribute('data-val'));
  };
  document.addEventListener('click', (e) => {
    const x = e.target.closest && e.target.closest('.chip .x[data-remove]');
    if (x) runChipRemove(x);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const x = e.target.closest && e.target.closest('.chip .x[data-remove]');
    if (x) { e.preventDefault(); runChipRemove(x); }
  });
}
async function saveSettings() {
  const body = {
    whitelist: whitelistDraft,
    watchlist: watchlistDraft,
    proxyWhitelist: proxyWlDraft,
    discordWebhookUrl: document.getElementById('set-webhook').value.trim(),
    sightingAlerts: document.getElementById('set-sightings').value,
    monitorIgn: document.getElementById('set-monitor').value.trim(),
    ownerIgn: document.getElementById('set-owner').value.trim(),
    retentionDays: parseInt(document.getElementById('set-retention').value, 10) || 0,
  };
  const st = document.getElementById('settings-status');
  try {
    await apiFetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    st.textContent = '✅ Saved (ignore list, proxy access + webhook live; monitor/retention need a restart)';
    st.style.color = '#22c55e';
    setTimeout(() => { st.textContent = ''; }, 5000);
  } catch (e) { st.textContent = 'Error: ' + e.message; st.style.color = '#ef4444'; }
}

// ── Admin: dashboard user management ───────────────────────
async function loadUsers() {
  try { renderUsers(await (await apiFetch('/api/users')).json()); } catch (e) { /* ignore */ }
}
function timeAgo(ts) {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
// Role → [avatar bg, avatar fg, chip class]. Owner gets its own indigo identity.
const ROLE_STYLE = {
  owner:   ['#241f3a', '#c7b6ff', 'role-owner'],
  admin:   ['#221f3d', '#a89ef0', 'role-admin'],
  trusted: ['#2a2412', '#e7c46a', 'role-trusted'],
  viewer:  ['#16161f', '#9a9ab5', 'role-viewer'],
};
// Which roles the CURRENT user may assign. Only an owner can grant owner; everyone
// managing users (admin+) can assign the lower three.
function assignableRoles() {
  return isOwner() ? ['viewer', 'trusted', 'admin', 'owner'] : ['viewer', 'trusted', 'admin'];
}

function renderUsers(users) {
  const c = document.getElementById('user-list');
  if (!c) return;
  users = users || [];

  // Owner-only helper note + census strip.
  const note = document.getElementById('admin-owner-note');
  if (note) note.innerHTML = isOwner() ? '' : '<span style="color:var(--text-4)">Owner accounts &amp; login IPs are hidden from admins.</span>';
  const ownerOpt = document.querySelector('#newuser-role option[value="owner"]');
  if (ownerOpt) ownerOpt.style.display = isOwner() ? '' : 'none';
  renderAdminStats(users);
  const countEl = document.getElementById('user-count');
  if (countEl) countEl.textContent = String(users.length);

  const initials = n => (String(n || '?').replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase()) || '?';
  const roles = assignableRoles();
  c.innerHTML = users.map(u => {
    const [abg, ac, chip] = ROLE_STYLE[u.role] || ROLE_STYLE.viewer;
    const isMe = u.username === currentUser.username;
    // An admin can't act on owner accounts (they're filtered server-side, but guard
    // the controls too); nobody should delete themselves out of the tab.
    const canManage = isOwner() || u.role !== 'owner';
    // IP history is present only in the owner's payload; admins get a clean row.
    const ips = u.ips || [];
    const hasIpData = 'ips' in u || 'lastLogin' in u;
    const shareFlag = ips.length >= 3;
    const ipList = ips.length
      ? ips.map(x => `<span title="seen ${x.count}× · last ${new Date(x.last).toLocaleString()}">${escapeHtml(x.ip)}<span style="opacity:.5"> ×${x.count}</span></span>`).join(' · ')
      : 'no logins yet';
    const roleControl = canManage
      ? `<select class="input-sm role-select" onchange="setUserRole('${escapeHtml(u.username)}', this.value)" title="Change role" aria-label="Role for ${escapeHtml(u.username)}">
           ${roles.map(r => `<option value="${r}"${r === u.role ? ' selected' : ''}>${r}</option>`).join('')}
         </select>`
      : `<span class="role-badge ${chip}">${u.role}</span>`;
    const actions = canManage
      ? `<button class="btn-icon" onclick="setUserPassword('${escapeHtml(u.username)}')" title="Set a new password">🔑</button>
         <button class="btn-danger" onclick="removeUser('${escapeHtml(u.username)}')" title="Delete user"${isMe ? ' disabled' : ''}>🗑</button>`
      : '';
    // Owner sees the IP-history footer; admins don't get the data, so no empty row.
    const ipFooter = hasIpData
      ? `<div class="admin-ips ${shareFlag ? 'warn' : ''}">
           <span>${shareFlag ? '⚠' : '📍'}</span>
           <span>${ips.length} login IP${ips.length === 1 ? '' : 's'}${shareFlag ? ' — possible account sharing' : ''}${ips.length ? ' · ' + ipList : ''}</span>
         </div>`
      : '';
    return `
    <div class="admin-user">
      <div class="admin-user-top">
        <div class="avatar" style="background:${abg};color:${ac}">${initials(u.username)}</div>
        <div class="bot-info" style="flex:1">
          <div class="bot-name">${escapeHtml(u.username)}${isMe ? ' <span class="you-tag">· you</span>' : ''} <span class="role-badge ${chip}">${u.role}</span></div>
          <div class="bot-detail">${u.lastLogin ? `last login ${timeAgo(u.lastLogin)}${u.lastIp ? ' · ' + escapeHtml(u.lastIp) : ''}` : 'never logged in'}</div>
        </div>
        <div class="admin-user-actions">${roleControl}${actions}</div>
      </div>
      ${ipFooter}
    </div>`;
  }).join('') || '<div class="empty-state">No users</div>';
}

/** Role census tiles above the list — who holds what, at a glance. */
function renderAdminStats(users) {
  const el = document.getElementById('admin-stats');
  if (!el) return;
  const order = isOwner() ? ['owner', 'admin', 'trusted', 'viewer'] : ['admin', 'trusted', 'viewer'];
  const counts = {};
  for (const u of users) counts[u.role] = (counts[u.role] || 0) + 1;
  const plural = { owner: 'owners', admin: 'admins', trusted: 'trusted', viewer: 'viewers' };
  el.innerHTML = order.map(r => {
    const [, ac] = ROLE_STYLE[r];
    const n = counts[r] || 0;
    const label = n === 1 ? r : (plural[r] || r + 's');
    return `<div class="admin-stat"><div class="admin-stat-n" style="color:${ac}">${n}</div><div class="admin-stat-l">${label}</div></div>`;
  }).join('');
}
async function addUserUI() {
  const username = document.getElementById('newuser-name').value.trim();
  const password = document.getElementById('newuser-pass').value;
  const role = document.getElementById('newuser-role').value;
  const st = document.getElementById('user-status');
  try {
    const j = await (await apiFetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, role }) })).json();
    if (j.error) { st.textContent = j.error; st.style.color = '#ef4444'; return; }
    document.getElementById('newuser-name').value = ''; document.getElementById('newuser-pass').value = '';
    st.textContent = `✅ Added ${j.username} (${j.role})`; st.style.color = '#22c55e';
    loadUsers();
  } catch (e) { st.textContent = 'Error: ' + e.message; st.style.color = '#ef4444'; }
}
async function setUserRole(username, role) {
  try { const j = await (await apiFetch(`/api/users/${encodeURIComponent(username)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) })).json(); if (j.error) showToast(j.error, 'error'); }
  catch (e) { showToast(e.message, 'error'); }
  loadUsers();
}
async function setUserPassword(username) {
  const pw = prompt(`New password for "${username}" (min 12 chars):`);
  if (!pw) return;
  try { const j = await (await apiFetch(`/api/users/${encodeURIComponent(username)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) })).json(); showToast(j.error || 'Password updated', j.error ? 'error' : undefined); }
  catch (e) { showToast(e.message, 'error'); }
}
async function removeUser(username) {
  if (!confirm(`Delete user "${username}"?`)) return;
  try { const j = await (await apiFetch(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' })).json(); if (j.error) showToast(j.error, 'error'); }
  catch (e) { showToast(e.message, 'error'); }
  loadUsers();
}

// ── Intel: player intelligence profiles ────────────────────
async function loadIntel() {
  const range = (document.getElementById('intel-range') || {}).value || 'all';
  const sort = (document.getElementById('intel-sort') || {}).value || 'wealth';
  const list = document.getElementById('intel-list');
  if (list && !intelProfiles.length) list.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const res = await apiFetch(`/api/intel?range=${range}&sort=${sort}&limit=500`);
    intelProfiles = await res.json();
    renderIntel();
  } catch (e) { if (list) list.innerHTML = '<div class="empty-state">Failed to load intel</div>'; }
}

function wealthBadge(level) {
  return `<span class="wealth-badge w-${level || 'none'}">${level || 'none'}</span>`;
}

// "netherite_boots" → "Netherite Boots", "totem_of_undying" → "Totem of Undying".
function prettyItem(name) {
  const small = new Set(['of', 'the', 'and', 'a', 'an', 'on', 'in', 'with']);
  return String(name || '').replace(/^minecraft:/, '').split('_')
    .map((w, i) => (i && small.has(w)) ? w : (w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

// Render one gear entry → the item name. Enchantments are no longer shown: capture off
// other players' entities was unreliable (everything read as "Protection I"), so the
// system was removed backend + frontend. Tolerates legacy {item,enchants} shapes.
function fmtGear(g) {
  if (!g) return '';
  return escapeHtml(prettyItem((typeof g === 'string') ? g : g.item));
}

// Compact "gear signature" — the at-a-glance loot cue shown on every collapsed row so you
// can judge whether a player is worth chasing without expanding. Collapses the full gear
// list into a few weighted chips (netherite pieces, diamond, elytra, totem, crystals, and
// an enchant count). p.gear is [{item, enchants:[…]}] (or legacy strings).
function gearSignature(gear) {
  if (!gear || !gear.length) return '<span class="gear-none">no gear seen</span>';
  let neth = 0, dia = 0, ely = false, tot = false, crys = false;
  for (const g of gear) {
    const it = String((g && g.item) || g || '').toLowerCase();
    if (it.includes('netherite')) neth++;
    else if (it.includes('diamond')) dia++;
    if (it.includes('elytra')) ely = true;
    if (it.includes('totem')) tot = true;
    if (it.includes('end_crystal') || it.includes('respawn_anchor')) crys = true;
  }
  const chips = [];
  if (neth) chips.push(`<span class="gear-chip g-neth">⬛ Netherite ×${neth}</span>`);
  if (dia) chips.push(`<span class="gear-chip g-dia">◆ Diamond ×${dia}</span>`);
  if (ely) chips.push(`<span class="gear-chip g-ely">Elytra</span>`);
  if (tot) chips.push(`<span class="gear-chip g-tot">Totem</span>`);
  if (crys) chips.push(`<span class="gear-chip g-crys">Crystals</span>`);
  return chips.length ? chips.join('') : '<span class="gear-none">gear seen</span>';
}

// Account age from an ISO first-tracked date → "11.1 yr (since 2013)".
function fmtAccountAge(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t) || t > Date.now()) return null;
  const yrs = (Date.now() - t) / (365.25 * 24 * 3600 * 1000);
  const year = new Date(t).getUTCFullYear();
  const span = yrs >= 1 ? `${yrs.toFixed(1)} yr` : `${Math.max(1, Math.round(yrs * 12))} mo`;
  return `${span} (since ${year})`;
}

// The raw api.2b2t.vc values, shown as kv rows so the operator can read the numbers the
// wealth bars are derived from. Legacy/OG accounts show playtime/kills 0 (backfilled only
// from 2b2t.vc's tracking start) — labelled so a 0 isn't mistaken for "no data".
function apiStatRows(p) {
  const a = p.api;
  const num = n => (n == null ? null : Number(n).toLocaleString());
  const cell = (k, v) => `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  if (!a) return cell('Account (2b2t.vc)', p.wealthSource === 'pending' ? 'looking up…' : 'no API data');
  const age = fmtAccountAge(a.firstSeen);
  const pt = a.playtimeHours != null
    ? `${num(a.playtimeHours)} h${a.playtimeHours === 0 ? ' <span style="opacity:.6">(pre-tracking)</span>' : ''}${a.playtimeMonthHours != null ? ` · ${num(a.playtimeMonthHours)} h/30d` : ''}`
    : '—';
  const kd = (a.kills != null || a.deaths != null) ? `${num(a.kills || 0)} / ${num(a.deaths || 0)}` : '—';
  const prio = p.prio === true ? 'Yes' : (p.prio === false ? 'No' : 'Unknown');
  return cell('Account age', age || '—')
    + cell('Playtime (tracked)', pt)
    + cell('Sessions (joins)', a.joinCount != null ? num(a.joinCount) : '—')
    + cell('Kills / deaths', kd)
    + cell('Priority queue', prio + (p.bot ? ' · flagged bot' : ''));
}

// Wealth breakdown — the small labeled bars in the detail pane that show WHICH signals
// drove the score (so the estimate isn't a black box) plus its confidence + source.
function wealthBreakdown(p) {
  const c = p.wealthComponents;
  if (!c) return '';
  const rows = [
    ['Gear', c.gear], ['Priority Q', c.prio], ['Account age', c.age], ['Remoteness', c.remote],
    ['Sessions', c.tenure], ['Playtime', c.play], ['Coasting', c.recency], ['K/D', c.kd],
  ].filter(([, v]) => v != null && Number.isFinite(v));
  if (!rows.length) return '';
  const conf = Math.round((p.wealthConfidence || 0) * 100);
  const gated = c.botGate != null && c.botGate < 1;
  const bars = rows.map(([label, v]) => {
    const pct = Math.max(0, Math.min(100, Math.round(v * 100)));
    return `<div class="wbreak-row"><span class="wbreak-k">${label}</span><div class="wbreak-bar"><div class="wbreak-fill" style="width:${pct}%"></div></div><span class="wbreak-v">${pct}</span></div>`;
  }).join('');
  return `<div class="wbreak">
    <div class="wbreak-head"><span>Why this score</span><span>${conf}% confidence · ${escapeHtml(p.wealthSource || 'none')}${gated ? ' · bot/AFK penalty' : ''}</span></div>
    ${bars}
  </div>`;
}

function renderIntel() {
  const list = document.getElementById('intel-list');
  const summary = document.getElementById('intel-summary');
  if (!list) return;
  const q = ((document.getElementById('intel-search') || {}).value || '').trim().toLowerCase();
  let rows = q ? intelProfiles.filter(p => p.name.toLowerCase().includes(q)) : intelProfiles.slice();
  // "Targets only": keep just the likely-rich (High/Medium wealth), hiding Low/none noise.
  if (intelTargetsOnly) rows = rows.filter(p => p.wealth === 'high' || p.wealth === 'medium');
  if (summary) {
    const totalSight = intelProfiles.reduce((a, p) => a + p.count, 0);
    const filtered = q || intelTargetsOnly;
    summary.textContent = `${intelProfiles.length} unique player${intelProfiles.length === 1 ? '' : 's'} · ${totalSight} sightings`
      + (filtered ? ` · showing ${rows.length}${intelTargetsOnly ? ' target' + (rows.length === 1 ? '' : 's') : ' match' + (rows.length === 1 ? '' : 'es')}` : '');
  }
  if (!rows.length) {
    list.innerHTML = `<div class="empty-state">${intelTargetsOnly ? 'No High/Medium-wealth targets in this range.' : 'No players logged yet for this range.'}</div>`;
    return;
  }
  const initials = n => (String(n || '?').replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase()) || '?';
  // Avatar tint keyed by the wealth LABEL (high/medium/low/none), fed by p.wealth.
  const tColor = { high: ['#2a1414', '#f3a0a0'], medium: ['#241e10', '#f0c178'], low: ['#1b2410', '#b3d98a'], none: ['#16161f', '#9a9ab5'] };
  // wealthScore is an ESTIMATE of time+money invested that CORRELATES WITH BUT DOES NOT EQUAL
  // resource/dupe-stash wealth. It misses low-playtime dupers and fresh alts, and can overrate AFK
  // bots unless the bot filter is applied. Also: api.2b2t.vc backfills playtime/kills/deaths only
  // from when it began tracking, so those fields are 0 for legacy/OG accounts — such accounts are
  // scored from joinCount + firstSeen + observed gear and are inherently lower-confidence. Never
  // present wealth as fact; always surface confidence/source.
  list.innerHTML = rows.map((p, i) => {
    const last = timeAgo(p.lastSeen), first = timeAgo(p.firstSeen);
    const dir = p.topDirection ? ` · ${escapeHtml(p.topDirection)}` : '';
    const coords = p.lastCoords ? `${p.lastCoords.x}, ${p.lastCoords.z}` : '?';
    const dim = p.lastDimension ? p.lastDimension.replace('minecraft:', '') : '';
    const dirMix = Object.keys(p.directions || {}).length
      ? Object.entries(p.directions).sort((a, b) => b[1] - a[1]).map(([d, n]) => `${escapeHtml(d)} ×${n}`).join(' · ') : '—';
    const [abg, ac] = tColor[p.wealth] || tColor.none;
    const label = p.wealth || 'none';
    // Low-confidence when the score leans on gear/joins alone (no api.2b2t.vc playtime history).
    const lowConf = p.wealthSource === 'gear' || p.wealthSource === 'pending' || p.wealthSource === 'none';
    const hasScore = p.wealthScore != null;
    const scoreNum = hasScore ? Math.round(p.wealthScore) : null; // round: raw is a long float
    const fillPct = hasScore ? Math.max(2, Math.min(100, scoreNum)) : 0;
    const wealthCol = `
      <div class="wealth-col" title="Estimated wealth ${hasScore ? scoreNum + '/100' : 'unknown'} — likelihood this player is rich / worth investigating. An ESTIMATE, not a fact; expand for the breakdown.">
        <div class="wealth-num ${hasScore ? '' : 'na'}">${hasScore ? (lowConf ? '~' : '') + scoreNum : '—'}<span class="wealth-num-max">/100</span></div>
        <div class="wealth-meter"><div class="wealth-fill w-${label}" style="width:${fillPct}%"></div></div>
        <div class="wealth-tag w-${label}">${label}${lowConf ? ' · est' : ''}</div>
      </div>`;
    return `
      <div class="intel-card" onclick="toggleIntel(${i})">
        <div class="intel-row">
          <div class="avatar" style="background:${abg};color:${ac}">${initials(p.name)}</div>
          <div class="intel-id">
            <div class="intel-name">${p.watched ? '<span title="Watchlisted">👁</span> ' : ''}${escapeHtml(p.name)}</div>
            <div class="intel-meta">${p.count} sighting${p.count === 1 ? '' : 's'} · last ${last}${dir}</div>
            <div class="gear-sig">${gearSignature(p.gear)}</div>
          </div>
          ${wealthCol}
          <span class="chev">▾</span>
        </div>
        <div id="intel-detail-${i}" class="intel-detail" style="display:none">
          ${wealthBreakdown(p)}
          <div class="kv-grid">
            ${apiStatRows(p)}
            <div class="kv"><span class="k">First sighting</span><span class="v">${first}</span></div>
            <div class="kv"><span class="k">Last sighting</span><span class="v">${last}</span></div>
            <div class="kv"><span class="k">Last position</span><span class="v mono">${coords}${dim ? ` · ${dim}` : ''}</span></div>
            <div class="kv"><span class="k">Max speed</span><span class="v">${p.maxSpeed || 0} b/s</span></div>
            <div class="kv full"><span class="k">Seen at</span><span class="v">${p.spots && p.spots.length ? p.spots.map(escapeHtml).join(', ') : '—'}</span></div>
            <div class="kv full"><span class="k">Direction mix</span><span class="v">${dirMix}</span></div>
            <div class="kv full"><span class="k">Gear seen</span><span class="v">${p.gear && p.gear.length ? p.gear.map(fmtGear).join(' · ') : '—'}</span></div>
            <div class="kv full"><span class="k">Active hours (UTC)</span>${hoursBar(p.hours, p.count)}</div>
          </div>
          <div class="intel-actions">
            <button class="btn-sm" onclick="event.stopPropagation(); focusPlayerOnMap(${i})"${p.lastCoords ? '' : ' disabled title="No position logged"'}>📍 Show last position on map</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

// Move the Highway Map camera to a world position: switch to its dimension, frame
// ~±12k blocks around it, and hold the framing (auto-refit stays off). Shared by the
// Intel "show on map" button and the activity feed's click-to-focus.
function focusMapOn(x, z, dimension, name) {
  if (dimension && dimension.includes('end')) {
    showToast('That sighting is in the End (the queue room) — nothing to plot', 'error');
    return;
  }
  mapDimension = (!dimension || dimension.includes('nether')) ? 'nether' : 'overworld';
  const nb = document.getElementById('dim-nether'), ob = document.getElementById('dim-overworld');
  if (nb) nb.classList.toggle('active', mapDimension === 'nether');
  if (ob) ob.classList.toggle('active', mapDimension === 'overworld');
  const canvas = document.getElementById('nether-map');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.width / dpr, ch = canvas.height / dpr;
  const scaleMult = mapDimension === 'overworld' ? 8 : 1;
  const frame = 12000; // nether-block half-span to frame around the point
  const half = (Math.min(cw, ch) / 2) * 0.82;
  mapScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, (half / (frame * scaleMult)) / 100));
  const s = mapScale * 100;
  mapOffsetX = -x * s * scaleMult;
  mapOffsetY = -z * s * scaleMult;
  _userMovedMap = true; // hold this framing; don't let a data refresh auto-refit away
  renderMap();
  if (name) showToast(`Centered map on ${name} (${x}, ${z})`);
}

// Jump the Overview Highway Map to a player's last sighting: switch to the sighting's
// dimension, frame ~±12k blocks around it, and open the Overview tab.
function focusPlayerOnMap(i) {
  const p = intelProfiles[i];
  if (!p || !p.lastCoords) { if (typeof showToast === 'function') showToast('No position logged for this player yet', 'error'); return; }
  const tab = document.getElementById('tab-dashboard');
  if (tab) tab.click(); // open the Overview view (where sightings/bots plot)
  // Defer a frame so the canvas has its Overview dimensions after the tab becomes visible.
  requestAnimationFrame(() => focusMapOn(p.lastCoords.x, p.lastCoords.z, p.lastDimension || '', p.name));
}

function toggleIntel(i) {
  const el = document.getElementById('intel-detail-' + i);
  if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
}

// 24-bar histogram of sightings by hour (UTC). With only a sighting or two a histogram is
// meaningless — a single lone bar reads as broken — so below 2 total we show a note instead.
function hoursBar(hours, count) {
  const total = (hours || []).reduce((a, b) => a + b, 0);
  if (!hours || !hours.length || total < 2) {
    const n = total || count || 0;
    return `<div class="hours-note">Only ${n} sighting${n === 1 ? '' : 's'} so far — not enough for an hourly pattern.</div>`;
  }
  const max = Math.max(1, ...hours);
  const bars = hours.map((n, h) => {
    const ht = n ? Math.max(12, Math.round((n / max) * 100)) : 6;
    return `<div class="hours-cell ${n ? 'on' : ''}" title="${h}:00 UTC — ${n} sighting${n === 1 ? '' : 's'}" style="height:${ht}%"></div>`;
  }).join('');
  return `<div class="hours-bar">${bars}</div><div class="hours-axis"><span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span></div>`;
}

// ── Metrics: operations / observability ────────────────────
const STATE_COLORS = { G: '#22c55e', Q: '#06b6d4', L: '#ef4444', O: '#6b7280', I: '#f59e0b', U: '#3f3f46' };
const STATE_OF = { in_game: 'G', queuing: 'Q', login_required: 'L', offline: 'O', idle: 'I' };

async function loadMetrics() {
  const range = (document.getElementById('metrics-range') || {}).value || '24h';
  const list = document.getElementById('metrics-list');
  try {
    const res = await apiFetch(`/api/metrics?range=${range}`);
    renderMetrics(await res.json());
  } catch (e) { if (list) list.innerHTML = '<div class="empty-state">Failed to load metrics</div>'; }
}

function renderMetrics(data) {
  const list = document.getElementById('metrics-list');
  const poolEl = document.getElementById('metrics-pool');
  const eventsEl = document.getElementById('metrics-events');
  if (!list) return;
  const labels = data.stateLabel || {};
  if (poolEl) {
    const p = data.pool;
    if (p && p.plan) {
      const pl = p.plan;
      const us = (pl.countries && pl.countries.US) || 0;
      const bw = pl.bandwidthUsedGB != null ? `${pl.bandwidthUsedGB}/${pl.bandwidthLimitGB} GB` : `${pl.bandwidthLimitGB} GB plan`;
      poolEl.innerHTML = `${pl.proxyCount} ${escapeHtml(pl.proxyType || '')} proxies · <b style="color:#22c55e">${us} US</b> · ${bw} · ${pl.replacementsAvailable}/${pl.replacementsTotal} swaps left`;
    } else if (p) {
      poolEl.innerHTML = `Proxy pool: <b>${p.total}</b> · ${p.assigned} assigned`;
    } else {
      poolEl.innerHTML = `range ${data.range}`;
    }
  }
  if (!data.accounts || !data.accounts.length) {
    list.innerHTML = '<div class="empty-state">No accounts with a running proxy yet.</div>';
  } else {
    list.innerHTML = data.accounts.map(a => {
      const avail = a.availability || {};
      const total = Object.values(avail).reduce((x, y) => x + y, 0) || 1;
      const pct = code => Math.round(((avail[code] || 0) / total) * 100);
      const curColor = STATE_COLORS[STATE_OF[a.current.state] || 'U'];
      const curTxt = a.current.state === 'queuing' && a.current.queuePosition != null
        ? `queuing #${a.current.queuePosition}` : (a.current.state || 'unknown').replace('_', ' ');
      return `
        <div class="bot-card" style="flex-direction:column;align-items:stretch;margin-bottom:11px">
          <div style="display:flex;align-items:center;gap:10px">
            <div class="status-dot" style="background:${curColor};width:10px;height:10px"></div>
            <div class="bot-name" style="flex:1;font-size:14px">${escapeHtml(a.ign)}</div>
            <span style="font-size:12px;color:var(--text-2)">${escapeHtml(curTxt)}</span>
          </div>
          <div class="stat-row">
            <div class="stat"><div class="v" style="color:#22c55e">${pct('G')}%</div><div class="l">in-world</div></div>
            <div class="stat"><div class="v" style="color:#38bdf8">${pct('Q')}%</div><div class="l">queuing</div></div>
            <div class="stat"><div class="v" style="color:var(--text-2)">${pct('O')}%</div><div class="l">offline</div></div>
            <div class="stat"><div class="v" style="color:${a.drops ? '#ef4444' : 'var(--text)'}">${a.drops}</div><div class="l">drop${a.drops === 1 ? '' : 's'}</div></div>
            ${a.logins ? `<div class="stat"><div class="v" style="color:#ef4444">${a.logins}</div><div class="l">login${a.logins === 1 ? '' : 's'}</div></div>` : ''}
            ${a.proxySwaps ? `<div class="stat"><div class="v">${a.proxySwaps}</div><div class="l">swap${a.proxySwaps === 1 ? '' : 's'}</div></div>` : ''}
          </div>
          ${stateTimeline(a.segments, data.rangeMs, labels)}
          ${queueSparkline(a.queue, data.rangeMs)}
          <div style="font-size:11px;color:var(--text-4);margin-top:9px;display:flex;justify-content:space-between;gap:10px;font-family:var(--mono)">
            <span>${a.port ? `:${a.port}` : ''}${a.proxyHost ? ` · ${escapeHtml(a.proxyHost)}` : ''}${a.proxyCity ? ` (${escapeHtml(a.proxyCity)}${a.proxyCountry ? ', ' + escapeHtml(a.proxyCountry) : ''})` : (a.proxyCountry ? ` (${escapeHtml(a.proxyCountry)})` : '')}</span>
            ${a.lastInGame ? `<span>last in-world ${timeAgo(a.lastInGame)}</span>` : ''}
          </div>
        </div>`;
    }).join('');
  }
  if (eventsEl) {
    const ev = data.events || [];
    const ico = { drop: '⚠️', in_game: '✅', login_required: '🔐', offline: '🔴', proxy_swap: '🔧', remediate: '🔧' };
    const nameOf = id => { const a = (data.accounts || []).find(x => x.id === id); return a ? a.ign : id; };
    eventsEl.innerHTML = ev.length
      ? ev.map(e => `
        <div class="activity-item">
          <span class="activity-time">${new Date(e.t).toLocaleString()}</span>
          <span class="activity-text">${ico[e.type] || '•'} <span class="player-name">${escapeHtml(nameOf(e.id))}</span> — ${escapeHtml(e.type.replace('_', ' '))}${e.detail ? ` (${escapeHtml(e.detail)})` : ''}</span>
        </div>`).join('')
      : '<div class="empty-state">No events in this range — quiet is good.</div>';
  }
}

// Horizontal proportional state band over the range.
function stateTimeline(segments, rangeMs, labels) {
  const start = Date.now() - rangeMs;
  if (!segments || !segments.length) return `<div style="height:14px;border-radius:4px;background:rgba(255,255,255,.05)" title="no data"></div>`;
  let html = `<div style="display:flex;height:14px;border-radius:4px;overflow:hidden;background:rgba(255,255,255,.05)">`;
  for (const seg of segments) {
    const t0 = Math.max(seg.t0, start);
    const w = ((seg.t1 - t0) / rangeMs) * 100;
    if (w <= 0) continue;
    const c = STATE_COLORS[seg.s] || STATE_COLORS.U;
    const lbl = labels[seg.s] || seg.s;
    html += `<div style="width:${w}%;background:${c}" title="${lbl}: ${new Date(seg.t0).toLocaleTimeString()}–${new Date(seg.t1).toLocaleTimeString()}"></div>`;
  }
  return html + `</div>`;
}

// Inline SVG queue-position sparkline (top = #1, closest to the front).
function queueSparkline(points, rangeMs) {
  if (!points || points.length < 2) return '';
  const start = Date.now() - rangeMs;
  const maxQ = Math.max(...points.map(p => p.q), 1);
  const W = 100, H = 24;
  const x = t => ((t - start) / rangeMs) * W;
  const y = qv => (qv / maxQ) * (H * 0.9) + H * 0.05; // q=1 near top, q=maxQ near bottom
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.q).toFixed(1)}`).join(' ');
  return `<div style="margin-top:6px"><div style="font-size:10px;opacity:.5;margin-bottom:1px">queue position (top = #1, peak #${maxQ})</div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:26px;display:block">
      <path d="${d}" fill="none" stroke="#06b6d4" stroke-width="1" vector-effect="non-scaling-stroke"/>
    </svg></div>`;
}

// ── Activity Feed ──────────────────────────────────────────
function renderActivityFeed() {
  const container = document.getElementById('activity-feed');

  if (recentActivity.length === 0) {
    container.innerHTML = '<div class="empty-state">No player activity detected yet</div>';
    return;
  }

  // Show the genuinely newest sightings BY TIME. The backend groups entries per
  // bot-file (not globally time-sorted), so without this a recent sighting from one
  // bot could be pushed past the 30-item cap by another bot's file — visible on the
  // map (which draws ALL of recentActivity) but missing from the feed.
  const feed = [...recentActivity].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const prevScroll = container.scrollTop; // preserve position so a live update doesn't yank the view
  container.innerHTML = feed.slice(0, 30).map(entry => {
    const time = new Date(entry.timestamp).toLocaleTimeString();
    const name = entry.playerName || '???';
    const coords = entry.coords
      ? `${entry.coords.x}, ${entry.coords.y}, ${entry.coords.z}`
      : '';
    const dir = entry.direction || '';
    const speed = entry.speed ? `${entry.speed.toFixed(1)} b/s` : '';
    const detail = [dir, speed, `${entry.distance || '?'}m`].filter(Boolean).join(' · ');

    const nameHtml = entry.watched
      ? `<span class="player-name" style="color:#f59e0b">👁 ${escapeHtml(name)}</span>`
      : `<span class="player-name">${escapeHtml(name)}</span>`;
    // Click-to-focus: the sighting's position rides on the element as data-* (robust
    // against the feed re-rendering under a live unshift — no index to go stale) and a
    // single delegated listener pans the camera. Coord-less entries (visualRange with
    // no bot position) aren't clickable.
    const focusAttrs = entry.coords
      ? ` data-x="${Math.round(entry.coords.x)}" data-z="${Math.round(entry.coords.z)}" data-dim="${escapeHtml(entry.dimension || '')}" data-name="${escapeHtml(name)}" title="Show this sighting on the map"`
      : '';
    return `
      <div class="activity-item${entry.coords ? ' clickable' : ''}"${focusAttrs}${entry.watched ? ' style="border-left:2px solid #f59e0b;padding-left:6px"' : ''}>
        <span class="activity-time">${time}</span>
        <span class="activity-text">
          ${nameHtml}${entry.source === 'visualRange' ? ' <span title="ZenithProxy radar (mineflayer was offline) — name only, no gear/coords" style="opacity:.55;font-size:11px">📡</span>' : ''}
          ${detail ? ` — ${escapeHtml(detail)}` : ''}
          ${coords ? `<br><span class="coords">${coords}</span>` : ''}
        </span>
      </div>
    `;
  }).join('');
  container.scrollTop = prevScroll; // keep the reader's place across a live/backstop update
}

function addActivityItem(data) {
  const range = document.getElementById('time-filter').value;
  recentActivity.unshift(data);
  if (range !== 'all' && recentActivity.length > 500) {
    recentActivity.pop();
  } else if (range === 'all' && recentActivity.length > 5000) {
    recentActivity.pop();
  }
  renderActivityFeed();
}

// ── Cartography (Xaero stash-hunting board) ────────────────
let cartoData = null;
let cartoView = { ox: 0, oz: 0, scale: 0.02, init: false };  // ox/oz = world-block center; scale = px per block
let _cartoBound = false;
let cartoTerrain = true;            // show rendered terrain tiles when zoomed in
const cartoTiles = {};              // "x_z" → Image | 'missing'
const cartoTileAge = {};            // "x_z" → frame counter, for LRU eviction
let cartoFrame = 0;                 // bumped each drawCarto
const CARTO_TILE_CAP = 900;         // bound retained tiles so long panning can't blow up browser memory
let _cartoRedraw = null, _cartoLastDim = '';

// Drop the least-recently-drawn tiles once the cache exceeds the cap. Tiles
// drawn this frame are visible, so never evict them — the cap is comfortably
// above the max on-screen count (terrain gate is ≤800 regions).
function evictCartoTiles() {
  const keys = Object.keys(cartoTiles);
  if (keys.length <= CARTO_TILE_CAP) return;
  keys.sort((a, b) => (cartoTileAge[a] || 0) - (cartoTileAge[b] || 0));
  let over = keys.length - CARTO_TILE_CAP;
  for (const k of keys) {
    if (over <= 0) break;
    if (cartoTileAge[k] === cartoFrame) continue; // visible now
    delete cartoTiles[k]; delete cartoTileAge[k]; over--;
  }
}

function scheduleCartoRedraw() { if (_cartoRedraw) return; _cartoRedraw = requestAnimationFrame(() => { _cartoRedraw = null; drawCarto(); }); }
function loadTile(x, z) {
  const key = x + '_' + z;
  if (cartoTiles[key] !== undefined) return;
  const img = new Image();
  cartoTiles[key] = img;
  img.onload = scheduleCartoRedraw;
  img.onerror = () => { cartoTiles[key] = 'missing'; };
  img.src = '/api/cartography/tile?dim=' + encodeURIComponent(cartoData.dim) + '&x=' + x + '&z=' + z;
}

/** Dimension-aware coord labels. bx/bz are block coords IN the current dimension;
 *  nether↔overworld is ×8 / ÷8. Returns { primary, alt, hud }. */
function cartoCoords(bx, bz) {
  const dim = (cartoData && cartoData.dim) || 'nether';
  if (dim === 'overworld') return { primary: `OW ${bx}, ${bz}`, alt: `nether ${Math.round(bx / 8)}, ${Math.round(bz / 8)}`, hud: `overworld ${bx}, ${bz}   ·   nether ${Math.round(bx / 8)}, ${Math.round(bz / 8)}` };
  if (dim === 'end') return { primary: `End ${bx}, ${bz}`, alt: '', hud: `end ${bx}, ${bz}` };
  return { primary: `N ${bx}, ${bz}`, alt: `overworld ${bx * 8}, ${bz * 8}`, hud: `nether ${bx}, ${bz}   ·   overworld ${bx * 8}, ${bz * 8}` };
}

async function loadCartography() {
  const dim = document.getElementById('carto-dim').value;
  if (dim !== _cartoLastDim) { for (const k in cartoTiles) delete cartoTiles[k]; for (const k in cartoTileAge) delete cartoTileAge[k]; _cartoLastDim = dim; }
  const stats = document.getElementById('carto-stats');
  try {
    const res = await apiFetch('/api/cartography?dim=' + encodeURIComponent(dim));
    cartoData = await res.json();
    const r = cartoData.regions || [];
    if (stats) stats.textContent = `${r.length} regions · ${cartoData.candidateTotal ?? (cartoData.candidates || []).length} stash chunks · ${(cartoData.sightings || []).length} sightings`;
    if (!cartoView.init && r.length) { fitCarto(); cartoView.init = true; }
    bindCarto();
    drawCarto();
    populateCartoFilter();
    renderCandidates();
  } catch (e) { showToast(e.message, 'error'); }
}

async function uploadCartography(file) {
  const dim = document.getElementById('carto-dim').value;
  const st = document.getElementById('carto-upload-status');
  if (st) st.textContent = `uploading ${(file.size / 1e6).toFixed(1)} MB…`;
  try {
    const res = await apiFetch('/api/cartography/upload?dim=' + encodeURIComponent(dim), {
      method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file,
    });
    const j = await res.json();
    if (j.error) throw new Error(j.error);
    if (st) st.textContent = '';
    showToast(`Added ${j.added} new + ${j.updated} updated regions · ${j.flagged} with base signals`);
    cartoView.init = false; // refit to the new extent
    loadCartography();
  } catch (e) { if (st) st.textContent = ''; showToast(e.message, 'error'); }
}

function fitCarto() {
  const r = (cartoData && cartoData.regions) || [];
  const cv = document.getElementById('carto-canvas');
  if (!r.length || !cv) { cartoView.ox = 0; cartoView.oz = 0; cartoView.scale = 0.02; return; }
  // Fit to the dense 96% of regions so a few far-flung outliers don't shrink the whole
  // map to a dot; the outliers stay reachable by panning/zooming.
  const xs = r.map(g => g.x).sort((a, b) => a - b), zs = r.map(g => g.z).sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * p)))];
  const bMinX = q(xs, 0.02) * 512, bMaxX = (q(xs, 0.98) + 1) * 512, bMinZ = q(zs, 0.02) * 512, bMaxZ = (q(zs, 0.98) + 1) * 512;
  const w = cv.clientWidth || 800, h = cv.clientHeight || 500;
  cartoView.scale = Math.min(w / Math.max(512, bMaxX - bMinX), h / Math.max(512, bMaxZ - bMinZ)) * 0.9;
  cartoView.ox = (bMinX + bMaxX) / 2; cartoView.oz = (bMinZ + bMaxZ) / 2;
}

function bindCarto() {
  if (_cartoBound) return;
  const cv = document.getElementById('carto-canvas');
  if (!cv) return;
  _cartoBound = true;

  const cartoWorldAt = (clientX, clientY) => {
    const rect = cv.getBoundingClientRect();
    return {
      wx: cartoView.ox + (clientX - rect.left - cv.clientWidth / 2) / cartoView.scale,
      wz: cartoView.oz + (clientY - rect.top - cv.clientHeight / 2) / cartoView.scale,
    };
  };
  const updateCartoHud = (clientX, clientY) => {
    const w = cartoWorldAt(clientX, clientY);
    const hud = document.getElementById('carto-hud');
    if (hud) hud.textContent = cartoCoords(Math.round(w.wx), Math.round(w.wz)).hud;
  };

  // Pointer Events (mouse + touch + pen) with two-finger pinch-zoom; wheel kept below.
  const pointers = new Map();
  let drag = null;   // { x, y, ox, oz }
  let pinch = null;  // { d0, s0, ax, az }

  const startCartoPinch = () => {
    const p = [...pointers.values()];
    const d0 = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1;
    const w = cartoWorldAt((p[0].x + p[1].x) / 2, (p[0].y + p[1].y) / 2);
    pinch = { d0, s0: cartoView.scale, ax: w.wx, az: w.wz };
  };
  const doCartoPinch = () => {
    const p = [...pointers.values()];
    if (p.length < 2) return;
    const d1 = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1;
    const midX = (p[0].x + p[1].x) / 2, midY = (p[0].y + p[1].y) / 2;
    cartoView.scale = Math.max(0.0000015, Math.min(4, pinch.s0 * (d1 / pinch.d0)));
    const rect = cv.getBoundingClientRect();
    cartoView.ox = pinch.ax - (midX - rect.left - cv.clientWidth / 2) / cartoView.scale;
    cartoView.oz = pinch.az - (midY - rect.top - cv.clientHeight / 2) / cartoView.scale;
    drawCarto();
  };

  cv.addEventListener('pointerdown', e => {
    cv.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { drag = null; startCartoPinch(); }
    else if (pointers.size === 1) { drag = { x: e.clientX, y: e.clientY, ox: cartoView.ox, oz: cartoView.oz }; }
  });
  cv.addEventListener('pointermove', e => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    updateCartoHud(e.clientX, e.clientY);
    if (pointers.size >= 2 && pinch) { doCartoPinch(); return; }
    if (drag && pointers.size === 1) {
      cartoView.ox = drag.ox - (e.clientX - drag.x) / cartoView.scale;
      cartoView.oz = drag.oz - (e.clientY - drag.y) / cartoView.scale;
      drawCarto();
    }
  });
  const endCarto = e => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 1) { const p = [...pointers.values()][0]; drag = { x: p.x, y: p.y, ox: cartoView.ox, oz: cartoView.oz }; }
    else if (pointers.size === 0) drag = null;
  };
  cv.addEventListener('pointerup', endCarto);
  cv.addEventListener('pointercancel', endCarto);

  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = cv.getBoundingClientRect();
    // world point under the cursor, kept fixed across the zoom (so it zooms toward the
    // cursor instead of "dragging" the view). Min is tiny so huge maps zoom fully out.
    const mx = e.clientX - rect.left - cv.clientWidth / 2, my = e.clientY - rect.top - cv.clientHeight / 2;
    const wx = cartoView.ox + mx / cartoView.scale, wz = cartoView.oz + my / cartoView.scale;
    cartoView.scale = Math.max(0.0000015, Math.min(4, cartoView.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    cartoView.ox = wx - mx / cartoView.scale; cartoView.oz = wz - my / cartoView.scale;
    drawCarto();
  }, { passive: false });
  window.addEventListener('resize', () => { const v = document.getElementById('carto-view'); if (v && v.style.display !== 'none') drawCarto(); });
}

function drawCarto() {
  const cv = document.getElementById('carto-canvas');
  if (!cv || !cartoData) return;
  cartoFrame++;
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0b0b12'; ctx.fillRect(0, 0, w, h);
  const S = cartoView.scale, toX = bx => (bx - cartoView.ox) * S + w / 2, toZ = bz => (bz - cartoView.oz) * S + h / 2;
  const cell = 512 * S;
  // Show terrain whenever a manageable number of regions is on screen (so it appears at
  // most useful zooms), but fall back to abstract squares at extreme zoom-out.
  let vis = 0;
  for (const g of cartoData.regions) { const x = toX(g.x * 512), y = toZ(g.z * 512); if (x > -cell && y > -cell && x < w && y < h) vis++; }
  const useTerrain = cartoTerrain && vis <= 800;
  let newLoads = 0;
  for (const g of cartoData.regions) {
    const x = toX(g.x * 512), y = toZ(g.z * 512);
    if (x < -cell || y < -cell || x > w || y > h) continue;
    if (useTerrain) {
      const tkey = g.x + '_' + g.z;
      cartoTileAge[tkey] = cartoFrame;   // visible this frame — protect from eviction
      const t = cartoTiles[tkey];
      if (t && t.complete && t.naturalWidth) { ctx.drawImage(t, x, y, cell, cell); continue; }
      if (t === undefined && newLoads < 120) { loadTile(g.x, g.z); newLoads++; }
      ctx.fillStyle = '#1a2333'; ctx.fillRect(x, y, Math.max(1, cell), Math.max(1, cell)); // loading
    } else {
      ctx.fillStyle = '#2a3550'; ctx.fillRect(x, y, Math.max(1, cell - 0.5), Math.max(1, cell - 0.5));
    }
  }
  evictCartoTiles();
  // ── 2b2t highways: axes (x=0 N–S, z=0 E–W) + the two diagonals (x=±z), all through
  // origin. Both diagonals are exactly 45° on screen, so draw them through the origin's
  // screen point — keeps coords bounded and orients you when zoomed into a candidate.
  const px0 = toX(0), pz0 = toZ(0), L = w + h;
  ctx.strokeStyle = 'rgba(96,165,250,.5)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(px0, 0); ctx.lineTo(px0, h); ctx.moveTo(0, pz0); ctx.lineTo(w, pz0); ctx.stroke();
  ctx.strokeStyle = 'rgba(96,165,250,.3)';
  ctx.beginPath();
  ctx.moveTo(px0 - L, pz0 - L); ctx.lineTo(px0 + L, pz0 + L);
  ctx.moveTo(px0 - L, pz0 + L); ctx.lineTo(px0 + L, pz0 - L);
  ctx.stroke();

  // Ring roads — the Nether "Diamond Highways": diamonds |x|+|z|=D linking the axis
  // highways (real on 2b2t in the nether). Labelled at the +X vertex when big enough.
  if (cartoData.dim === 'nether') {
    ctx.strokeStyle = 'rgba(96,165,250,.28)'; ctx.lineWidth = 1; ctx.font = '10px system-ui,sans-serif';
    for (const [D, label] of [[25000, '25k'], [50000, '50k'], [125000, '125k'], [250000, '250k'], [500000, '500k'], [3750000, '3.75M']]) {
      ctx.beginPath();
      ctx.moveTo(toX(D), toZ(0)); ctx.lineTo(toX(0), toZ(D)); ctx.lineTo(toX(-D), toZ(0)); ctx.lineTo(toX(0), toZ(-D)); ctx.closePath();
      ctx.stroke();
      if (D * S > 16) { const lx = toX(D), ly = toZ(0); if (lx > -20 && lx < w && ly > 10 && ly < h) { ctx.fillStyle = 'rgba(147,197,253,.7)'; ctx.fillText(label, lx + 3, ly - 3); } }
    }
  }

  const chunkPx = 16 * S;
  ctx.fillStyle = 'rgba(245,158,11,.95)';
  for (const c of (cartoData.candidates || [])) {
    const x = toX(c.blockX), y = toZ(c.blockZ);
    if (x < -4 || y < -4 || x > w || y > h) continue;
    ctx.fillRect(x, y, Math.max(3, chunkPx), Math.max(3, chunkPx));
  }

  ctx.fillStyle = '#22c55e';
  for (const s of (cartoData.sightings || [])) { const x = toX(s.x), y = toZ(s.z); if (x < 0 || y < 0 || x > w || y > h) continue; ctx.beginPath(); ctx.arc(x, y, 2.2, 0, 7); ctx.fill(); }

  // fixed compass — the map is north-up (−Z = north), so these are always correct.
  ctx.fillStyle = 'rgba(147,197,253,.9)'; ctx.font = '600 11px system-ui,sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText('N · -Z', w / 2, 6);
  ctx.textBaseline = 'bottom'; ctx.fillText('S · +Z', w / 2, h - 4);
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText('W · -X', 6, h / 2);
  ctx.textAlign = 'right'; ctx.fillText('E · +X', w - 6, h / 2);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
}

function populateCartoFilter() {
  const sel = document.getElementById('carto-filter');
  if (!sel || !cartoData) return;
  const cur = sel.value;
  const sigs = new Set();
  for (const c of (cartoData.candidates || [])) for (const s of c.signals) sigs.add(s);
  sel.innerHTML = '<option value="">All signals</option>' + [...sigs].sort().map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  sel.value = cur;
}

function renderCandidates() {
  const el = document.getElementById('carto-candidates'), cnt = document.getElementById('carto-cand-count');
  const all = (cartoData && cartoData.candidates) || [];
  const filt = (document.getElementById('carto-filter') || {}).value || '';
  const sort = (document.getElementById('carto-sort') || {}).value || 'strength';
  let cands = filt ? all.filter(c => c.signals.some(s => s.includes(filt))) : all.slice();
  cands.sort((a, b) => sort === 'dist' ? b.dist - a.dist : (b.strength - a.strength || b.dist - a.dist));
  const total = (cartoData && cartoData.candidateTotal) || all.length;
  if (cnt) cnt.textContent = total ? `(${cands.length}${cands.length !== total ? ' of ' + total : ''})` : '';
  if (!el) return;
  if (!cands.length) { el.innerHTML = '<div class="empty-state">No base signals' + (filt ? ' for that filter.' : ' yet — upload Xaero data.') + '</div>'; return; }
  el.innerHTML = cands.slice(0, 300).map(c => {
    const cc = cartoCoords(c.blockX, c.blockZ);
    const more = c.signals.length > 4 ? ` +${c.signals.length - 4}` : '';
    return `<div class="carto-cand" onclick="focusCarto(${c.blockX},${c.blockZ})" title="Center the map here">
      <span class="co">${cc.primary}</span>
      <span class="sig">${c.signals.slice(0, 4).map(escapeHtml).join(', ')}${more}</span>
      <span class="far">${cc.alt ? cc.alt + ' · ' : ''}${Math.round(c.dist * 512 / 1000)}k out</span>
    </div>`;
  }).join('');
}

function exportWaypoints() {
  const dim = document.getElementById('carto-dim').value;
  const filt = (document.getElementById('carto-filter') || {}).value || '';
  const url = '/api/cartography/waypoints?dim=' + encodeURIComponent(dim) + (filt ? '&signal=' + encodeURIComponent(filt) : '');
  const a = document.createElement('a'); a.href = url; a.download = 'stash_waypoints_' + dim + '.txt';
  document.body.appendChild(a); a.click(); a.remove();
  showToast('Downloading Xaero waypoints — drop into your xaero/minimap folder or import in-game.');
}

function focusCarto(bx, bz) {
  cartoView.ox = bx + 8; cartoView.oz = bz + 8;   // centre on the chunk
  cartoView.scale = Math.max(cartoView.scale, 0.4);
  drawCarto();
}

// On-screen zoom button handler for the carto board (centre-anchored).
function cartoZoomBy(factor) {
  cartoView.scale = Math.max(0.0000015, Math.min(4, cartoView.scale * factor));
  drawCarto();
}

// ── Map Rendering ──────────────────────────────────────────
function setupMap() {
  const canvas = document.getElementById('nether-map');
  const container = document.getElementById('map-container');

  // Resize canvas to container
  function resize() {
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    renderMap();
  }

  window.addEventListener('resize', resize);
  resize();

  // Screen point → world (nether/overworld blocks), used for zoom anchoring + the HUD.
  function worldAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.width / dpr, ch = canvas.height / dpr;
    const scaleMult = mapDimension === 'overworld' ? 8 : 1;
    const s = mapScale * 100;
    const cx = cw / 2 + mapOffsetX, cy = ch / 2 + mapOffsetY;
    return { wx: (clientX - rect.left - cx) / (s * scaleMult), wz: (clientY - rect.top - cy) / (s * scaleMult) };
  }

  // ── Pointer Events: unified mouse + touch + pen pan, with two-finger pinch-zoom.
  // Pointer Events cover the mouse too, so desktop drag keeps working; wheel stays
  // below for trackpad/mouse zoom.
  const pointers = new Map();   // pointerId → { x, y }
  let pinch = null;             // { d0, s0, ax, az } — pinch anchor (world point fixed under the midpoint)
  let moved = 0;                // px travelled since pointerdown (to tell a tap from a drag)

  const startPinch = () => {
    const p = [...pointers.values()];
    const d0 = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1;
    const w = worldAt((p[0].x + p[1].x) / 2, (p[0].y + p[1].y) / 2);
    pinch = { d0, s0: mapScale, ax: w.wx, az: w.wz };
  };
  const doPinch = () => {
    const p = [...pointers.values()];
    if (p.length < 2) return;
    _userMovedMap = true;
    const d1 = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1;
    const midX = (p[0].x + p[1].x) / 2, midY = (p[0].y + p[1].y) / 2;
    mapScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, pinch.s0 * (d1 / pinch.d0)));
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.width / dpr, ch = canvas.height / dpr;
    const scaleMult = mapDimension === 'overworld' ? 8 : 1;
    const s = mapScale * 100;
    // keep the pinch's world anchor pinned under the current finger midpoint
    mapOffsetX = (midX - rect.left - cw / 2) - pinch.ax * s * scaleMult;
    mapOffsetY = (midY - rect.top - ch / 2) - pinch.az * s * scaleMult;
    renderMap();
  };

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = 0;
    updateHoverCoords(e.clientX, e.clientY);
    if (pointers.size === 2) { isDragging = false; startPinch(); }
    else if (pointers.size === 1) {
      isDragging = true;
      dragStart = { x: e.clientX - mapOffsetX, y: e.clientY - mapOffsetY };
      canvas.style.cursor = 'grabbing';
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) {
      const prev = pointers.get(e.pointerId);
      moved += Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    updateHoverCoords(e.clientX, e.clientY);
    if (pointers.size >= 2 && pinch) { doPinch(); return; }
    if (isDragging && pointers.size === 1) {
      if (moved > 6) _userMovedMap = true;   // a real drag (not a tap) → operator has control
      mapOffsetX = e.clientX - dragStart.x;
      mapOffsetY = e.clientY - dragStart.y;
      renderMap();
      return;
    }
    // Desktop hover: peek a cluster's tooltip without clicking. Mouse only (touch
    // has no hover), never while dragging, and never over a click-pinned tooltip.
    if (e.pointerType === 'mouse' && pointers.size === 0) hoverHitTest(e.clientX, e.clientY);
  });

  /** Hover hit-test against the drawn sighting clusters: show a read-only peek
   *  tooltip (no delete button — that stays click-only) and a pointer cursor. */
  function hoverHitTest(clientX, clientY) {
    if (window._tooltipPinned) return;                 // a clicked tooltip owns the surface
    const tooltip = document.getElementById('map-tooltip');
    if (!tooltip) return;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    let hit = null;
    for (const c of (window._mapClusters || [])) {
      if (Math.hypot(x - c.x, y - c.y) <= 16) { hit = c; break; }
    }
    if (!hit) {
      canvas.style.cursor = 'grab';
      if (tooltip._hoverOpen) { tooltip.classList.add('hidden'); tooltip._hoverOpen = false; }
      return;
    }
    canvas.style.cursor = 'pointer';
    const container = canvas.parentElement;
    const containerRect = container.getBoundingClientRect();
    let left = x + 15, top = y + 15;
    if (left > containerRect.width - 200) left = x - 215;
    if (top > containerRect.height - 200) top = y - 215;
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
    const rows = hit.entries.slice(0, 8).map(en => {
      const t = new Date(en.timestamp).toLocaleTimeString();
      const dir = en.direction && en.direction !== 'Entering' ? en.direction : 'Entered';
      return `<li><span>${escapeHtml(en.playerName || 'Unknown')} [${escapeHtml(dir)}]</span><span class="time">${t}</span></li>`;
    }).join('');
    const more = hit.entries.length > 8 ? `<li><span class="time">…and ${hit.entries.length - 8} more — click for all</span></li>` : '';
    tooltip.innerHTML = `<h4>Players (${hit.entries.length})</h4><ul>${rows}${more}</ul>` +
      `<div class="time" style="opacity:.6;margin-top:4px">${can(1) ? 'click marker to manage' : 'click marker for details'}</div>`;
    tooltip.classList.remove('hidden');
    tooltip._hoverOpen = true;
  }

  // Leaving the canvas closes a hover peek (a click-pinned tooltip stays).
  canvas.addEventListener('pointerleave', () => {
    const tooltip = document.getElementById('map-tooltip');
    if (tooltip && tooltip._hoverOpen && !window._tooltipPinned) { tooltip.classList.add('hidden'); tooltip._hoverOpen = false; }
  });

  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 1) {
      // one finger lifted mid-pinch → hand panning back to the finger still down
      const p = [...pointers.values()][0];
      dragStart = { x: p.x - mapOffsetX, y: p.y - mapOffsetY };
      isDragging = true;
    } else if (pointers.size === 0) {
      isDragging = false;
      canvas.style.cursor = 'grab';
    }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('click', (e) => {
    if (moved > 6) return;   // that was a drag/pinch, not a tap — don't toggle anything
    // Tap on empty map toggles the coord HUD (touch has no :hover); a tap on a
    // cluster still opens its tooltip below.
    if (!window._mapClusters) {
      const hud = document.getElementById('hover-coords');
      if (hud) hud.classList.toggle('show');
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Cluster.x/.y are stored in CSS pixels (cx = cw/2, cw = canvas.width/dpr), so the
    // hit-test must compare in CSS pixels too. The old code scaled the click point to
    // DEVICE pixels (× devicePixelRatio), which on any HiDPI/Retina display (dpr≠1) put
    // the click 2× off from the cluster coords — so tapping a sighting missed it or hit
    // the wrong one, breaking the tooltip and the "delete these N sightings" button.
    let clickedCluster = null;
    for (const cluster of window._mapClusters) {
      const dist = Math.sqrt(Math.pow(x - cluster.x, 2) + Math.pow(y - cluster.y, 2));
      if (dist <= 20) {
        clickedCluster = cluster;
        break;
      }
    }

    const tooltip = document.getElementById('map-tooltip');
    if (clickedCluster) {
      // Keep tooltip in bounds
      const containerRect = container.getBoundingClientRect();
      let left = x + 15;
      let top = y + 15;
      if (left > containerRect.width - 200) left = x - 215;
      if (top > containerRect.height - 200) top = y - 215;

      tooltip.style.left = left + 'px';
      tooltip.style.top = top + 'px';
      window._selectedClusterEntries = clickedCluster.entries;
      tooltip.innerHTML = `<h4>Players (${clickedCluster.entries.length})</h4><ul>` +
        clickedCluster.entries.map(e => {
           const time = new Date(e.timestamp).toLocaleDateString() + ' ' + new Date(e.timestamp).toLocaleTimeString();
           const name = e.playerName || 'Unknown';
           const dir = e.direction && e.direction !== 'Entering' ? e.direction : 'Entered';
           const dur = e.duration ? ` (${e.duration}s)` : '';
           return `<li><span>${escapeHtml(name)} [${escapeHtml(dir)}]${dur}</span><span class="time">${time}</span></li>`;
        }).join('') + '</ul>' +
        // Deleting sightings is a trusted+ API — don't render a button that would 403 for viewers.
        (can(1) ? `<button class="btn-sm" style="color:#ef4444;width:100%;margin-top:6px" onclick="deleteSelectedSightings()">🗑 Delete these ${clickedCluster.entries.length}</button>` : '');
      tooltip.classList.remove('hidden');
      tooltip._hoverOpen = false;
      window._tooltipPinned = true;   // clicked-open → hover must not replace/close it
    } else {
      tooltip.classList.add('hidden');
      window._tooltipPinned = false;  // clicked empty space → release the pin
      const hud = document.getElementById('hover-coords');   // tap empty area → toggle HUD (touch)
      if (hud) hud.classList.toggle('show');
    }
  });

  // Update the coord HUD for a screen point (called from pointer move/down, so it
  // works for both mouse hover and touch drag).
  function updateHoverCoords(clientX, clientY) {
    const hud = document.getElementById('hover-coords');
    if (!hud) return;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    const dpr = window.devicePixelRatio;
    const cw = canvas.width / dpr;
    const ch = canvas.height / dpr;

    const cx = cw / 2 + mapOffsetX;
    const cy = ch / 2 + mapOffsetY;

    const scaleMult = mapDimension === 'overworld' ? 8 : 1;
    const s = mapScale * 100;

    const coordX = Math.round((x - cx) / (s * scaleMult));
    const coordZ = Math.round((y - cy) / (s * scaleMult));

    // Ring-road hover: the primary rings are axis-aligned squares, so the cursor is "on"
    // the ring whose Chebyshev (max-axis) distance from spawn matches. Snap to the nearest
    // drawn ring and, if close to its line, append the distance.
    let ringNote = '';
    const blocksAcross = (cw / s) / scaleMult;
    const rough = (blocksAcross / 6) || 1;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    const ringStep = (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag;
    const chebPx = Math.max(Math.abs(x - cx), Math.abs(y - cy));
    const nearestR = Math.round((chebPx / (s * scaleMult)) / ringStep) * ringStep;
    if (nearestR > 0 && Math.abs(chebPx - nearestR * s * scaleMult) <= 6) {
      const rl = nearestR >= 1000000 ? (nearestR / 1000000) + 'M' : (nearestR >= 1000 ? (nearestR / 1000) + 'k' : nearestR);
      ringNote = `  ·  ring ${rl}`;
    }
    hud.textContent = `X: ${coordX}, Z: ${coordZ}${ringNote}`;
  }

  // Mouse wheel: zoom toward the cursor (keep the world point under the mouse fixed)
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.width / dpr, ch = canvas.height / dpr;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    _userMovedMap = true;   // operator is zooming → stop auto-framing on data updates
    // Smooth, resolution-independent zooming for both mice and trackpads
    const factor = Math.exp(-e.deltaY * 0.002);
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, mapScale * factor));
    const ratio = newScale / mapScale; // actual change after clamping
    const dx = mx - cw / 2, dy = my - ch / 2;
    mapOffsetX = dx - (dx - mapOffsetX) * ratio;
    mapOffsetY = dy - (dy - mapOffsetY) * ratio;
    mapScale = newScale;
    renderMap();
  });

  canvas.style.cursor = 'grab';
}

// ── Map visual language (tactical hybrid: cool-indigo shell + tactical map) ──
const MAP = {
  hw: '99, 102, 241',       // indigo infrastructure (highways / rings / grid)
  inworld: '52, 211, 153',  // green = a live in-world asset
  queue: '96, 138, 214',    // calm dim-blue = a queuing (ghost) asset
  contact: '239, 68, 68',   // red = a contact (high gear-wealth — from live visible gear only)
  watched: '245, 158, 11',  // amber-gold = watchlist
  cyan: '56, 189, 248',     // radar/scan accent
};
/** Contact ring colour by gear-wealth score (0 → calm slate, high → hot red). "r,g,b". */
function wealthColor(score) {
  if (score >= 8) return MAP.contact;      // red — geared rival
  if (score >= 4) return '245, 158, 11';   // amber — notable
  return '148, 163, 184';                  // slate — passer-by
}
/** Gear-wealth score for a single sighting entry (from its visible equipment). Map rings STAY
 *  gear-based — a live sighting carries no api.2b2t.vc profile data, only what we can see. */
function entryGearWealth(entry) {
  if (!entry || !entry.equipment) return 0;
  const g = [];
  for (const v of Object.values(entry.equipment)) { const it = (typeof v === 'string') ? v : (v && v.item); if (it) g.push(it); }
  return clientGearWealth(g);
}
/** Recency → alpha: a fresh pass is bright, a day-old one is faint. Ages against the
 *  map clock (mapNow), so a replay re-brightens each pass at its historical moment. */
function recencyAlpha(ts) {
  const age = mapNow() - new Date(ts).getTime();
  return 0.25 + 0.75 * Math.max(0, Math.min(1, 1 - age / (24 * 3600 * 1000)));
}

function renderMap() {
  // Throttle: only schedule one rAF at a time
  if (_mapRafPending) return;
  _mapRafPending = true;
  requestAnimationFrame(_renderMapImpl);
}

// Frame spawn + all groups/bots with padding — the sensible default view, so the
// map opens showing your actual bases instead of an empty patch around spawn.
function fitToContent() {
  const canvas = document.getElementById('nether-map');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.width / dpr, ch = canvas.height / dpr;
  if (!cw || !ch) return;
  const scaleMult = mapDimension === 'overworld' ? 8 : 1;
  const dimOk = (dim) => { if (!dim) return true; if (dim.includes('end')) return false; const n = dim.includes('nether'); return mapDimension === 'nether' ? n : !n; };
  // Frame the ACTION by the BULK of it, not its max extent — one lone sighting 450k out
  // must not zoom the whole map out so the dense ~100k highway activity is a tiny dot near
  // spawn. Collect |x|,|z| of recent sightings (6h) + every fleet asset's last-known spot in
  // this dim (in-world AND queuing ghosts) + groups, then frame to the ~85th percentile so a
  // couple of far outliers fall just off-screen instead of dominating.
  const vals = [];
  const push = (x, z) => { if (x != null && z != null) { vals.push(Math.abs(x)); vals.push(Math.abs(z)); } };
  // Frame to ALL recent sightings in this dim (activity is sparse — bots queue for hours, so
  // the newest pass is often many hours old; a tight time filter would drop everything).
  for (const e of recentActivity) if (e.coords && dimOk(e.dimension)) push(e.coords.x, e.coords.z);
  if (systemStatus && systemStatus.bots) for (const b of Object.values(systemStatus.bots)) if (b.lastPosition && dimOk(b.lastPosition.dimension)) push(b.lastPosition.x, b.lastPosition.z);
  let maxAbs = 30000;
  if (vals.length) { vals.sort((a, b) => a - b); maxAbs = Math.max(maxAbs, vals[Math.floor((vals.length - 1) * 0.85)]); }
  maxAbs = Math.min(600000, maxAbs * 1.2);   // floor 30k, cap 600k, +20% pad
  const half = (Math.min(cw, ch) / 2) * 0.82;   // px from center to the farthest point (with padding)
  const sPerBlock = half / (maxAbs * scaleMult);
  mapScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, sPerBlock / 100));
  mapOffsetX = 0; mapOffsetY = 0;               // centered on spawn
  renderMap();
}

function _renderMapImpl() {
  _mapRafPending = false;
  _hasActivePings = false; // recomputed below if there are live sightings
  const canvas = document.getElementById('nether-map');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const dpr = window.devicePixelRatio || 1;

  // Reset transform to prevent compounding scale if a crash occurred previously
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  
  ctx.save();
  ctx.scale(dpr, dpr);

  const cw = w / dpr;
  const ch = h / dpr;

  // Player/bot name labels are collected here and laid out at the end with collision
  // avoidance (fan out vertically + leader lines), so names stay readable without
  // having to zoom way in when markers bunch up on a highway.
  const mapLabels = [];
  let inWorldPlotted = 0;   // in-world bot markers drawn this frame → drives the empty-map overlay
  let sightingMarkers = 0;  // player sighting/ping markers drawn this frame
  let ghostPlotted = 0;     // queuing "ghost" markers drawn this frame (map is never truly empty)
  let fleetOnWatch = false; // true while no asset is in-world in this dim → radar sweep + breathing

  // Center of canvas + offset
  const cx = cw / 2 + mapOffsetX;
  const cy = ch / 2 + mapOffsetY;

  // Scale: mapScale = pixels per nether block
  const s = mapScale * 100; // amplify for visibility
  const isOverworld = mapDimension === 'overworld';
  const scaleMult = isOverworld ? 8 : 1;

  // Map infrastructure (highways / rings / grid) all share ONE indigo hue so it
  // reads as a coherent backdrop while the bright bot + sighting markers pop as
  // the live data on top. No glow — crisp lines.
  const HW = '99, 102, 241';

  // ── Background grid (very subtle) ──
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.016)';
  ctx.lineWidth = 0.5;
  const gridStep = isOverworld ? 10000 : 1000;
  const gridPx = gridStep * s;
  if (gridPx > 26) {
    for (let gx = cx % gridPx; gx < cw; gx += gridPx) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, ch); ctx.stroke(); }
    for (let gy = cy % gridPx; gy < ch; gy += gridPx) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(cw, gy); ctx.stroke(); }
  }

  const worldBorder = isOverworld ? 30000000 : 3750000;

  // ── Concentric square ring roads (adaptive, ~6 across, snapped to 1/2/5×10ⁿ) ──
  const blocksAcross = (cw / s) / scaleMult;
  const rough = (blocksAcross / 6) || 1;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const ringStep = (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '11px JetBrains Mono, monospace';
  const drawRingLabel = (px, py, lbl, align) => {
    if (px < -20 || px > cw + 30 || py < 8 || py > ch - 2) return;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 3;
    ctx.fillStyle = 'rgba(184,189,255,0.95)'; ctx.textAlign = align;
    ctx.fillText(lbl, px, py);
    ctx.restore();
  };
  // ── Square Ring Roads — 2b2t's PRIMARY ring roads are axis-aligned SQUARES encircling
  //    spawn (Chebyshev), labelled by axis radius. Drawn adaptively so there's a distance
  //    reference at any zoom. A point on a diagonal at (R, R) sits on the R-ring's corner —
  //    i.e. "R out" on that diagonal, which is how highway distance is referenced on 2b2t
  //    (a sighting at nether 100k,100k reads as 100k, not 200k). ──
  for (let r = ringStep, i = 0; r <= worldBorder && i < 40; r += ringStep, i++) {
    const rp = r * scaleMult * s;
    if (rp < 18) continue;
    ctx.beginPath();
    ctx.rect(cx - rp, cy - rp, rp * 2, rp * 2);
    ctx.strokeStyle = `rgba(${HW}, 0.11)`;
    ctx.lineWidth = 1;
    ctx.stroke();
    const lbl = r >= 1000000 ? (r / 1000000) + 'M' : (r >= 1000 ? (r / 1000) + 'k' : r);
    drawRingLabel(cx + 6, cy + rp - 4, lbl, 'left');   // South (+Z) crossing
    drawRingLabel(cx + 6, cy - rp - 4, lbl, 'left');   // North (-Z) crossing
    drawRingLabel(cx + rp + 6, cy - 4, lbl, 'left');   // East (+X) crossing
    drawRingLabel(cx - rp - 6, cy - 4, lbl, 'right');  // West (-X) crossing
  }
  // ── Diamond Highways — the real 2b2t 45°-rotated ring roads at 25k/50k/125k/250k/500k
  //    (nether), each connecting the axis highways at that radius and crossing the diagonals
  //    at HALF it. Drawn as distinct dashed cyan diamonds |x|+|z|=D, labelled "◇Nk" so they
  //    read as the diamond network, not the square RRs. ──
  ctx.font = '10px JetBrains Mono, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  for (const D of [25000, 50000, 125000, 250000, 500000]) {
    const rp = D * scaleMult * s;
    if (rp < 26 || rp > Math.max(cw, ch) * 3) continue;
    ctx.beginPath();
    ctx.moveTo(cx + rp, cy); ctx.lineTo(cx, cy + rp); ctx.lineTo(cx - rp, cy); ctx.lineTo(cx, cy - rp); ctx.closePath();
    ctx.strokeStyle = `rgba(${MAP.cyan}, 0.18)`; ctx.lineWidth = 1; ctx.setLineDash([2, 5]); ctx.stroke(); ctx.setLineDash([]);
    const lx = cx + rp;
    if (lx > -30 && lx < cw && cy > 10 && cy < ch) { ctx.fillStyle = `rgba(${MAP.cyan}, 0.5)`; ctx.fillText('◇' + (D / 1000) + 'k', lx + 4, cy - 4); }
  }

  // World border (dim, dashed).
  const wbp = worldBorder * scaleMult * s;
  if (wbp > 24 && wbp < Math.max(cw, ch) * 6) {
    ctx.beginPath();
    ctx.rect(cx - wbp, cy - wbp, wbp * 2, wbp * 2);
    ctx.strokeStyle = 'rgba(96, 165, 250, 0.32)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([7, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ── The 8 highways from spawn (one hue; axes brighter, diagonals dimmer) ──
  const screenDiagPx = Math.sqrt(w * w + h * h) + Math.abs(mapOffsetX) + Math.abs(mapOffsetY);
  const drawLength = Math.min(worldBorder, (screenDiagPx / s) * 1.5);
  ctx.lineCap = 'round';
  for (const hw of Object.values(HIGHWAYS)) {
    const isAxis = hw.vector.x === 0 || hw.vector.z === 0;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + hw.vector.x * drawLength * s, cy + hw.vector.z * drawLength * s);
    ctx.strokeStyle = `rgba(${HW}, ${isAxis ? 0.82 : 0.5})`;
    ctx.lineWidth = isAxis ? 2 : 1.4;
    ctx.stroke();
  }
  ctx.lineCap = 'butt';

  // Direction labels: sit at the END of each highway — wherever the line actually
  // stops (world border when zoomed out, screen edge when zoomed in) — so they
  // track the highways instead of floating at a fixed radius.
  for (const hw of Object.values(HIGHWAYS)) {
    const vlen = Math.hypot(hw.vector.x, hw.vector.z) || 1;
    const nx = hw.vector.x / vlen, nz = hw.vector.z / vlen;
    // distance from the origin to the screen edge along this direction
    const tx = nx > 0 ? (cw - cx) / nx : (nx < 0 ? -cx / nx : Infinity);
    const ty = nz > 0 ? (ch - cy) / nz : (nz < 0 ? -cy / nz : Infinity);
    const screenEdge = Math.min(tx, ty);
    const hwEnd = drawLength * s * vlen; // where the drawn highway line ends (px)
    let ld = Math.min(hwEnd, screenEdge) - 18;
    ld = Math.max(38, Math.min(ld, screenEdge - 6)); // stay on-line, off the origin, on-screen
    const lx = cx + nx * ld;
    const ly2 = cy + nz * ld;
    const isAxis = hw.vector.x === 0 || hw.vector.z === 0;
    ctx.fillStyle = `rgba(165, 170, 255, ${isAxis ? 0.95 : 0.7})`;
    ctx.font = `${isAxis ? 'bold ' : ''}11px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(hw.label, lx, ly2);
  }
  ctx.textBaseline = 'alphabetic';

  // ── Spawn area + origin ──
  const spawnRadius = (2100 * scaleMult) * s;
  if (spawnRadius > 5 && spawnRadius < Math.min(cw, ch) * 0.4) {
    ctx.beginPath();
    ctx.arc(cx, cy, spawnRadius, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${HW}, 0.3)`;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#e5e7eb';
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.textAlign = 'left';
  ctx.fillText('spawn', cx + 7, cy + 4);

  // ── Sighting heatmap — historical traffic density. A screen-space additive kernel: every
  //    logged pass is a warm glow, and where passes pile up (a hot highway) they stack into a
  //    bright zone. Drawn UNDER the live markers so it reads as ambient "where the traffic is"
  //    even when nobody is on right now — our own-data answer to 2b2theatmap. ──
  if (mapHeat && recentActivity.length) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const KR = 24;                     // kernel radius (screen px)
    let drawn = 0;
    for (const e of recentActivity) {
      if (!e.coords) continue;
      if (scrubActive && new Date(e.timestamp).getTime() > scrubT) continue; // not happened yet at this replay moment
      const d = e.dimension;
      if (d) { if (d.includes('end')) continue; const n = d.includes('nether'); if ((mapDimension === 'nether') !== n) continue; }
      const px = cx + e.coords.x * scaleMult * s, py = cy + e.coords.z * scaleMult * s;
      if (px < -KR || px > cw + KR || py < -KR || py > ch + KR) continue;
      const a = 0.13 * recencyAlpha(e.timestamp);
      const grd = ctx.createRadialGradient(px, py, 0, px, py, KR);
      grd.addColorStop(0, `rgba(251, 191, 36, ${a})`);          // amber core
      grd.addColorStop(0.55, `rgba(239, 68, 68, ${a * 0.45})`); // red mid
      grd.addColorStop(1, 'rgba(239, 68, 68, 0)');
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.arc(px, py, KR, 0, Math.PI * 2); ctx.fill();
      if (++drawn > 4000) break;         // safety cap for very large ranges
    }
    ctx.restore();
  }

  // (Coverage-group markers were moved off the Overview map into the admin-only Coverage tab.)

  // inDim() classifies a position into the currently-viewed map dimension. HOISTED above the
  // trusted-only bot-drawing guard so the radar-sweep block below can use it on EVERY render.
  const inDim = (pos) => { if (!pos || !pos.dimension) return true; if (pos.dimension.includes('end')) return false; const n = pos.dimension.includes('nether'); return mapDimension === 'nether' ? n : !n; };

  // ── Radar sweep ("on watch" cue) — runs EVERY render, OUTSIDE the trusted-bot guard ──
  // The whole show/size/position block used to live inside `can(1) && systemStatus.bots`, so a
  // transient null systemStatus (reconnect) or a non-trusted viewer stranded the sweep hidden —
  // and with _mapAnimate === _hasActivePings there's no rAF to re-run it. Compute on-watch
  // DEFENSIVELY: missing systemStatus/bots ⇒ on-watch ⇒ show. When a bot IS in-world in the
  // viewed dimension we still hide it (fleetOnWatch false). Rotation is pure CSS (no new rAF).
  {
    const anyInWorld = !!(systemStatus && systemStatus.bots) && Object.values(systemStatus.bots).some(b => b.proxyState === 'in_game' && b.lastPosition && inDim(b.lastPosition));
    fleetOnWatch = !anyInWorld;
    // Radar sweep visibility: an ambient "the surveillance system is scanning spawn" cue, shown
    // in EITHER dimension whenever the fleet is live (any bot queuing OR in-world). It is NOT a
    // per-dimension emptiness marker — the old rule keyed it to "no bot in-world in THIS dim", so
    // it appeared over the empty overworld and vanished in the nether where the placed bots
    // actually watch. It renders UNDER the map canvas (z-index 1 < 2) so it never obscures
    // highways/markers even with bots in-world. Defensive default (status not yet loaded) → show.
    const bots = systemStatus && systemStatus.bots;
    // mapRadar = the operator's toggle (map controls, persisted); the rest is the
    // fleet-liveness rule described above.
    const showRadar = mapRadar && (!bots || Object.values(bots).some(b => b.proxyState === 'queuing' || b.proxyState === 'in_game'));
    const radar = document.getElementById('map-radar');
    if (radar) {
      if (showRadar) {
        if (!radar._drawn) {
          // Draw the sweep ONCE onto a small fixed canvas; CSS then scales + rotates the element,
          // so it animates on the compositor with NO canvas rAF (no CPU peg, no blocked idle).
          // A single soft sweeping wedge (bright leading edge, tail fading over ~90°) with a
          // RADIAL falloff so it's strongest at spawn and dissolves toward the rim — this is what
          // keeps it clean at the >10× upscale (the old build baked a hard 2.5px leading LINE that
          // upscaled into a solid ~27px beam, plus a 2nd opposite wedge that read as two bars).
          const N = 600, C = N / 2; radar.width = N; radar.height = N;
          const rc = radar.getContext('2d');
          rc.clearRect(0, 0, N, N);
          // 1) Sweep wedge — crisp bright leading edge, tail fading over ~50° (tighter than the
          //    old 90° blob so it reads as a scanning beam, not a wash).
          if (typeof rc.createConicGradient === 'function') {
            const g = rc.createConicGradient(0, C, C);
            g.addColorStop(0.00, 'rgba(56,189,248,0.20)'); // leading edge
            g.addColorStop(0.04, 'rgba(56,189,248,0.08)');
            g.addColorStop(0.14, 'rgba(56,189,248,0)');    // tail gone by ~50°
            g.addColorStop(1.00, 'rgba(56,189,248,0)');
            rc.fillStyle = g;
          } else {
            // Engine without conic gradients: a plain radial wash (still a coherent scan glow).
            const g = rc.createRadialGradient(C, C, 0, C, C, C);
            g.addColorStop(0, 'rgba(56,189,248,0.10)');
            g.addColorStop(1, 'rgba(56,189,248,0)');
            rc.fillStyle = g;
          }
          rc.beginPath(); rc.arc(C, C, C, 0, Math.PI * 2); rc.fill();
          // 2) A crisp leading-edge line. Safe now that R is VIEWPORT-bounded (~1:1 scale) — the
          //    old build upscaled the 600px canvas up to 10× which turned this into a solid beam.
          rc.strokeStyle = 'rgba(125,215,255,0.55)'; rc.lineWidth = 1.5;
          rc.beginPath(); rc.moveTo(C, C); rc.lineTo(N, C); rc.stroke();
          // 3) Radial falloff (destination-in) so the wedge AND the leading line dissolve toward
          //    the rim instead of ending in a hard edge.
          rc.globalCompositeOperation = 'destination-in';
          const mask = rc.createRadialGradient(C, C, 0, C, C, C);
          mask.addColorStop(0.0, 'rgba(0,0,0,1)');
          mask.addColorStop(0.6, 'rgba(0,0,0,0.5)');
          mask.addColorStop(1.0, 'rgba(0,0,0,0)');
          rc.fillStyle = mask;
          rc.beginPath(); rc.arc(C, C, C, 0, Math.PI * 2); rc.fill();
          rc.globalCompositeOperation = 'source-over';
          // 4) Concentric range rings (drawn after the mask so they stay crisp/visible).
          rc.strokeStyle = 'rgba(56,189,248,0.09)'; rc.lineWidth = 1;
          for (const rr of [0.32, 0.52, 0.72, 0.94]) { rc.beginPath(); rc.arc(C, C, C * rr, 0, Math.PI * 2); rc.stroke(); }
          // 5) Spawn dot at the sweep origin.
          rc.fillStyle = 'rgba(125,215,255,0.6)';
          rc.beginPath(); rc.arc(C, C, 3, 0, Math.PI * 2); rc.fill();
          radar._drawn = true;
        }
        // Centre on SPAWN (cx,cy) so the sweep is glued to the world origin and pans WITH the map.
        // Radius is a CONSTANT fraction of the viewport — deliberately independent of BOTH pan
        // position and zoom, so the rings no longer grow/shrink as you pan around (the old cornerR
        // = distance-from-spawn-to-corner term is what resized them). Rotation stays pure CSS about
        // the element centre (= spawn).
        const R = Math.max(120, 0.6 * Math.min(cw, ch));
        radar.style.width = radar.style.height = (2 * R) + 'px';
        radar.style.left = (cx - R) + 'px';
        radar.style.top = (cy - R) + 'px';
        radar.classList.add('show');
      } else {
        radar.classList.remove('show');
      }
    }
  }

  // ── Draw actual live bots — trusted+ only (hides bot names/positions) ──
  if (can(1) && systemStatus && systemStatus.bots) {
    const COVERAGE_BLOCKS = 160;   // approximate monitor detection radius (a soft indicator)
    let nearestEta = Infinity;
    for (const [botId, bot] of Object.entries(systemStatus.bots)) {
      if (!bot.lastPosition || !inDim(bot.lastPosition)) continue;
      const bx = cx + (bot.lastPosition.x * scaleMult) * s;
      const by = cy + (bot.lastPosition.z * scaleMult) * s;
      if (bx < -80 || bx > cw + 80 || by < -80 || by > ch + 80) continue;

      if (bot.proxyState === 'in_game') {
        // A LIVE in-world asset: watch-radius + breathing halo + solid green core.
        const covPx = COVERAGE_BLOCKS * scaleMult * s;
        if (covPx > 6 && covPx < Math.max(cw, ch)) {
          ctx.beginPath(); ctx.arc(bx, by, covPx, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${MAP.inworld}, 0.05)`; ctx.fill();
          ctx.strokeStyle = `rgba(${MAP.inworld}, 0.28)`; ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
        }
        ctx.beginPath(); ctx.arc(bx, by, 11, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${MAP.inworld}, 0.18)`; ctx.fill();
        ctx.beginPath(); ctx.arc(bx, by, 6, 0, Math.PI * 2);
        ctx.fillStyle = `rgb(${MAP.inworld})`; ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
        mapLabels.push({ text: bot.ign || botId, ax: bx, ay: by, color: '#fff', weight: 'bold' });
        inWorldPlotted++;
      } else if (bot.proxyState === 'queuing') {
        // A GHOST asset: hollow dashed dim-blue ring at its last-known parked spot, with a
        // live ETA — so the map always shows where the fleet is holding and when it returns.
        const m = (typeof queueMetricsFor === 'function') ? queueMetricsFor(botId) : null;
        const eta = m ? queueEtaMs(m.queue, bot.queuePosition) : null;
        if (eta) nearestEta = Math.min(nearestEta, eta);
        ctx.beginPath(); ctx.arc(bx, by, 5.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${MAP.queue}, 0.14)`; ctx.fill();
        ctx.strokeStyle = `rgba(${MAP.queue}, 0.9)`; ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
        const qp = bot.queuePosition != null ? ` · #${bot.queuePosition}` : '';
        const et = eta ? ` · ${fmtDuration(eta)}` : '';
        mapLabels.push({ text: `${bot.ign || botId}${qp}${et}`, prefix: '◴ ', ax: bx, ay: by, color: `rgb(${MAP.queue})`, weight: 'normal' });
        ghostPlotted++;
      }
    }
    // Standby caption: quiet reads as "on watch". Counts the WHOLE queuing fleet (not just
    // ghosts we could place) with the nearest return ETA — because a queuing bot sits in the
    // End queue room, so it often has no nether/overworld spot to draw a ghost at.
    let queuingCount = 0, fleetEta = Infinity;
    for (const [bid, b] of Object.entries(systemStatus.bots)) {
      if (b.proxyState !== 'queuing') continue;
      queuingCount++;
      const mm = (typeof queueMetricsFor === 'function') ? queueMetricsFor(bid) : null;
      const e = mm ? queueEtaMs(mm.queue, b.queuePosition) : null;
      if (e) fleetEta = Math.min(fleetEta, e);
    }
    if (!isFinite(fleetEta)) fleetEta = nearestEta;
    if (fleetOnWatch && queuingCount) {
      const near = isFinite(fleetEta) ? ` · nearest ETA ${fmtDuration(fleetEta)}` : '';
      ctx.save();
      ctx.font = '11px JetBrains Mono, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillStyle = `rgba(${MAP.cyan}, 0.85)`;
      ctx.fillText(`◴ ON WATCH · ${queuingCount} asset${queuingCount > 1 ? 's' : ''} queuing${near}`, cw / 2, ch - 12);
      ctx.restore();
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
  }

  // ── Draw recent player sightings (Clustered & Live) ──
  if (recentActivity.length > 0) {
    const clusters = [];
    const activePings = [];
    const CLUSTER_RADIUS = 9; // Combine dots only when nearly on top of each other (labels de-collide below)
    const seenExits = new Set();
    
    for (const entry of recentActivity) {
      if (!entry.coords) continue;
      // Replay filter: hide sightings that haven't happened yet at the scrub position.
      // An exit after scrubT is hidden too, so its enter (before scrubT) has no seen
      // exit and re-renders as a live "Active" contact — the pass replays naturally.
      if (scrubActive && new Date(entry.timestamp).getTime() > scrubT) continue;

      if (entry.dimension) {
        const isNether = entry.dimension.includes('nether');
        if (mapDimension === 'nether' && !isNether) continue;
        if (mapDimension === 'overworld' && isNether) continue;
      }
      
      const px = cx + entry.coords.x * scaleMult * s;
      const py = cy + entry.coords.z * scaleMult * s;
      
      // Ignore if extremely far off-screen
      if (px < -100 || px > w + 100 || py < -100 || py > h + 100) continue;
      
      if (entry.direction && entry.direction !== 'Entering') {
        // It's an EXIT event. Mark it seen, and cluster it.
        seenExits.add(entry.playerName);
        
        let addedToCluster = false;
        for (const cluster of clusters) {
          const dist = Math.sqrt(Math.pow(px - cluster.x, 2) + Math.pow(py - cluster.y, 2));
          if (dist <= CLUSTER_RADIUS) {
            cluster.entries.push(entry);
            if (entry.watched) cluster.watched = true;
            addedToCluster = true;
            break;
          }
        }

        if (!addedToCluster) {
          clusters.push({ x: px, y: py, entries: [entry], watched: !!entry.watched });
        }
      } else if (entry.direction === 'Entering') {
        // If we haven't seen an exit for this player, they are currently in the area!
        // Ages against the map clock so a replayed enter is "active" at its own moment.
        const age = mapNow() - new Date(entry.timestamp).getTime();
        if (!seenExits.has(entry.playerName) && age >= 0 && age < 300_000) { // Active if entered within last 5 mins
          activePings.push({ x: px, y: py, entry });
        }
      }
    }
    
    window._mapClusters = clusters;
    _hasActivePings = activePings.length > 0; // drives the continuous pulse loop below
    sightingMarkers = clusters.length + activePings.length;

    // Spread overlapping blips apart so they separate into distinct dots without having
    // to zoom way in. Each is nudged from its true spot (a faint tether shows the real
    // position); the spacing only kicks in when dots would otherwise overlap, so once
    // you're zoomed in enough that they're already apart, nothing moves.
    const blips = [...activePings, ...clusters];
    for (const b of blips) { b.ox = b.x; b.oy = b.y; }
    if (blips.length > 1 && blips.length <= 150) {
      const GAP = 20;
      for (let iter = 0; iter < 40; iter++) {
        let moved = false;
        for (let i = 0; i < blips.length; i++) for (let j = i + 1; j < blips.length; j++) {
          const a = blips[i], c = blips[j];
          let dx = c.x - a.x, dy = c.y - a.y, d = Math.hypot(dx, dy);
          if (d < GAP) {
            if (d < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d = Math.hypot(dx, dy) || 1; }
            const push = (GAP - d) / 2, ux = dx / d, uy = dy / d;
            a.x -= ux * push; a.y -= uy * push; c.x += ux * push; c.y += uy * push;
            moved = true;
          }
        }
        if (!moved) break;
      }
    }

    const DIRV = { 'N': { x: 0, y: -1 }, 'S': { x: 0, y: 1 }, 'E': { x: 1, y: 0 }, 'W': { x: -1, y: 0 },
      'NE': { x: 1, y: -1 }, 'NW': { x: -1, y: -1 }, 'SE': { x: 1, y: 1 }, 'SW': { x: -1, y: 1 } };
    const drawArrow = (px, py, vec, len, rgb, alpha) => {
      const vlen = Math.hypot(vec.x, vec.y) || 1, ux = vec.x / vlen, uy = vec.y / vlen;
      const hx = px + ux * len, hy = py + uy * len, pa = Math.atan2(uy, ux);
      ctx.strokeStyle = `rgba(${rgb}, ${alpha})`; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(px + ux * 9, py + uy * 9); ctx.lineTo(hx, hy); ctx.stroke();
      ctx.fillStyle = `rgba(${rgb}, ${alpha})`;
      ctx.beginPath(); ctx.moveTo(hx, hy);
      ctx.lineTo(hx - Math.cos(pa - 0.42) * 6, hy - Math.sin(pa - 0.42) * 6);
      ctx.lineTo(hx - Math.cos(pa + 0.42) * 6, hy - Math.sin(pa + 0.42) * 6);
      ctx.closePath(); ctx.fill();
    };

    // Draw Live Active Contacts — expanding targeting reticle, gear-wealth-coloured.
    for (const ping of activePings) {
      const age = mapNow() - new Date(ping.entry.timestamp).getTime();
      const pulse = (Math.sin(age / 200) + 1) / 2;
      const watched = ping.entry.watched;
      const rgb = watched ? MAP.watched : wealthColor(entryGearWealth(ping.entry));

      if (Math.hypot(ping.x - ping.ox, ping.y - ping.oy) > 1.5) {
        ctx.strokeStyle = 'rgba(255,255,255,.16)'; ctx.lineWidth = 0.75;
        ctx.beginPath(); ctx.moveTo(ping.ox, ping.oy); ctx.lineTo(ping.x, ping.y); ctx.stroke();
      }
      // reticle ring + cardinal ticks (pulsing)
      const rr = 12 + pulse * 8;
      ctx.strokeStyle = `rgba(${rgb}, ${0.5 + pulse * 0.4})`; ctx.lineWidth = 1.25;
      ctx.beginPath(); ctx.arc(ping.x, ping.y, rr, 0, Math.PI * 2); ctx.stroke();
      for (let a = 0; a < 4; a++) { const an = a * Math.PI / 2; ctx.beginPath();
        ctx.moveTo(ping.x + Math.cos(an) * (rr - 3), ping.y + Math.sin(an) * (rr - 3));
        ctx.lineTo(ping.x + Math.cos(an) * (rr + 3), ping.y + Math.sin(an) * (rr + 3)); ctx.stroke(); }
      // core
      ctx.beginPath(); ctx.arc(ping.x, ping.y, 5, 0, Math.PI * 2); ctx.fillStyle = `rgb(${rgb})`; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
      mapLabels.push({ text: ping.entry.playerName + ' (Active)', prefix: watched ? '👁 ' : '', ax: ping.x, ay: ping.y, color: watched ? '#fcd34d' : '#fff', weight: 'bold' });
    }

    // Draw Clustered Exits — reticle marker, gear-wealth-coloured, faded by recency, arrow
    // length scaled by speed. A day-old pass is faint; a fresh geared rival is bright + red.
    for (const cluster of clusters) {
      let latestDirection = null, wealth = 0, freshest = Infinity, speed = 0;
      for (const e of cluster.entries) {
        if (!latestDirection && e.direction && e.direction !== 'Entering') latestDirection = e.direction;
        wealth = Math.max(wealth, entryGearWealth(e));
        freshest = Math.min(freshest, mapNow() - new Date(e.timestamp).getTime());
        if (e.speed) speed = Math.max(speed, e.speed);
      }
      const watched = cluster.watched;
      const rgb = watched ? MAP.watched : wealthColor(wealth);
      const al = recencyAlpha(mapNow() - freshest);         // fade older passes
      const cHex = `rgba(${rgb}, ${al})`;

      if (Math.hypot(cluster.x - cluster.ox, cluster.y - cluster.oy) > 1.5) {
        ctx.strokeStyle = `rgba(255,255,255,${0.16 * al})`; ctx.lineWidth = 0.75;
        ctx.beginPath(); ctx.moveTo(cluster.ox, cluster.oy); ctx.lineTo(cluster.x, cluster.y); ctx.stroke();
      }
      ctx.strokeStyle = `rgba(${rgb}, ${0.5 * al})`; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cluster.x, cluster.y, 11, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(cluster.x, cluster.y, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${rgb}, ${0.9 * al})`; ctx.fill();
      ctx.strokeStyle = `rgba(255,255,255,${al})`; ctx.lineWidth = 1.5; ctx.stroke();

      if (cluster.entries.length > 1) {
        ctx.fillStyle = `rgba(255,255,255,${al})`; ctx.font = 'bold 9px Inter, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(cluster.entries.length, cluster.x, cluster.y + 3);
        mapLabels.push({ text: cluster.entries[0].playerName + ' +' + (cluster.entries.length - 1), prefix: watched ? '👁 ' : '', ax: cluster.x, ay: cluster.y, color: cHex, weight: 'bold' });
      } else if (cluster.entries[0].playerName) {
        mapLabels.push({ text: cluster.entries[0].playerName, prefix: watched ? '👁 ' : '', ax: cluster.x, ay: cluster.y, color: cHex, weight: 'bold' });
      }

      if (latestDirection && DIRV[latestDirection.toUpperCase()]) {
        drawArrow(cluster.x, cluster.y, DIRV[latestDirection.toUpperCase()], 14 + Math.min(speed, 40) / 40 * 16, rgb, al);
      }
    }
  }

  placeMapLabels(ctx, mapLabels);

  ctx.restore();

  // The map animates while there are live pings, an in-world asset (breathing), or the
  // fleet is on watch (radar sweep). Ghost markers keep the map non-empty, so the big
  // text overlay only shows when there's truly nothing to draw.
  _mapAnimate = _hasActivePings && !scrubActive;
                                   // only transient live-contact pulses drive the rAF loop; the
                                   // idle sweep is CSS, so the page can reach idle (no CPU peg).
                                   // While scrubbing, playback's own timer drives renders (and a
                                   // paused replay is a static frame — nothing to animate).
  // Hide the big text overlay whenever there's something to look at OR the fleet is on watch
  // (the radar sweep + "ON WATCH" caption convey the quiet state better than a paragraph).
  updateMapOverlay(inWorldPlotted + sightingMarkers + ghostPlotted + (fleetOnWatch ? 1 : 0));
  // Keep a gentle animation running only while live pings are on screen and the
  // Overview is visible, so the "Active" pulse actually pulses instead of freezing
  // between events. It self-stops once no active pings remain.
  const overviewVisible = (document.getElementById('main') || {}).style && document.getElementById('main').style.display !== 'none';
  if (_mapAnimate && overviewVisible && !_pulseRAF) {
    _pulseRAF = requestAnimationFrame(_pulseTick);
  }
}

/** ~15fps repaint loop that runs while the map wants animation — live pings, the radar
 *  sweep, or breathing ghost markers (see _renderMapImpl). Self-stops when idle/hidden. */
function _pulseTick(ts) {
  _pulseRAF = null;
  if (!_mapAnimate) return;
  if (document.getElementById('main').style.display === 'none') return;
  if (ts - _pulseLast > 66) { _pulseLast = ts; renderMap(); }
  else if (!_pulseRAF) { _pulseRAF = requestAnimationFrame(_pulseTick); }
}

/** Show/hide the explanatory overlay on the (often empty) Overview map. Shown only
 *  when nothing at all was plotted (no in-world bots and no player sightings). */
function updateMapOverlay(markersDrawn) {
  const ov = document.getElementById('map-empty-overlay');
  if (!ov) return;
  // Never during a replay: a quiet scrubbed moment is expected, and the live-state
  // explanations ("all bots are queuing…") would be wrong for a historical view.
  if (scrubActive) { ov.classList.add('hidden'); return; }
  if (markersDrawn > 0) { ov.classList.add('hidden'); return; }
  let msg;
  if (can(1) && systemStatus && systemStatus.bots && Object.keys(systemStatus.bots).length) {
    const q = Object.values(systemStatus.bots).filter(b => b.proxyState === 'queuing').length;
    msg = q
      ? 'All bots are queuing — the map populates when a bot reaches the world.'
      : 'No bots are in-world right now — the map populates when a bot reaches the world.';
  } else {
    msg = 'No bots are in-world right now — the map populates when a bot reaches the world. Player sightings still appear as they happen.';
  }
  ov.textContent = msg; // textContent → inert (no HTML injection)
  ov.classList.remove('hidden');
}

/** Lay out collected map labels avoiding overlap: each sits to the right of its marker,
 *  nudged vertically (fanning out) until it clears already-placed labels, with a thin
 *  leader line back to the marker when offset. Keeps names readable when markers bunch
 *  up on a highway, without having to zoom in. */
function placeMapLabels(ctx, labels) {
  if (!labels.length) return;
  ctx.textBaseline = 'alphabetic';
  const LH = 14, placed = [];
  labels.sort((a, b) => a.ay - b.ay);
  for (const L of labels) {
    ctx.font = (L.weight ? L.weight + ' ' : '') + '10px Inter, sans-serif';
    const text = (L.prefix || '') + L.text;
    const tw = ctx.measureText(text).width;
    const bx = L.ax + 11;
    let by = L.ay + 3, ok = false;
    for (let k = 0; k < 80 && !ok; k++) {
      const cand = L.ay + 3 + (k === 0 ? 0 : Math.ceil(k / 2) * LH * (k % 2 ? 1 : -1));
      const box = { x1: bx - 3, y1: cand - 10, x2: bx + tw + 3, y2: cand + 4 };
      if (!placed.some(p => box.x1 < p.x2 && box.x2 > p.x1 && box.y1 < p.y2 && box.y2 > p.y1)) { by = cand; placed.push(box); ok = true; }
    }
    if (!ok) placed.push({ x1: bx - 3, y1: by - 10, x2: bx + tw + 3, y2: by + 4 });
    if (Math.abs(by - (L.ay + 3)) > 5) {
      ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 0.75;
      ctx.beginPath(); ctx.moveTo(L.ax + 7, L.ay); ctx.lineTo(bx - 2, by - 3); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(8,8,13,.6)'; ctx.fillRect(bx - 3, by - 10, tw + 6, 13);
    ctx.fillStyle = L.color; ctx.textAlign = 'left'; ctx.fillText(text, bx, by);
  }
}

// ── Time scrubber controls (map replay) ────────────────────
function setupScrubber() {
  const bar = document.getElementById('time-scrub');
  const slider = document.getElementById('scrub-slider');
  const playBtn = document.getElementById('scrub-play');
  const label = document.getElementById('scrub-label');
  const liveBtn = document.getElementById('scrub-live');
  if (!bar || !slider || !playBtn || !label || !liveBtn) return;

  // The replayable window: the map's time-filter span; for 'all', the actual extent
  // of the loaded activity (fall back to the last hour when there's nothing yet).
  const range = () => {
    const now = Date.now();
    const span = { '1h': 3600e3, '24h': 86400e3, '7d': 604800e3 }[document.getElementById('time-filter').value];
    if (span) return { start: now - span, end: now };
    let start = now - 3600e3;
    for (const e of recentActivity) { const t = new Date(e.timestamp).getTime(); if (isFinite(t) && t < start) start = t; }
    return { start, end: now };
  };

  const fmt = t => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const sync = () => {
    bar.classList.toggle('scrubbing', scrubActive);
    playBtn.textContent = scrubPlaying ? '⏸' : '▶';
    playBtn.title = scrubPlaying ? 'Pause the replay' : 'Replay the selected range on the map';
    liveBtn.style.display = scrubActive ? '' : 'none';
    label.textContent = scrubActive ? fmt(scrubT) : 'LIVE';
  };
  const stopPlaying = () => { scrubPlaying = false; if (_scrubTimer) { clearInterval(_scrubTimer); _scrubTimer = null; } };
  const goLive = () => { stopPlaying(); scrubActive = false; slider.value = '1000'; sync(); renderMap(); };
  const setScrub = (t, fromSlider) => {
    const { start, end } = range();
    scrubT = Math.max(start, Math.min(end, t));
    scrubActive = true;
    if (!fromSlider) slider.value = String(Math.round(((scrubT - start) / Math.max(1, end - start)) * 1000));
    sync(); renderMap();
  };

  slider.addEventListener('input', () => {
    stopPlaying(); // a manual drag takes over from ▶
    const frac = (+slider.value) / 1000;
    if (frac >= 1) { goLive(); return; } // the right edge IS the live view
    const { start, end } = range();
    setScrub(start + frac * (end - start), true);
  });

  playBtn.addEventListener('click', () => {
    if (scrubPlaying) { stopPlaying(); sync(); return; }
    const { start, end } = range();
    if (!scrubActive || scrubT >= end - 1000) setScrub(start); // restart from the range start
    scrubPlaying = true;
    const TICK = 66; // ~15fps, same cadence as the map's pulse loop
    const step = (end - start) * (TICK / SCRUB_SWEEP_MS);
    _scrubTimer = setInterval(() => {
      if (scrubT + step >= Date.now()) { goLive(); return; } // swept up to the live edge
      setScrub(scrubT + step);
    }, TICK);
    sync();
  });

  liveBtn.addEventListener('click', goLive);
  // Changing the time filter changes the replay window — drop back to live.
  document.getElementById('time-filter').addEventListener('change', goLive);
}

// ── Map Controls ───────────────────────────────────────────
function setupControls() {
  document.getElementById('dim-nether').addEventListener('click', () => {
    mapDimension = 'nether';
    document.getElementById('dim-nether').classList.add('active');
    document.getElementById('dim-overworld').classList.remove('active');
    // Re-FRAME the newly selected dimension instead of jamming a fixed tiny scale
    // (0.01 ≈ ±1k around spawn), which left the ~100k highway bots/sightings far
    // off-screen → empty map + a false "all bots are queuing" overlay. fitToContent
    // frames the action (in-dim bots + sightings, floor 30k) centered on spawn.
    _userMovedMap = false;
    fitToContent();
  });

  document.getElementById('dim-overworld').addEventListener('click', () => {
    mapDimension = 'overworld';
    document.getElementById('dim-overworld').classList.add('active');
    document.getElementById('dim-nether').classList.remove('active');
    _userMovedMap = false;
    fitToContent();
  });

  // Shared zoom actions, reused by both the header controls and the on-screen
  // (thumb-reachable) overlay buttons on the map.
  const mapZoomBy = (factor) => { _userMovedMap = true; mapScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, mapScale * factor)); renderMap(); };
  const fitMapBorder = () => {
    const canvas = document.getElementById('nether-map');
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.width / dpr;
    const ch = canvas.height / dpr;
    const scaleMult = mapDimension === 'overworld' ? 8 : 1;
    // Nether border ±3.75M blocks; fit the full diameter into the smaller axis
    const borderBlocks = 3750000 * scaleMult;
    mapScale = (Math.min(cw, ch) * 0.9) / (borderBlocks * 2) / 100;
    mapScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, mapScale));
    mapOffsetX = 0; mapOffsetY = 0;
    renderMap();
  };
  const bindClick = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };

  // (Header zoom-in/out/fit removed — zoom lives on the map overlay + wheel/pinch;
  //  only the content-aware reset stays in the header.)
  bindClick('map-heat', () => { mapHeat = !mapHeat; const b = document.getElementById('map-heat'); if (b) b.classList.toggle('active', mapHeat); renderMap(); });
  // Radar-sweep toggle — persisted, so switching it off survives reloads.
  const radarBtn = document.getElementById('map-radar-toggle');
  if (radarBtn) {
    radarBtn.classList.toggle('active', mapRadar); // reflect the persisted preference on load
    radarBtn.addEventListener('click', () => {
      mapRadar = !mapRadar;
      localStorage.setItem('mapRadar', mapRadar ? 'on' : 'off');
      radarBtn.classList.toggle('active', mapRadar);
      renderMap();
    });
  }

  // Activity feed click-to-focus: one delegated listener; the position rides on the
  // item's data-* attributes (see renderActivityFeed).
  const feed = document.getElementById('activity-feed');
  if (feed) {
    feed.addEventListener('click', (e) => {
      const item = e.target.closest && e.target.closest('.activity-item.clickable');
      if (!item) return;
      focusMapOn(+item.dataset.x, +item.dataset.z, item.dataset.dim || '', item.dataset.name || '');
    });
  }
  // Reset = frame spawn + your bases (content-aware), not a fixed empty zoom.
  bindClick('zoom-reset', () => { _userMovedMap = false; fitToContent(); });   // resume auto-framing

  // On-screen zoom controls overlaid on the canvases (essential on touch).
  bindClick('map-zoom-in', () => mapZoomBy(1.4));
  bindClick('map-zoom-out', () => mapZoomBy(0.6));
  bindClick('map-zoom-fit', fitMapBorder);
  bindClick('carto-zoom-in', () => cartoZoomBy(1.25));
  bindClick('carto-zoom-out', () => cartoZoomBy(0.8));
  bindClick('carto-zoom-fit', () => { fitCarto(); drawCarto(); });

  document.getElementById('clear-activity').addEventListener('click', () => {
    recentActivity = [];
    renderActivityFeed();
  });

  const delApply = document.getElementById('del-apply');
  if (delApply) {
    delApply.addEventListener('click', async () => {
      const beforeDays = parseInt(document.getElementById('del-range').value, 10) || 0;
      const spot = document.getElementById('del-spot').value;
      const scope = `${spot || 'all spots'}, ${beforeDays ? `older than ${beforeDays}d` : 'all time'}`;
      if (!confirm(`Permanently delete stored activity (${scope})? This cannot be undone.`)) return;
      const params = new URLSearchParams();
      if (spot) params.set('spot', spot);
      if (beforeDays) params.set('beforeDays', String(beforeDays));
      try {
        const res = await apiFetch(`/api/activity?${params.toString()}`, { method: 'DELETE' });
        const data = await res.json();
        recentActivity = [];
        renderActivityFeed();
        renderMap();
        fetchActivity();
        showToast(`Deleted ${data.removed} activity file(s).`);
      } catch (e) {
        showToast(e.message, 'error');
      }
    });
  }

  // New group
  const newGroupBtn = document.getElementById('btn-new-group');
  if (newGroupBtn) newGroupBtn.addEventListener('click', newGroup);

  // Group create/edit modal controls
  const gmSave = document.getElementById('gm-save');
  if (gmSave) gmSave.addEventListener('click', submitGroupModal);
  const gmCancel = document.getElementById('gm-cancel');
  if (gmCancel) gmCancel.addEventListener('click', closeGroupModal);
  const gmOverlay = document.getElementById('group-modal');
  if (gmOverlay) gmOverlay.addEventListener('click', (e) => { if (e.target === gmOverlay) closeGroupModal(); });
  ['gm-name', 'gm-x', 'gm-z', 'gm-desired'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitGroupModal(); });
  });

  // Tabs (Dashboard / Intel / Metrics / Settings / Admin)
  const VIEWS = { dashboard: 'main', intel: 'intel-view', carto: 'carto-view', metrics: 'metrics-view', coverage: 'coverage-view', settings: 'settings-view', admin: 'admin-view' };
  const showTab = (which) => {
    for (const [key, id] of Object.entries(VIEWS)) {
      const el = document.getElementById(id);
      if (el) el.style.display = (key === which) ? '' : 'none';
      const tab = document.getElementById('tab-' + key);
      if (tab) { tab.classList.toggle('active', key === which); tab.setAttribute('aria-selected', key === which ? 'true' : 'false'); }
    }
    // KPI strip is Overview-only, and bot counts are trusted+ (viewers get map+activity only).
    const kpi = document.getElementById('kpi-strip');
    if (kpi) kpi.style.display = (which === 'dashboard' && can(1)) ? '' : 'none';
    // Metrics auto-refreshes while open; stop the timer when leaving.
    if (which !== 'metrics' && _metricsTimer) { clearInterval(_metricsTimer); _metricsTimer = null; }
    if (which === 'settings') loadSettings();
    else if (which === 'admin') loadUsers();
    else if (which === 'intel') loadIntel();
    else if (which === 'carto') loadCartography();
    else if (which === 'coverage') renderCoverage();
    else if (which === 'metrics') { loadMetrics(); if (!_metricsTimer) _metricsTimer = setInterval(loadMetrics, 15000); }
    else renderMap();
  };
  Object.keys(VIEWS).forEach(k => {
    const t = document.getElementById('tab-' + k);
    if (t) t.addEventListener('click', () => showTab(k));
  });

  // KPI click-throughs: each card jumps to the surface that explains its number.
  // (Enter/Space too — the cards carry tabindex for keyboard operators.)
  const kpiJump = (id, fn) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', fn);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
  };
  kpiJump('kpi-hero', () => {
    const q = document.getElementById('queue-panel');
    if (q) { q.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); q.classList.add('flash'); setTimeout(() => q.classList.remove('flash'), 1200); }
  });
  kpiJump('kpi-card-seen', () => {
    const a = document.getElementById('activity-panel');
    if (a) { a.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); a.classList.add('flash'); setTimeout(() => a.classList.remove('flash'), 1200); }
  });
  kpiJump('kpi-card-wealth', () => {
    if (!can(1)) return;
    intelTargetsOnly = true;                      // land on the filtered "targets" view
    const tt = document.getElementById('intel-targets');
    if (tt) { tt.classList.add('on'); tt.setAttribute('aria-pressed', 'true'); }
    showTab('intel');
  });

  // Intel controls
  ['intel-range', 'intel-sort'].forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('change', loadIntel); });
  const intelRefresh = document.getElementById('intel-refresh');
  if (intelRefresh) intelRefresh.addEventListener('click', loadIntel);
  const intelSearch = document.getElementById('intel-search');
  if (intelSearch) intelSearch.addEventListener('input', renderIntel);
  const intelTargets = document.getElementById('intel-targets');
  if (intelTargets) intelTargets.addEventListener('click', () => {
    intelTargetsOnly = !intelTargetsOnly;
    intelTargets.classList.toggle('on', intelTargetsOnly);
    intelTargets.setAttribute('aria-pressed', intelTargetsOnly ? 'true' : 'false');
    renderIntel(); // client-side filter — no reload
  });

  // Metrics controls
  const metricsRange = document.getElementById('metrics-range');
  if (metricsRange) metricsRange.addEventListener('change', loadMetrics);
  const metricsRefresh = document.getElementById('metrics-refresh');
  if (metricsRefresh) metricsRefresh.addEventListener('click', loadMetrics);

  // Cartography controls
  const cartoDim = document.getElementById('carto-dim');
  if (cartoDim) cartoDim.addEventListener('change', () => { cartoView.init = false; loadCartography(); });
  const cartoRefresh = document.getElementById('carto-refresh');
  if (cartoRefresh) cartoRefresh.addEventListener('click', loadCartography);
  const cartoFit = document.getElementById('carto-fit');
  if (cartoFit) cartoFit.addEventListener('click', () => { fitCarto(); drawCarto(); });
  const cartoTerrainCb = document.getElementById('carto-terrain');
  if (cartoTerrainCb) cartoTerrainCb.addEventListener('change', e => { cartoTerrain = e.target.checked; drawCarto(); });
  const cartoFile = document.getElementById('carto-file');
  if (cartoFile) cartoFile.addEventListener('change', (e) => { if (e.target.files[0]) uploadCartography(e.target.files[0]); e.target.value = ''; });
  const cartoSort = document.getElementById('carto-sort');
  if (cartoSort) cartoSort.addEventListener('change', renderCandidates);
  const cartoFilter = document.getElementById('carto-filter');
  if (cartoFilter) cartoFilter.addEventListener('change', renderCandidates);
  const cartoExport = document.getElementById('carto-export');
  if (cartoExport) cartoExport.addEventListener('click', exportWaypoints);

  const addUserBtn = document.getElementById('btn-add-user');
  if (addUserBtn) addUserBtn.addEventListener('click', addUserUI);
  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) logoutBtn.addEventListener('click', logout);

  // Settings
  document.getElementById('whitelist-add').addEventListener('click', () => {
    const inp = document.getElementById('whitelist-input');
    const v = inp.value.trim();
    if (v && !whitelistDraft.some(x => x.toLowerCase() === v.toLowerCase())) {
      whitelistDraft.push(v); inp.value = ''; renderWhitelist();
    }
  });
  document.getElementById('watchlist-add').addEventListener('click', () => {
    const inp = document.getElementById('watchlist-input');
    const v = inp.value.trim();
    if (v && !watchlistDraft.some(x => x.toLowerCase() === v.toLowerCase())) {
      watchlistDraft.push(v); inp.value = ''; renderWatchlist();
    }
  });
  document.getElementById('proxywl-add').addEventListener('click', () => {
    const inp = document.getElementById('proxywl-input');
    const v = inp.value.trim();
    if (v && !proxyWlDraft.some(x => x.toLowerCase() === v.toLowerCase())) {
      proxyWlDraft.push(v); inp.value = ''; renderProxyWl();
    }
  });
  document.getElementById('settings-save').addEventListener('click', saveSettings);

  // Add account — kicks off the Microsoft device-code login (no inputs).
  document.getElementById('btn-add-account').addEventListener('click', async () => {
    const statusEl = document.getElementById('add-account-status');
    statusEl.innerHTML = '⏳ Starting login…';
    try {
      const res = await apiFetch('/api/accounts/add', { method: 'POST' });
      const data = await res.json();
      if (!data.success) {
        statusEl.innerHTML = `<span style="color:#ef4444">${escapeHtml(data.error || 'Failed')}</span>`;
      }
      // The device code arrives via the 'device_code' websocket message.
    } catch (e) {
      statusEl.innerHTML = `<span style="color:#ef4444">Error: ${escapeHtml(e.message)}</span>`;
    }
  });
}

// Show the Microsoft device-code prompt in the Add Account panel.
function showDeviceCode(msg) {
  const el = document.getElementById('add-account-status');
  if (!el) return;
  el.innerHTML =
    `<div style="padding:10px;border:1px solid #3b82f6;border-radius:6px">
      <div>1. Open <a href="${escapeHtml(msg.url)}" target="_blank" style="color:#3b82f6">${escapeHtml(msg.url)}</a></div>
      <div style="margin-top:6px">2. Enter code: <b style="font-size:18px;letter-spacing:2px">${escapeHtml(msg.code)}</b></div>
      <div style="margin-top:6px;opacity:.6;font-size:12px">3. Sign in with the Minecraft account you want to add.</div>
    </div>`;
}

// Delete the sightings in the clicked map cluster from stored activity.
async function deleteSelectedSightings() {
  const entries = window._selectedClusterEntries || [];
  if (!entries.length) return;
  if (!confirm(`Permanently delete ${entries.length} sighting(s) from stored data? This cannot be undone.`)) return;
  const payload = entries
    .filter(e => e.spotId && e.timestamp)
    .map(e => ({ spotId: e.spotId, timestamp: e.timestamp, playerName: e.playerName }));
  try {
    const res = await apiFetch('/api/activity/entries', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: payload }),
    });
    const data = await res.json();
    const tip = document.getElementById('map-tooltip');
    if (tip) tip.classList.add('hidden');
    window._tooltipPinned = false;   // the pinned tooltip is gone with its clusters
    await fetchActivity();
    renderMap();
    showToast(`Deleted ${data.removed} sighting(s).`);
  } catch (e) {
    showToast(e.message, 'error');
  }
}

// ── Bot Actions ────────────────────────────────────────────

// Mark a bot placed (mineflayer connects + monitors) or release it (so you can
// drive it to its spot via ZenithProxy).
async function setPlaced(botId, placed) {
  if (!placed && !confirm(`Release ${botId}? Mineflayer will disconnect so you can drive it manually.`)) {
    return;
  }
  try {
    await apiFetch(`/api/bots/${botId}/placed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ placed }),
    });
    setTimeout(fetchStatus, 1000);
  } catch (e) {
    showToast(e.message, 'error');
  }
}

// Permanently delete an account from the system (stops its monitor + ZenithProxy,
// removes it from accounts, groups, and state).
async function deleteBot(botId) {
  const name = (systemStatus.bots[botId] && systemStatus.bots[botId].ign) || botId;
  if (!confirm(`Delete account "${name}" from the system? This stops it and removes it from all groups. (It will need re-adding + a fresh login to use again.)`)) {
    return;
  }
  try {
    const res = await apiFetch(`/api/accounts/${botId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed');
    setTimeout(fetchStatus, 800);
  } catch (e) {
    showToast(e.message, 'error');
  }
}

// ── Uptime ─────────────────────────────────────────────────
function updateUptime() {
  if (!systemStatus) return;
  const seconds = Math.floor(systemStatus.uptime || 0);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  document.getElementById('uptime-badge').textContent =
    `Uptime: ${h}h ${m}m ${s}s`;
  // Increment locally ONLY while the socket is live — during a disconnect the
  // snapshot is frozen, so advancing uptime would fake liveness on stale data.
  if (wsAlive && systemStatus.uptime !== undefined) {
    systemStatus.uptime++;
  }
}

/** Freshness heartbeat — "LIVE · 3s" while the socket streams; "STALE · 4m" when
 *  down. Answers "can I trust what I'm looking at?" at a glance. */
function updateFreshBadge() {
  const el = document.getElementById('fresh-badge');
  if (!el) return;
  if (!_lastDataAt) { el.textContent = '—'; return; }
  const age = Date.now() - _lastDataAt;
  const s = Math.floor(age / 1000);
  const label = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
  el.textContent = (wsAlive ? 'LIVE · ' : 'STALE · ') + label;
  el.style.color = wsAlive ? 'var(--state-inworld)' : 'var(--state-warn)';
}

// ── Utility ────────────────────────────────────────────────
// Escapes &, <, > (via textContent) AND both quote characters, so a value is
// safe both as element text and when interpolated into a quoted HTML attribute
// (e.g. the single-quoted onclick strings the chip/list renders build). External
// player names have always been escaped here; the quote-escaping additionally
// closes the admin-entered watchlist/whitelist self-XSS seam (a stray ' or ").
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
