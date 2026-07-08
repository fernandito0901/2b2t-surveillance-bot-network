/**
 * proxy/ProxyPool.js — SOCKS5 proxy source + health checks.
 *
 * Source of proxies: the Webshare API (when WEBSHARE_API_KEY is set), cached to
 * data/proxies.txt as a fallback. Each account past the first egresses through a
 * distinct proxy IP because 2b2t rate-limits multiple accounts per IP.
 *
 * Health check: open a raw SOCKS5 TCP connection through the proxy to 2b2t's real
 * endpoint (connect.2b2t.org:25565) and immediately close it. We send NO Minecraft
 * handshake/login, so a destroyed connect never joins the queue — but it confirms
 * the proxy can actually reach 2b2t (not just the nearest Cloudflare PoP) and its
 * connect latency reflects true distance to 2b2t. This catches the common failure
 * (Webshare rotates an IP out → the SOCKS auth handshake fails) before we ever
 * assign it, so accounts don't sit endlessly "Connecting…".
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { SocksClient } = require('socks');
const { systemLogger } = require('../logging/Logger');

// The SOCKS reachability + latency probe targets 2b2t's real endpoint so a proxy
// that can't reach 2b2t fails the check (and latency ranks by true distance to
// 2b2t, not to the nearest Cloudflare PoP). We only open a raw TCP connect and
// immediately destroy it — no Minecraft handshake is sent, so this never joins the
// queue. Overridable via env for testing.
const TEST_HOST = process.env.PROXY_PROBE_HOST || 'connect.2b2t.org';
const TEST_PORT = parseInt(process.env.PROXY_PROBE_PORT, 10) || 25565;

// Cap simultaneous SOCKS probes during a health sweep (per tier) so we don't open
// one socket/FD per proxy at once — bounds memory/FD use on the RAM-constrained VPS
// if the proxy plan ever grows to hundreds. Overridable via env.
const SWEEP_CONCURRENCY = parseInt(process.env.PROXY_SWEEP_CONCURRENCY, 10) || 15;

/**
 * Bounded parallel map: run `fn` over `items` with at most `limit` in flight at
 * once, preserving result order (drop-in for `Promise.all(items.map(fn))`). Keeps
 * the health sweep from opening one SOCKS connection per proxy simultaneously.
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

class ProxyPool {
  constructor() {
    this._cache = null;       // [{host, port, user, password}]
    this._cacheTime = 0;
    this._refreshMs = 10 * 60 * 1000; // re-fetch from Webshare at most every 10 min
    this._failUntil = 0;      // negative-cache: don't re-hit the API before this epoch ms
    this._failBackoffMs = 60 * 1000; // failure cooldown, doubles to _refreshMs
  }

  /** Current proxy list: plan download link, else account API, else local file. */
  async list() {
    const canFetch = config.proxies.listUrl || config.proxies.webshareApiKey;
    // Skip the API entirely while inside a failure cooldown, so an outage during a
    // provisioning/dashboard burst doesn't hammer Webshare on every list() call.
    if (canFetch && Date.now() >= this._failUntil && Date.now() - this._cacheTime > this._refreshMs) {
      const fetched = await this._fetchRemote().catch(e => {
        systemLogger.warn(`Webshare fetch failed: ${e.message} — using cached proxies.txt`);
        return null;
      });
      if (fetched && fetched.length) {
        this._cache = fetched;
        this._cacheTime = Date.now();
        this._failUntil = 0;
        this._failBackoffMs = 60 * 1000; // reset backoff on success
        this._writeFile(fetched);
        systemLogger.info(`Webshare: synced ${fetched.length} proxies`);
      } else {
        // Negative-cache the failure with exponential backoff (capped at the normal
        // refresh interval) instead of retrying on the very next call.
        this._failUntil = Date.now() + this._failBackoffMs;
        this._failBackoffMs = Math.min(this._refreshMs, this._failBackoffMs * 2);
      }
    }
    return this._cache || this._loadFile();
  }

  async _fetchRemote() {
    // Prefer the API when a key is set: one call returns proxies WITH geo (country/
    // city/asn), so we no longer need a separate country-mapping pass. The plain-text
    // plan list (listUrl) carries no geo, so it's only the no-key fallback.
    if (config.proxies.webshareApiKey) return this._fetchWebshare();
    if (config.proxies.listUrl) return this._fetchListUrl();
    return [];
  }

  /** Fetch the plan-specific download link (plain text, host:port:user:pass). */
  async _fetchListUrl() {
    const res = await fetch(config.proxies.listUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.text()).split('\n').map(l => l.trim()).filter(Boolean)
      .map(l => { const [host, port, user, password] = l.split(':'); return { host, port: parseInt(port, 10), user: user || '', password: password || '' }; })
      .filter(p => p.host && p.port);
  }

  /** Force a fresh Webshare sync (ignores the cache window). */
  async refresh() { this._cacheTime = 0; return this.list(); }

  /** Webshare plan + usage snapshot for the dashboard (cached ~10 min). Returns null
   *  without an API key. Bandwidth is converted to GB (the stats API returns bytes;
   *  the plan limit is already GB). Best-effort — any sub-fetch can fail gracefully. */
  async getPlanInfo() {
    if (!config.proxies.webshareApiKey) return null;
    if (this._planInfo && Date.now() - (this._planTime || 0) < this._refreshMs) return this._planInfo;
    const H = { Authorization: `Token ${config.proxies.webshareApiKey}` };
    const get = async (url) => { const r = await fetch(url, { headers: H }); if (!r.ok) throw new Error(`HTTP ${r.status}`); const j = await r.json(); return Array.isArray(j.results) ? j.results[0] : j; };
    try {
      const p = await get('https://proxy.webshare.io/api/v2/subscription/plan/');
      const c = await get('https://proxy.webshare.io/api/v2/proxy/config/').catch(() => ({}));
      let bandwidthUsedGB = null;
      try {
        const since = new Date(Date.now() - 30 * 86400000).toISOString();
        const s = await get(`https://proxy.webshare.io/api/v2/stats/aggregate/?timestamp__gte=${since}`);
        if (s && s.bandwidth_total != null) bandwidthUsedGB = +(s.bandwidth_total / 1e9).toFixed(2);
      } catch (e) { /* stats optional */ }
      this._planInfo = {
        proxyType: `${p.proxy_type || ''}${p.proxy_subtype ? ' ' + p.proxy_subtype : ''}`.trim(),
        proxyCount: p.proxy_count,
        countries: c.countries || {},
        bandwidthLimitGB: p.bandwidth_limit || 0,
        bandwidthUsedGB,
        replacementsAvailable: p.proxy_replacements_available,
        replacementsTotal: p.proxy_replacements_total,
        refreshesAvailable: p.on_demand_refreshes_available,
      };
      this._planTime = Date.now();
    } catch (e) {
      systemLogger.warn(`Webshare plan fetch failed: ${e.message}`);
    }
    return this._planInfo;
  }

  async _fetchWebshare() {
    const all = [];
    for (let page = 1; page <= 20; page++) {
      const url = `https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&valid=true&page=${page}&page_size=100`;
      const res = await fetch(url, { headers: { Authorization: `Token ${config.proxies.webshareApiKey}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      for (const r of (data.results || [])) {
        if (r.proxy_address && r.port) {
          // Keep the geo/network fields the list already returns, so the picker can
          // tier by country and the dashboard can show each proxy's city/ASN — no
          // need for a second paginated fetch just for country codes.
          all.push({ host: r.proxy_address, port: r.port, user: r.username || '', password: r.password || '',
            country: r.country_code || '', city: r.city_name || '', asn: r.asn_name || '' });
        }
      }
      if (!data.next) break;
    }
    return all;
  }

  _loadFile() {
    try {
      return fs.readFileSync(path.resolve(config.proxies.localFile), 'utf-8')
        .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
        .map(l => { const [host, port, user, password, country] = l.split(':'); return { host, port: parseInt(port, 10), user: user || '', password: password || '', country: country || '' }; })
        .filter(p => p.host && p.port);
    } catch (e) { return []; }
  }

  _writeFile(proxies) {
    try {
      const lines = ['# Auto-synced from the Webshare API; edited copy is only a fallback.'];
      for (const p of proxies) lines.push(`${p.host}:${p.port}:${p.user}:${p.password}:${p.country || ''}`);
      fs.writeFileSync(path.resolve(config.proxies.localFile), lines.join('\n') + '\n');
    } catch (e) { systemLogger.warn(`Failed to write proxies.txt: ${e.message}`); }
  }

  /** SOCKS5 connect latency (ms) through a proxy to 2b2t's endpoint, or null if it
   *  can't connect. We open a raw TCP connect and destroy it immediately — no
   *  Minecraft handshake is sent, so this never joins the queue. Latency ≈ how far
   *  the proxy sits from 2b2t — a proxy in Asia adds ~700ms+ of round-trip vs a
   *  nearby US one, which destabilises the game connection (slow keepalives,
   *  timeout-prone). */
  async measureLatency(proxy, timeoutMs = 6000) {
    if (!proxy || !proxy.host) return null;
    const t = Date.now();
    try {
      const info = await SocksClient.createConnection({
        proxy: { host: proxy.host, port: proxy.port, type: 5, userId: proxy.user || undefined, password: proxy.password || undefined },
        command: 'connect',
        destination: { host: TEST_HOST, port: TEST_PORT },
        timeout: timeoutMs,
      });
      try { info.socket.destroy(); } catch (e) {}
      return Date.now() - t;
    } catch (e) { return null; }
  }

  /** True if a SOCKS5 connection can be opened through this proxy. */
  async healthCheck(proxy, timeoutMs = 6000) {
    return (await this.measureLatency(proxy, timeoutMs)) != null;
  }

  /**
   * Pick the LOWEST-LATENCY working proxy not in excludeHosts. Measures every
   * candidate in parallel and returns the closest one (a US proxy from a US VPS),
   * instead of just the first that happens to ping. Returns null if none work.
   */
  async getBestProxy(excludeHosts = []) {
    const exclude = new Set((excludeHosts || []).filter(Boolean));
    const candidates = (await this.list()).filter(p => !exclude.has(p.host));
    if (!candidates.length) return null;
    const prefer = (config.proxies.preferCountries || []).map(c => String(c).toUpperCase());
    // Tier 1: preferred countries (e.g. US/CA). Tier 2: everything else. Try the
    // preferred tier first; only fall back if none of those work. Within a tier,
    // pick the lowest-latency (also confirms it's actually reachable).
    const inPref = candidates.filter(p => prefer.includes(String(p.country || '').toUpperCase()));
    const rest = candidates.filter(p => !inPref.includes(p));
    const tiers = (prefer.length && inPref.length) ? [inPref, rest] : [candidates];
    for (const tier of tiers) {
      if (!tier.length) continue;
      // Bounded fan-out: at most SWEEP_CONCURRENCY probes in flight at once, so a
      // large tier can't spike sockets/FDs/RAM on the small VPS (was an unbounded
      // Promise.all over the whole tier).
      const measured = await mapWithConcurrency(tier, SWEEP_CONCURRENCY, async p => ({ p, ms: await this.measureLatency(p) }));
      const working = measured.filter(m => m.ms != null).sort((a, b) => a.ms - b.ms);
      if (working.length) {
        const best = working[0];
        const preferred = prefer.includes(String(best.p.country || '').toUpperCase());
        systemLogger.info(`Proxy pick: ${best.p.host} (${best.p.country || '?'}, ${best.ms}ms) — fastest in ${preferred ? 'preferred' : 'fallback'} tier`);
        return best.p;
      }
    }
    return null;
  }

  /** Back-compat: getBestProxy is now the preferred picker (latency-ranked). */
  async getWorkingProxy(excludeHosts = []) {
    return this.getBestProxy(excludeHosts);
  }
}

module.exports = new ProxyPool();
