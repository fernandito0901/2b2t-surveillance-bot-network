/**
 * logging/DiscordNotifier.js — Discord webhook integration.
 * Sends rich embeds for player detections, bot status changes, and supply requests.
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');
const config = require('../config');

class DiscordNotifier {
  constructor() {
    // No cached webhookUrl/enabled here: the URL is dashboard-editable at runtime, so
    // _send reads config.discord.webhookUrl live on every send (a construct-time copy
    // would go stale and silently mis-report enabled/disabled).
    this._queue = [];
    this._sending = false;
    // Rate limit: max 30 requests per minute for webhooks
    this._minInterval = 2000; // 2s between sends
    // A half-open socket (Discord accepts the TCP connection but never replies)
    // must never wedge the queue — bound every request in time and retries.
    this._reqTimeout = 10000; // 10s per request before we give up on it
    this._maxAttempts = 3;    // bounded retries per payload (transient hang/5xx/429)
  }

  /**
   * Send a raw payload to Discord webhook.
   * @param {object} payload - Discord webhook JSON payload
   */
  async _send(payload) {
    // Read the webhook live so dashboard Settings changes take effect without a restart.
    const webhookUrl = config.discord.webhookUrl;
    if (!webhookUrl) return;

    return new Promise((resolve, reject) => {
      const url = new URL(webhookUrl);
      const data = JSON.stringify(payload);
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      };

      const transport = url.protocol === 'https:' ? https : http;
      // Guard against settling twice (e.g. an 'error' firing after a timeout destroy).
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err); else resolve();
      };

      const req = transport.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            done();
          } else {
            const err = new Error(`Discord webhook returned ${res.statusCode}: ${body}`);
            err.statusCode = res.statusCode;
            // Surface Retry-After (seconds, possibly fractional) so the queue can back off on 429.
            const ra = res.headers && res.headers['retry-after'];
            if (ra != null) {
              const ms = parseFloat(ra) * 1000;
              err.retryAfterMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
            }
            done(err);
          }
        });
      });

      // Without this a hung (half-open) connection leaves the Promise pending forever.
      req.setTimeout(this._reqTimeout, () => {
        req.destroy();
        done(new Error(`Discord webhook timed out after ${this._reqTimeout}ms`));
      });

      req.on('error', err => done(err));
      req.write(data);
      req.end();
    });
  }

  /** Queue a message and process the queue with rate limiting */
  _enqueue(payload) {
    this._queue.push(payload);
    // Cap the backlog so a burst (e.g. sightingAlerts:'all' on a busy highway, sent
    // 2s apart) can't grow it unbounded. When over the cap, evict LOW-PRIORITY entries
    // first so a routine-sighting flood can't push an important @here alert (watchlist
    // hit / login required) off the front of the queue.
    if (this._queue.length > 200) {
      const isImportant = (p) => p && typeof p.content === 'string' && p.content.includes('@here');
      let over = this._queue.length - 200;
      // First pass: drop oldest NON-important entries.
      for (let i = 0; i < this._queue.length && over > 0; ) {
        if (!isImportant(this._queue[i])) { this._queue.splice(i, 1); over--; }
        else i++;
      }
      // If still over (queue is all-important), drop the oldest to bound memory.
      if (over > 0) this._queue.splice(0, over);
    }
    this._processQueue();
  }

  async _processQueue() {
    if (this._sending || this._queue.length === 0) return;
    this._sending = true;

    try {
      while (this._queue.length > 0) {
        const payload = this._queue.shift();
        // Bounded retry so a transient hang/5xx/429 doesn't silently drop an alert,
        // but a persistent outage can't block the loop forever.
        for (let attempt = 1; attempt <= this._maxAttempts; attempt++) {
          try {
            await this._send(payload);
            break;
          } catch (err) {
            if (attempt >= this._maxAttempts) {
              console.error('[Discord] Webhook error (gave up):', err.message);
              break;
            }
            // Honor 429 Retry-After when present; otherwise a short linear backoff.
            const backoff = (err.retryAfterMs != null) ? err.retryAfterMs : this._minInterval * attempt;
            console.error(`[Discord] Webhook error (attempt ${attempt}/${this._maxAttempts}, retry in ${backoff}ms):`, err.message);
            await new Promise(r => setTimeout(r, backoff));
          }
        }
        // Rate limit delay
        await new Promise(r => setTimeout(r, this._minInterval));
      }
    } finally {
      // Always release the lock — a hung or failed send must never wedge the queue.
      this._sending = false;
    }
  }

  // ── High-level notification methods ─────────────────────

  /**
   * Player detected near a monitoring spot.
   */
  playerDetected({ botId, spotId, playerName, distance, direction, speed, coords }) {
    this._enqueue({
      embeds: [{
        title: '🔴 Player Detected',
        color: 0xFF0000,
        fields: [
          { name: 'Player', value: `\`${playerName}\``, inline: true },
          { name: 'Distance', value: `${Math.round(distance)} blocks`, inline: true },
          { name: 'Direction', value: direction || 'Unknown', inline: true },
          { name: 'Speed', value: speed ? `${speed.toFixed(1)} b/s` : 'Unknown', inline: true },
          { name: 'Spot', value: spotId, inline: true },
          { name: 'Coords', value: coords ? `${coords.x}, ${coords.y}, ${coords.z}` : 'Unknown', inline: false },
        ],
        footer: { text: `Bot: ${botId}` },
        timestamp: new Date().toISOString(),
      }],
    });
  }

  /**
   * Bot status change.
   */
  botStatus({ botId, status, detail }) {
    const statusColors = {
      connected: 0x00FF00,
      in_queue: 0x3498DB,
      monitoring: 0x2ECC71,
      disconnected: 0x95A5A6,
      error: 0xE74C3C,
      died: 0xE74C3C,
    };

    this._enqueue({
      embeds: [{
        title: `🤖 Bot Status: ${status.toUpperCase()}`,
        color: statusColors[status] || 0x95A5A6,
        description: detail || '',
        fields: [
          { name: 'Bot', value: botId, inline: true },
        ],
        timestamp: new Date().toISOString(),
      }],
    });
  }

  /**
   * A watchlist player was spotted — high-priority, on top of the normal log.
   */
  watchlistHit({ playerName, spotId, coords, distance, equipment, dimension }) {
    const pretty = s => String(s).replace(/^minecraft:/, '').split('_')
      .map((w, i) => (i && ['of', 'the', 'and'].includes(w)) ? w : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    // Item names only — enchant capture was removed (it was unreliable; see PlayerMonitor).
    const fmtSlot = e => pretty((typeof e === 'string') ? e : (e && e.item) || '');
    const gear = equipment ? Object.values(equipment).map(fmtSlot).join(', ') : 'none seen';
    const dim = dimension ? dimension.replace('minecraft:', '') : 'unknown';
    this._enqueue({
      content: '@here',
      embeds: [{
        title: '👁 Watchlist player spotted',
        color: 0xF59E0B,
        description: `**${playerName}** was just detected.`,
        fields: [
          { name: 'Where', value: coords ? `\`${coords.x}, ${coords.y}, ${coords.z}\` (${dim})` : 'Unknown', inline: false },
          { name: 'Distance', value: distance != null ? `${Math.round(distance)} blocks` : 'Unknown', inline: true },
          { name: 'Seen by', value: spotId || 'Unknown', inline: true },
          { name: 'Gear', value: gear, inline: false },
        ],
        timestamp: new Date().toISOString(),
      }],
    });
  }

  /**
   * Account needs a (re)login — its Microsoft token expired or was revoked.
   */
  loginRequired({ name, url, code }) {
    this._enqueue({
      content: '@here',
      embeds: [{
        title: '🔐 Account needs to log in',
        color: 0xE74C3C,
        description: `**${name}** can't authenticate and needs a Microsoft device-code login.`,
        fields: [
          { name: 'Go to', value: url || 'https://microsoft.com/link', inline: false },
          { name: 'Enter code', value: code ? `\`${code}\`` : 'see dashboard', inline: true },
        ],
        footer: { text: 'Or click Re-login on the dashboard.' },
        timestamp: new Date().toISOString(),
      }],
    });
  }

  /**
   * Generic message.
   */
  message(text) {
    this._enqueue({ content: text });
  }
}

// Singleton
module.exports = new DiscordNotifier();
