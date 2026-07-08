/**
 * dashboard/server.js — Express + WebSocket server for the web dashboard.
 * Login + role-based access control: viewer (read) < trusted (manage bots) <
 * admin (accounts, MFA, settings, users). Roles are enforced here on the server,
 * not just hidden in the UI.
 */
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const config = require('../config');
const { systemLogger } = require('../logging/Logger');
const auth = require('../auth/Auth');
const XaeroDecoder = require('../cartography/XaeroDecoder');
const wealth = require('../metrics/WealthEstimator');

class DashboardServer {
  /**
   * @param {object} orchestrator - The main orchestrator instance
   */
  constructor(orchestrator) {
    this.orchestrator = orchestrator;
    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocket.Server({ server: this.server });
    this.clients = new Set();
    this._loginFails = new Map();     // ip → { n, until } for per-IP login throttling
    this._loginFailsUser = new Map(); // username → { n, until } for per-account throttling (rotating-IP defense)
    this._uploadInFlight = false;     // one cartography upload at a time (RAM guard on the small VPS)

    this._setupMiddleware();
    this._setupRoutes();
    this._setupWebSocket();
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.server.listen(config.dashboard.port, config.dashboard.host, () => {
        systemLogger.info(`Dashboard running at http://${config.dashboard.host}:${config.dashboard.port}`);
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  /** Read a cookie value from a request. */
  _cookie(req, name) {
    const raw = req.headers && req.headers.cookie;
    if (!raw) return null;
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return null;
  }

  /** Client IP. Only honours X-Forwarded-For when explicitly behind a trusted
   *  proxy (else a client could spoof it); otherwise uses the real socket IP. */
  _clientIp(req) {
    let ip = req.socket && req.socket.remoteAddress;
    if (config.dashboard.trustProxy) {
      ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || ip;
    }
    return String(ip || '').replace(/^::ffff:/, '');
  }

  /** Express guard: require the session's role level >= `level`. */
  _requireLevel(level) {
    return (req, res, next) => {
      if (!req.user || auth.level(req.user.role) < level) {
        return res.status(403).json({ error: 'Forbidden — your role lacks permission for this action.' });
      }
      next();
    };
  }

  /** Build the sid Set-Cookie string. The `Secure` attribute is gated on
   *  COOKIE_SECURE=true and defaults OFF so the current plain-HTTP prod login
   *  keeps working; flip it on once the planned TLS front (Caddy/Cloudflare)
   *  terminates HTTPS ahead of the dashboard. HttpOnly + SameSite=Lax always. */
  _sidCookie(token, maxAge) {
    const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
    return `sid=${token}; HttpOnly; SameSite=Lax; Path=/${secure}; Max-Age=${maxAge}`;
  }

  /** Defense-in-depth CSRF guard. SameSite=Lax is the primary defense; this
   *  additionally requires that any browser-supplied Origin match the request
   *  Host (same-origin) or an allowlisted origin (DASHBOARD_ORIGINS, e.g. the
   *  planned TLS hostname). Requests with no Origin (curl, same-origin GET) pass. */
  _originOk(req) {
    const origin = req.headers && req.headers.origin;
    if (!origin) return true;
    let host;
    try { host = new URL(origin).host; } catch (e) { return false; } // malformed Origin → reject
    if (host === req.headers.host) return true;
    const allow = (process.env.DASHBOARD_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    return allow.includes(host) || allow.includes(origin);
  }

  /** Record a failed login against a throttle map (per-IP or per-username) and
   *  arm a 15-min lockout after 5 strikes. Opportunistically evicts stale entries
   *  so a stream of unique scanner keys can't grow the map unbounded. */
  _noteLoginFail(map, key, now) {
    if (map.size > 500) {
      for (const [k, v] of map) if ((v.exp || 0) < now) map.delete(k);
    }
    const f = map.get(key) || { n: 0, until: 0 };
    f.n++;
    f.exp = now + 15 * 60000;                              // self-expire 15 min after last attempt
    if (f.n >= 5) { f.until = now + 15 * 60000; f.n = 0; } // 5 fails → 15 min lockout
    map.set(key, f);
  }

  _setupMiddleware() {
    // Security headers — defense-in-depth. escapeHtml is the primary XSS guard for
    // the attacker-controlled player names we render; these are the seatbelt. CSP
    // allows 'unsafe-inline' for scripts because the UI uses inline onclick handlers,
    // but still locks default/frame/base/connect sources and blocks framing.
    this.app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
      res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: https:",
        "connect-src 'self' ws: wss:",
        "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'",
      ].join('; '));
      next();
    });

    this.app.use(express.json({ limit: '4mb' })); // cartography ingest batches carry per-chunk data

    // Resolve the session for every request. Static assets + /api/login are open;
    // every other /api route requires a valid session.
    this.app.use((req, res, next) => {
      req.user = auth.verifyToken(this._cookie(req, 'sid'));
      if (req.user) auth.touchIp(req.user.username, this._clientIp(req)); // log new IPs (sharing)
      // CSRF defense-in-depth: reject cross-origin state-changing requests. SameSite=Lax
      // is the primary guard; this closes the gap if a browser ever attaches the cookie.
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && !this._originOk(req)) {
        return res.status(403).json({ error: 'Cross-origin request rejected' });
      }
      if (!req.path.startsWith('/api/') || req.path === '/api/login') return next();
      if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
      next();
    });

    this.app.use(express.static(path.join(__dirname, 'public')));
  }

  _setupRoutes() {
    const trusted = this._requireLevel(1); // manage bots/groups/activity
    const admin = this._requireLevel(2);   // accounts, MFA, settings, users
    // One cartography upload at a time: the raw body is buffered whole in RAM, so a
    // couple of concurrent 40MB uploads could OOM the small VPS. Runs before
    // express.raw so a rejected upload never buffers its body. 429 = retry shortly.
    const uploadGuard = (req, res, next) => {
      if (this._uploadInFlight) return res.status(429).json({ error: 'Another upload is in progress — try again in a moment.' });
      this._uploadInFlight = true;
      const done = () => { this._uploadInFlight = false; };
      res.on('finish', done);
      res.on('close', done);
      next();
    };

    // ── Auth ──
    this.app.post('/api/login', (req, res) => {
      const ip = this._clientIp(req);
      const { username, password } = req.body || {};
      const uname = String(username || '').trim().toLowerCase();
      const now = Date.now();
      // Lock out on EITHER a per-IP or a per-username 5-strike breach: the per-IP
      // brake stops a single host; the per-username brake stops an attacker rotating
      // IPs against one account (and avoids the shared-NAT self-lockout a per-IP-only
      // scheme causes). Report the longer of the two remaining waits.
      const locks = [this._loginFails.get(ip), this._loginFailsUser.get(uname)].filter(r => r && r.until > now);
      if (locks.length) {
        const until = Math.max(...locks.map(r => r.until));
        return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil((until - now) / 60000)} min.` });
      }
      const user = auth.authenticate(uname, password);
      if (!user) {
        this._noteLoginFail(this._loginFails, ip, now);
        this._noteLoginFail(this._loginFailsUser, uname, now);
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      this._loginFails.delete(ip);
      this._loginFailsUser.delete(uname);
      auth.recordLogin(user.username, ip);
      const token = auth.createToken(user);
      res.setHeader('Set-Cookie', this._sidCookie(token, 7 * 24 * 3600));
      res.json({ username: user.username, role: user.role });
    });
    this.app.post('/api/logout', (req, res) => {
      // Real server-side revocation: bump the user's tokenEpoch so every outstanding
      // 7-day token they hold is rejected by verifyToken — not just this cookie cleared.
      if (req.user) auth.bumpTokenEpoch(req.user.username);
      res.setHeader('Set-Cookie', this._sidCookie('', 0));
      res.json({ success: true });
    });
    this.app.get('/api/me', (req, res) => {
      if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
      res.json(req.user);
    });

    // ── User management (admin+; owner-only powers enforced in Auth by actor role) ──
    // Every call passes req.user.role so Auth can wall an admin off from owner
    // accounts, the owner role grant, and login-IP history (owner-only).
    this.app.get('/api/users', admin, (req, res) => res.json(auth.listUsers(req.user.role)));
    this.app.post('/api/users', admin, (req, res) => {
      try { const { username, password, role } = req.body || {}; res.json(auth.addUser(username, password, role, req.user.role)); }
      catch (e) { res.status(400).json({ error: e.message }); }
    });
    this.app.patch('/api/users/:username', admin, (req, res) => {
      try { res.json(auth.updateUser(req.params.username, req.body || {}, req.user.role)); }
      catch (e) { res.status(400).json({ error: e.message }); }
    });
    this.app.delete('/api/users/:username', admin, (req, res) => {
      try { auth.removeUser(req.params.username, req.user.role); res.json({ success: true }); }
      catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ── Read-only (any logged-in user) ──
    this.app.get('/api/status', (req, res) => {
      const full = this.orchestrator.getSystemStatus();
      // Viewers see the map + activity only — never bot names/IPs/positions/groups.
      if (req.user.role === 'viewer') {
        // fleet = aggregate counts only (deliberately exposed: the 5-second health
        // answer), never bot names/IPs/positions.
        return res.json({ bots: {}, fleet: full.fleet, groups: [], accounts: [], spots: [], monitor: { ign: null, active: 0 }, activity: {}, uptime: full.uptime });
      }
      res.json(full);
    });
    this.app.get('/api/accounts', trusted, (req, res) => {
      res.json(this.orchestrator.accounts.map(a => ({
        id: a.id, ign: a.username || null, type: a.type || 'monitor',
        pending: !!a.pending, active: this.orchestrator.activeBots.has(a.id),
      })));
    });
    this.app.get('/api/activity', async (req, res) => {
      const limit = parseInt(req.query.limit, 10) || 50;
      const range = req.query.range || '24h';
      try {
        let activity = await this.orchestrator.getRecentActivity(limit, range);
        // Viewers see the detected player + where/when, but not which bot saw it.
        if (req.user.role === 'viewer') {
          activity = activity.map(e => this._viewerActivityFields(e));
        }
        res.json(activity);
      } catch (err) { systemLogger.error('Failed to read activity:', err.message); res.status(500).json({ error: 'Failed to read activity' }); }
    });

    // ── Intelligence + metrics (trusted+ — exposes coverage / ports / proxy IPs) ──
    this.app.get('/api/intel', trusted, async (req, res) => {
      try {
        const profiles = await this.orchestrator.getPlayerProfiles({
          range: req.query.range || 'all',
          sort: req.query.sort || 'recent',
          limit: parseInt(req.query.limit, 10) || 500,
        });
        res.json(profiles);
      } catch (err) { systemLogger.error('Failed to build intel:', err.message); res.status(500).json({ error: 'Failed to build intel' }); }
    });
    this.app.get('/api/metrics', trusted, async (req, res) => {
      try { res.json(await this.orchestrator.getMetricsSummary(req.query.range || '24h')); }
      catch (err) { systemLogger.error('Failed to build metrics:', err.message); res.status(500).json({ error: 'Failed to build metrics' }); }
    });
    // wealthScore is an ESTIMATE of time+money invested that CORRELATES WITH BUT DOES
    // NOT EQUAL resource/dupe-stash wealth. It misses low-playtime dupers and fresh
    // alts, and can overrate AFK bots unless the bot filter is applied. Also:
    // api.2b2t.vc backfills playtime/kills/deaths only from when it began tracking, so
    // those fields are 0 for legacy/OG accounts — such accounts are scored from
    // joinCount + firstSeen + observed gear and are inherently lower-confidence. Never
    // present wealth as fact; always surface confidence/source. This route does a live
    // 2b2t.vc lookup — kept off /api/intel, which must never await such a call.
    this.app.get('/api/wealth', trusted, async (req, res) => {
      const name = String(req.query.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name required' });
      try { res.json(await wealth.score(name)); }
      catch (err) { systemLogger.error('Failed to build wealth:', err.message); res.status(500).json({ error: 'wealth lookup failed' }); }
    });

    // ── Cartography (Xaero stash-hunting map; trusted+) ──
    // Raw upload buffers the whole zip in RAM, so cap it well under the box's free
    // memory (40MB) and allow only one in flight at a time (uploadGuard) — the small
    // VPS can't absorb several concurrent buffers. XaeroDecoder additionally caps the
    // total decompressed bytes. Huge dimensions (e.g. a 1GB overworld) should be
    // decoded edge-side and sent to /ingest as summaries instead.
    this.app.post('/api/cartography/upload', trusted, uploadGuard, express.raw({ type: '*/*', limit: '40mb' }), (req, res) => {
      try {
        const regions = XaeroDecoder.processUpload(req.body);
        if (!regions.length) return res.status(400).json({ error: 'No Xaero regions found. In Xaero, the data is at xaero/world-map/<server>/<DIM>/mw$default/ — zip that folder and upload the .zip. (Very large dimensions are decoded on your PC instead — ask me to run it.)' });
        res.json({ success: true, ...this.orchestrator.ingestCartography(req.query.dim || 'nether', regions) });
      } catch (err) {
        systemLogger.error('Cartography upload failed:', err.message);
        // Cap-breach (the zip-bomb / OOM guard) → 413; any other decode failure is a bad
        // client upload → 400. Never 500 — a malformed zip isn't a server fault.
        const code = /cap|exceeds|too large/i.test(err.message) ? 413 : 400;
        res.status(code).json({ error: err.message });
      }
    });
    this.app.get('/api/cartography', trusted, async (req, res) => {
      try { res.json(await this.orchestrator.getCartography(req.query.dim || 'nether')); }
      catch (err) { systemLogger.error('Failed to build cartography:', err.message); res.status(500).json({ error: err.message }); }
    });
    // Download base candidates as an importable Xaero waypoints file.
    this.app.get('/api/cartography/waypoints', trusted, (req, res) => {
      try {
        const dim = req.query.dim || 'nether';
        const { count, text } = this.orchestrator.getCartographyWaypoints(dim, { min: parseInt(req.query.min, 10) || 0, signal: req.query.signal || '' });
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="stash_waypoints_${dim}.txt"`);
        res.setHeader('X-Waypoint-Count', String(count));
        res.send(text);
      } catch (err) { res.status(500).json({ error: err.message }); }
    });
    // Serve a rendered terrain tile (512×512 PNG) for a region. Path-sanitised.
    this.app.get('/api/cartography/tile', trusted, (req, res) => {
      const dim = String(req.query.dim || '').replace(/[^a-z]/gi, '');
      const x = String(req.query.x || ''), z = String(req.query.z || '');
      if (!dim || !/^-?\d+$/.test(x) || !/^-?\d+$/.test(z)) return res.status(400).end();
      const file = path.join(__dirname, '..', 'data', 'cartography', 'tiles', dim, `${x}_${z}.png`);
      res.sendFile(file, { maxAge: '1h' }, err => { if (err) res.status(404).end(); });
    });
    // Ingest pre-decoded region summaries (for huge maps decoded client/edge-side, so
    // we never ship gigabytes of raw region data). Send in batches under the json limit.
    this.app.post('/api/cartography/ingest', trusted, (req, res) => {
      try {
        const { dim, regions } = req.body || {};
        if (!Array.isArray(regions)) return res.status(400).json({ error: 'regions[] required' });
        res.json({ success: true, ...this.orchestrator.ingestCartography(dim || 'nether', regions) });
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Manage bots / groups / activity (trusted+) ──
    this.app.post('/api/bots/:id/placed', trusted, (req, res) => {
      this.orchestrator._setPlaced(req.params.id, !!req.body.placed);
      res.json({ success: true, placed: !!req.body.placed });
    });
    this.app.post('/api/accounts/:id/start', trusted, async (req, res) => {
      try { res.json({ success: true, ...(await this.orchestrator.startAccount(req.params.id)) }); }
      catch (err) { res.status(400).json({ error: err.message }); }
    });
    this.app.post('/api/groups', trusted, (req, res) => res.json({ success: true, group: this.orchestrator.createGroup(req.body || {}) }));
    this.app.patch('/api/groups/:id', trusted, (req, res) => res.json({ success: this.orchestrator.updateGroup(req.params.id, req.body || {}) }));
    this.app.delete('/api/groups/:id', trusted, (req, res) => res.json({ success: this.orchestrator.deleteGroup(req.params.id) }));
    this.app.post('/api/groups/:id/assign', trusted, (req, res) => {
      const { accountId } = req.body || {};
      if (!accountId) return res.status(400).json({ error: 'accountId required' });
      res.json({ success: this.orchestrator.assignAccount(accountId, req.params.id) });
    });
    this.app.post('/api/accounts/:id/unassign', trusted, (req, res) => res.json({ success: this.orchestrator.unassignAccount(req.params.id) }));
    this.app.delete('/api/activity/entries', trusted, async (req, res) => {
      try { res.json({ success: true, removed: await this.orchestrator.deleteActivityEntries(req.body && req.body.entries) }); }
      catch (err) { res.status(500).json({ error: err.message }); }
    });
    this.app.delete('/api/activity', trusted, async (req, res) => {
      try {
        const removed = await this.orchestrator.clearActivity({
          spot: req.query.spot || undefined,
          beforeDays: req.query.beforeDays ? parseInt(req.query.beforeDays, 10) : 0,
        });
        res.json({ success: true, removed });
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Admin only: accounts, MFA (re-login), settings ──
    this.app.get('/api/settings', admin, (req, res) => res.json(this.orchestrator.getSettings()));
    this.app.put('/api/settings', admin, (req, res) => {
      try { res.json(this.orchestrator.updateSettings(req.body || {})); }
      catch (err) { res.status(500).json({ error: err.message }); }
    });
    this.app.post('/api/accounts/add', admin, (req, res) => {
      try { res.json({ success: true, ...this.orchestrator.addAccountViaLogin() }); }
      catch (err) { res.status(400).json({ error: err.message }); }
    });
    this.app.post('/api/accounts/:id/relogin', admin, async (req, res) => {
      try { res.json({ success: true, ...(await this.orchestrator.reloginAccount(req.params.id)) }); }
      catch (err) { res.status(400).json({ error: err.message }); }
    });
    this.app.delete('/api/accounts/:id', admin, (req, res) => {
      try { res.json({ success: this.orchestrator.deleteAccount(req.params.id) }); }
      catch (err) { res.status(500).json({ error: err.message }); }
    });
  }

  _setupWebSocket() {
    this.wss.on('connection', (ws, req) => {
      // Reject cross-origin handshakes (defense-in-depth on top of SameSite=Lax),
      // then authenticate the WebSocket via the same session cookie.
      if (!this._originOk(req)) { ws.close(1008, 'Bad origin'); return; }
      const user = auth.verifyToken(this._cookie(req, 'sid'));
      if (!user) { ws.close(1008, 'Unauthorized'); return; }
      ws._isViewer = user.role === 'viewer';

      this.clients.add(ws);
      const initial = { type: 'initial', data: this.orchestrator.getSystemStatus() };
      ws.send(JSON.stringify(ws._isViewer ? this._redactForViewer(initial) : initial));
      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
    });
  }

  /** Allowlist projection of a detection/activity entry to the only fields a
   *  viewer may see — never botId/spotId, the private `watched` watchlist flag,
   *  or `source`. Shared by the REST /api/activity path and the WS
   *  player_detected redaction so a newly-added field never auto-leaks. */
  _viewerActivityFields(e) {
    return {
      playerName: e.playerName, coords: e.coords, direction: e.direction,
      speed: e.speed, distance: e.distance, equipment: e.equipment,
      dimension: e.dimension, timestamp: e.timestamp,
    };
  }

  /** Strip bot-identifying data from a WS message for viewer clients; returns
   *  null for management events viewers shouldn't receive at all. */
  _redactForViewer(data) {
    // 'status' is the poller's per-tick live push — same snapshot shape as 'initial',
    // so it gets the same viewer projection (aggregate fleet counts only).
    if (data.type === 'initial' || data.type === 'status') {
      const u = data.data && data.data.uptime;
      const fleet = data.data && data.data.fleet; // aggregate counts only — safe for viewers
      return { type: data.type, data: { bots: {}, fleet, groups: [], accounts: [], spots: [], monitor: { ign: null, active: 0 }, activity: {}, uptime: u } };
    }
    if (data.type === 'player_detected') {
      // Allowlist projection (identical to the REST /api/activity viewer path) so
      // no bot-identifying field — botId/spotId, the private `watched` watchlist
      // flag, or `source` — can auto-leak to viewers as new fields are added.
      return { type: 'player_detected', ...this._viewerActivityFields(data) };
    }
    return null; // bot/account/settings events are not for viewers
  }

  /** Broadcast to all clients, redacting bot data for viewers. */
  broadcast(data) {
    const fullMsg = JSON.stringify(data);
    let viewerMsg; // computed lazily, only if a viewer is connected
    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      let msg = fullMsg;
      if (client._isViewer) {
        if (viewerMsg === undefined) { const r = this._redactForViewer(data); viewerMsg = r ? JSON.stringify(r) : null; }
        if (viewerMsg === null) continue;
        msg = viewerMsg;
      }
      try { client.send(msg); } catch (e) { this.clients.delete(client); }
    }
  }
}

module.exports = DashboardServer;
