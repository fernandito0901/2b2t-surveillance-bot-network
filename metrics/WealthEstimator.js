/**
 * metrics/WealthEstimator.js — Cached, rate-limited wealth intel for spotted players.
 *
 * A stateful singleton (mirrors metrics/MetricsStore.js: in-memory store + disk
 * persist + prune, module.exports = new X()). It fronts api.2b2t.vc with a single
 * serialized fetch queue so the dashboard can annotate highway sightings with a
 * "wealth" estimate without ever blocking the render path or hammering the API.
 *
 *   - peek(names)         SYNCHRONOUS, no I/O — returns whatever RAW stats are
 *                         already cached and schedules a bounded background refresh
 *                         for anything missing/stale. getPlayerProfiles calls this
 *                         once per batch.
 *   - score(name)         async cache-first single lookup; on a miss it enqueues
 *                         and awaits, then runs the pure scorer. Backs GET /api/wealth.
 *   - refreshPriors()     pulls /players/priority + /bots/month once each and caches
 *                         the lowercased name/uuid sets (priority-queue members and
 *                         known month-active bots).
 *
 * Everything is FAIL-OPEN: if config.wealth.enabled is false, or the API is down,
 * or anything throws, we degrade to empty/null and the intel renders as it does
 * today (no wealth badge) — never an error surfaced to the operator.
 *
 * CAVEAT: wealthScore is an ESTIMATE of time+money invested that CORRELATES WITH
 * BUT DOES NOT EQUAL resource/dupe-stash wealth. It misses low-playtime dupers and
 * fresh alts, and can overrate AFK bots unless the bot filter is applied. Also:
 * api.2b2t.vc backfills playtime/kills/deaths only from when it began tracking, so
 * those fields are 0 for legacy/OG accounts — such accounts are scored from
 * joinCount + firstSeen + observed gear and are inherently lower-confidence. Never
 * present wealth as fact; always surface confidence/source.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const wealthScore = require('../lib/wealthScore');
const { writeJsonAtomic } = require('../lib/atomicWrite');

// config.wealth is added by config.js; default to {} so a missing section simply
// reads as "disabled" (cfg.enabled undefined → falsy) rather than throwing.
const cfg = config.wealth || {};

const CONCURRENCY = 1;              // one worker; the API is politely single-threaded
const MAX_ATTEMPTS = 4;            // give up a 429-requeued item after this many tries
const PERSIST_DEBOUNCE_MS = 2000;  // coalesce a burst of cache writes into one flush
const SCORE_WAIT_CAP_MS = 20000;   // max time score() blocks on the queue (deep queue +
                                   // 429 backoff can otherwise hang /api/wealth for minutes)

class WealthEstimator {
  constructor() {
    this._cache = new Map();        // lcName → { apiStats, prio, isBot, status, fetchedAt, _expires }
    this._queue = [];               // [{ key, query, waiters:[fn], attempts, force }]
    this._workerRunning = false;    // single-worker guard (CONCURRENCY = 1)
    this._pauseUntil = 0;           // honor 429 backoff until this epoch ms
    this._lastRequestAt = 0;        // for minRequestSpacingMs pacing between requests
    this._backoffMs = cfg.backoffStartMs || 2000; // current 429 backoff (doubles → max)
    this._prioSet = new Set();      // lowercased names AND uuids on the priority queue
    this._botSet = new Set();       // lowercased names AND uuids of month-active bots
    this._priorsAt = 0;             // epoch ms the prior sets were last populated
    this._priorsRetryAt = 0;        // don't retry a failed priors fetch before this
    this._priorsInFlight = null;    // in-flight refreshPriors() promise (dedupe)
    this._gate = Promise.resolve(); // serializes ALL outbound requests (worker + priors)
    this._persistTimer = null;      // debounce handle for persist()
    this._lastError = null;         // last error string (surfaced via stats())
    // Same as MetricsStore: ensure the persist dir exists up-front.
    try { if (cfg.persistPath) fs.mkdirSync(path.dirname(path.resolve(cfg.persistPath)), { recursive: true }); } catch (e) {}
    this._load(); // seed cache from disk; NO auto-fetch on construct
  }

  // ── public API ────────────────────────────────────────────────────────────

  /**
   * Synchronous, no-I/O snapshot for a batch of names. Returns a Map of lowercased
   * name → the cached RAW entry ({ apiStats, prio, isBot, status, fetchedAt }) or
   * null if nothing is cached. For missing/stale names it schedules at most
   * cfg.peekEnqueueCap NEW background fetches. Never awaits. This is what
   * getPlayerProfiles calls once per batch.
   */
  peek(names) {
    const out = new Map();
    if (!cfg.enabled) return out;      // kill-switch: enqueue nothing, empty Map
    this._maybeRefreshPriors();        // fire-and-forget if the prior sets are stale
    let scheduled = 0;
    const cap = cfg.peekEnqueueCap || 25;
    for (const raw of (names || [])) {
      if (raw == null || raw === '') continue;
      const key = String(raw).toLowerCase();
      const entry = this._cache.get(key);
      out.set(key, entry ? this._publicEntry(key, entry) : null); // RAW cached view (may be stale)
      if ((!entry || this._isStale(entry)) && scheduled < cap) {
        if (this._enqueuePeek(key, String(raw))) scheduled++; // only NEW fetches count
      }
    }
    return out;
  }

  /**
   * Cache-first single lookup that resolves the FINAL score. On a cache miss (or
   * force) it enqueues and awaits the (serialized) fetch, then runs the pure
   * API-only scorer (gearPoints:0). Backs GET /api/wealth. Always resolves — never
   * rejects — with a status of 'ok'|'no-data'|'pending'|'error'|'disabled'.
   */
  async score(name, { force = false } = {}) {
    const key = String(name || '').toLowerCase();
    const base = {
      name, wealthScore: null, label: 'none', source: 'none', confidence: 0,
      components: null, prio: null, bot: false, fetchedAt: null, status: 'disabled',
    };
    if (!cfg.enabled) return base;
    try {
      this._maybeRefreshPriors();
      let entry = this._cache.get(key);
      if (force || !entry || this._isStale(entry)) {
        // Cap the wait: the fetch stays queued and lands in the cache when it
        // completes, but the HTTP caller gets 'pending' (or stale data) instead
        // of hanging behind a deep queue / active 429 backoff.
        const TIMEOUT = Symbol('score-wait-timeout');
        const raced = await Promise.race([
          this._enqueue(key, String(name || ''), { force }),
          this._sleep(SCORE_WAIT_CAP_MS, { unref: true }).then(() => TIMEOUT),
        ]);
        entry = raced === TIMEOUT ? (this._cache.get(key) || null) : raced;
      }
      if (!entry) return { ...base, status: 'pending' }; // queue saturated, nothing cached
      return this._toScore(name, key, entry);
    } catch (e) {
      this._lastError = (e && e.message) || String(e);
      return { ...base, status: 'error' };
    }
  }

  /**
   * Fetch /players/priority and /bots/month ONCE each and populate this._prioSet +
   * this._botSet with lowercased names AND uuids, cached for cfg.priorsTtlMs.
   * Fail-open: on error the previous sets are kept and we simply retry later.
   */
  async refreshPriors() {
    if (!cfg.enabled) return;
    if (this._priorsInFlight) return this._priorsInFlight; // dedupe concurrent callers
    this._priorsInFlight = (async () => {
      try {
        // _getJson returns null on ANY non-200/parse failure (it does not throw for
        // those), so committing unconditionally would wipe the sets on a blip. Only
        // commit (and bump the TTL clock) when BOTH endpoints actually returned data.
        const prioData = await this._getJson('/players/priority');
        const botData = await this._getJson('/bots/month');
        if (prioData == null || botData == null) {
          this._lastError = 'priors fetch failed (kept previous sets)';
          this._priorsRetryAt = Date.now() + (cfg.backoffMaxMs || 60000); // don't re-hit on every peek
          return;
        }
        const prio = new Set();
        const bots = new Set();
        this._collectNames(prioData, prio);
        this._collectNames(botData, bots);
        this._prioSet = prio;
        this._botSet = bots;
        this._priorsAt = Date.now();
      } catch (e) {
        this._lastError = (e && e.message) || 'priors fetch error';
        this._priorsRetryAt = Date.now() + (cfg.backoffMaxMs || 60000);
        // fail-open: leave prior sets untouched; don't advance _priorsAt so we retry
      } finally {
        this._priorsInFlight = null;
      }
    })();
    return this._priorsInFlight;
  }

  /** Drop expired cache entries (called from the index.js maintenance timer). */
  prune() {
    const now = Date.now();
    let removed = false;
    for (const [k, e] of this._cache) {
      if (e && e._expires != null && now >= e._expires) { this._cache.delete(k); removed = true; }
    }
    if (removed) this.persist();
  }

  /** Debounced atomic write of the cache to cfg.persistPath. */
  persist() {
    if (this._persistTimer) return; // already scheduled — coalesce
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._writeNow();
    }, PERSIST_DEBOUNCE_MS);
    if (this._persistTimer.unref) this._persistTimer.unref(); // don't hold the event loop open
  }

  /** Small operational snapshot for the admin/debug view. */
  stats() {
    return {
      queueDepth: this._queue.length,
      cacheSize: this._cache.size,
      pausedUntil: this._pauseUntil || 0,
      lastError: this._lastError || null,
    };
  }

  // ── scoring ───────────────────────────────────────────────────────────────

  /** Live prio/isBot for a cache entry: entries are stamped at fetch time, but the
   *  prior sets often load AFTER the first player fetches (fire-and-forget) — so
   *  prefer the CURRENT sets whenever they have been populated, falling back to the
   *  stamped values (e.g. cache loaded from disk before any priors this boot). */
  _liveTags(key, e) {
    const uuid = e.uuid || null;
    return {
      prio: this._priorsAt ? this._prio(key, uuid) : (e.prio === undefined ? null : e.prio),
      isBot: this._priorsAt ? this._isBot(key, uuid) : !!e.isBot,
    };
  }

  /** Turn a raw cache entry into the public scored shape via the pure scorer. */
  _toScore(name, key, entry) {
    const { prio, isBot } = this._liveTags(key, entry);
    const res = wealthScore.computeWealth(
      { apiStats: entry.apiStats, prio, isBot, gearPoints: 0, now: Date.now() },
      cfg,
    );
    return {
      name,
      wealthScore: res.score,
      label: res.label,
      source: res.source,
      confidence: res.confidence,
      components: res.components,
      prio,
      bot: isBot,
      fetchedAt: entry.fetchedAt,
      status: entry.status, // 'ok' | 'no-data' | 'error'
    };
  }

  /** The RAW, persisted-shape view of a cache entry (no internal _expires). */
  _publicEntry(key, e) {
    const { prio, isBot } = this._liveTags(key, e);
    return {
      apiStats: e.apiStats || null,
      prio,
      isBot,
      status: e.status,
      fetchedAt: e.fetchedAt,
    };
  }

  _isStale(entry) { return !entry || entry._expires == null || Date.now() >= entry._expires; }

  // ── queue + worker (CONCURRENCY = 1) ───────────────────────────────────────

  /** Enqueue a background fetch with no waiter. Returns true only if a NEW queue
   *  item was created (already-queued/saturated → false), so peek can cap NEW work. */
  _enqueuePeek(key, query) {
    if (this._queue.find(q => q.key === key)) return false;   // already in flight/queued
    if (this._queue.length >= (cfg.maxQueue || 200)) return false;
    this._queue.push({ key, query, waiters: [], attempts: 0, force: false });
    this._kickWorker();
    return true;
  }

  /** Enqueue and return a promise resolving to the resulting cache entry (or null
   *  if the queue is saturated and nothing is cached). Coalesces onto an existing
   *  queued item for the same name. */
  _enqueue(key, query, opts = {}) {
    return new Promise((resolve) => {
      const existing = this._queue.find(q => q.key === key);
      if (existing) { existing.waiters.push(resolve); if (opts.force) existing.force = true; return; }
      if (this._queue.length >= (cfg.maxQueue || 200)) { resolve(this._cache.get(key) || null); return; }
      this._queue.push({ key, query, waiters: [resolve], attempts: 0, force: !!opts.force });
      this._kickWorker();
    });
  }

  /** Fire-and-forget worker start that can never surface an unhandledRejection
   *  (today _runWorker can't reject, but this keeps future edits safe). */
  _kickWorker() {
    this._runWorker().catch((e) => { this._lastError = (e && e.message) || String(e); });
  }

  /** The single worker loop. Drains the queue one item at a time, pacing every
   *  request by cfg.minRequestSpacingMs and honoring this._pauseUntil. */
  async _runWorker() {
    if (this._workerRunning) return;   // enforce CONCURRENCY = 1
    this._workerRunning = true;
    try {
      while (this._queue.length) {
        const item = this._queue[0];
        let result;
        try { result = await this._processItem(item); }
        catch (e) { this._lastError = (e && e.message) || String(e); result = this._makeEntry(item.key, null, 'error', cfg.errorTtlMs); }
        if (result === 'requeue' && item.attempts + 1 < MAX_ATTEMPTS) {
          item.attempts++;            // leave at the front; pacing/pause gates the retry
          continue;
        }
        if (result === 'requeue') result = this._makeEntry(item.key, null, 'error', cfg.errorTtlMs);
        this._finish(item, result);
      }
    } finally {
      this._workerRunning = false;
    }
  }

  /** Resolve an item's waiters with its entry, remove it from the queue, persist. */
  _finish(item, entry) {
    const idx = this._queue.indexOf(item);
    if (idx >= 0) this._queue.splice(idx, 1);
    for (const w of item.waiters) { try { w(entry); } catch (e) {} }
    this.persist();
  }

  /** Block until minRequestSpacingMs has elapsed since the last request AND any
   *  active 429 pause has expired (re-checked in a loop since either can move). */
  async _respectPacing() {
    for (;;) {
      const now = Date.now();
      let wait = 0;
      if (this._pauseUntil > now) wait = Math.max(wait, this._pauseUntil - now);
      const since = now - (this._lastRequestAt || 0);
      const spacing = cfg.minRequestSpacingMs || 1500;
      if (since < spacing) wait = Math.max(wait, spacing - since);
      if (wait <= 0) return;
      await this._sleep(wait);
    }
  }

  /** Fetch + classify a single player's stats. Returns a cache entry, or the string
   *  'requeue' on a 429 (which is NOT cached — the item is retried after backoff). */
  async _processItem(item) {
    // The ONLY per-player call: GET /stats/player?playerName=<URL-encoded>.
    // _pacedGet owns pacing/backoff + stamps _lastRequestAt.
    let res;
    try {
      res = await this._pacedGet('/stats/player?playerName=' + encodeURIComponent(item.query));
    } catch (e) {
      // network error / timeout / abort → transient error entry (short TTL)
      this._lastError = (e && e.name === 'AbortError') ? 'request timeout' : ((e && e.message) || 'network error');
      return this._makeEntry(item.key, null, 'error', cfg.errorTtlMs);
    }
    const st = res.status;
    if (st === 200) {
      this._resetBackoff();
      let json = null;
      try { json = await res.json(); } catch (e) { json = null; }
      // A 200 with an empty/absent body is effectively no-data, not a real profile.
      if (!json || (typeof json === 'object' && Object.keys(json).length === 0)) {
        return this._makeEntry(item.key, null, 'no-data', cfg.negativeTtlMs);
      }
      return this._makeEntry(item.key, json, 'ok', cfg.cacheTtlMs, json); // positive cache
    }
    if (st === 204 || st === 404) {   // known no-data/unknown player → negative cache (NOT score 0)
      this._resetBackoff();
      this._drain(res);
      return this._makeEntry(item.key, null, 'no-data', cfg.negativeTtlMs);
    }
    if (st === 400) {                 // bad request → cache an error for a short while
      this._resetBackoff();
      this._drain(res);
      this._lastError = 'HTTP 400';
      return this._makeEntry(item.key, null, 'error', cfg.errorTtlMs);
    }
    if (st === 429) {                 // rate limited → DO NOT cache; back off + requeue
      this._drain(res);
      this._triggerBackoff();
      this._lastError = 'HTTP 429 (rate limited)';
      return 'requeue';
    }
    // Any other status (5xx, etc.): transient error entry so we don't hammer it.
    this._drain(res);
    this._lastError = 'HTTP ' + st;
    return this._makeEntry(item.key, null, 'error', cfg.errorTtlMs);
  }

  /** Build + cache an entry, tagging prio/isBot from the current prior sets (by
   *  lowercased name and, when available, uuid from the stats payload). */
  _makeEntry(key, apiStats, status, ttl, json) {
    const now = Date.now();
    const rawUuid = json && (json.uuid || json.playerUuid || json.id);
    const uuid = rawUuid ? String(rawUuid).toLowerCase() : null;
    const entry = {
      apiStats: apiStats || null,
      uuid, // kept so prio/isBot can be re-derived from LIVE prior sets at read time
      prio: this._prio(key, uuid),
      isBot: this._isBot(key, uuid),
      status,
      fetchedAt: now,
      _expires: now + (ttl || 0),
    };
    this._cache.set(key, entry);
    return entry;
  }

  _prio(key, uuid) {
    if (!this._priorsAt) return null; // priors never loaded → unknown, not false
    return this._prioSet.has(key) || (!!uuid && this._prioSet.has(uuid));
  }
  _isBot(key, uuid) {
    return this._botSet.has(key) || (!!uuid && this._botSet.has(uuid));
  }

  // ── 429 backoff (jittered exponential, doubling to backoffMaxMs) ────────────

  _triggerBackoff() {
    const startMs = cfg.backoffStartMs || 2000;
    const maxMs = cfg.backoffMaxMs || 60000;
    const cur = this._backoffMs || startMs;
    // Full jitter within the current window so retries don't synchronize.
    const paused = Math.floor(cur * (0.5 + Math.random() * 0.5));
    this._pauseUntil = Date.now() + paused;
    this._backoffMs = Math.min(maxMs, cur * 2);
  }
  _resetBackoff() { this._backoffMs = cfg.backoffStartMs || 2000; }

  // ── low-level HTTP (global fetch, same as proxy/ProxyPool.js) ───────────────

  /** Serialize a request through the global gate: one outbound call at a time,
   *  each honoring minRequestSpacingMs + any active 429 pause. Priors and player
   *  fetches share this gate so NOTHING can sidestep the shared-IP rate budget. */
  _pacedGet(path_) {
    const prev = this._gate;
    let release;
    this._gate = new Promise((r) => { release = r; });
    return (async () => {
      await prev;
      try {
        await this._respectPacing();
        this._lastRequestAt = Date.now();
        return await this._get(path_);
      } finally {
        release();
      }
    })();
  }

  /** GET cfg.apiBase + path with an AbortController timeout and JSON headers. */
  async _get(path_) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs || 8000);
    try {
      return await fetch((cfg.apiBase || '') + path_, {
        signal: controller.signal,
        headers: { 'User-Agent': cfg.userAgent || '', 'Accept': 'application/json' },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Paced GET + parse JSON; returns null on any non-200 or parse failure (fail-open).
   *  A 429 here triggers the same global backoff as the player-fetch path. */
  async _getJson(path_) {
    const res = await this._pacedGet(path_);
    if (res.status === 429) {
      this._drain(res);
      this._triggerBackoff();
      this._lastError = 'HTTP 429 (rate limited)';
      return null;
    }
    if (res.status !== 200) { this._drain(res); return null; }
    try { return await res.json(); } catch (e) { return null; }
  }

  /** Discard an unread response body so the keep-alive socket can be reused. */
  _drain(res) {
    try { if (res && res.body && typeof res.body.cancel === 'function') res.body.cancel(); } catch (e) {}
  }

  // ── priors helpers ─────────────────────────────────────────────────────────

  /** Kick refreshPriors() (fire-and-forget) if the prior sets are missing/stale. */
  _maybeRefreshPriors() {
    if (!cfg.enabled) return;
    if (this._priorsInFlight) return;
    if (this._priorsRetryAt && Date.now() < this._priorsRetryAt) return; // failed recently — hold off
    if (this._priorsAt && Date.now() - this._priorsAt < (cfg.priorsTtlMs || 1800000)) return;
    this.refreshPriors().catch(() => {}); // never let priors reject bubble out
  }

  /** Add lowercased names AND uuids from a priority/bots payload into `set`.
   *  Tolerates an array of strings, an array of objects, or a { results:[…] } wrap. */
  _collectNames(data, set) {
    let arr = data;
    if (!Array.isArray(arr)) {
      if (arr && Array.isArray(arr.results)) arr = arr.results;
      else if (arr && Array.isArray(arr.players)) arr = arr.players;
      else return;
    }
    for (const it of arr) {
      if (it == null) continue;
      if (typeof it === 'string') { set.add(it.toLowerCase()); continue; }
      const name = it.playerName || it.name || it.username;
      const uuid = it.uuid || it.playerUuid || it.id;
      if (name) set.add(String(name).toLowerCase());
      if (uuid) set.add(String(uuid).toLowerCase());
    }
  }

  // ── persistence ────────────────────────────────────────────────────────────

  _writeNow() {
    try {
      const entries = {};
      for (const [k, e] of this._cache) entries[k] = e;
      writeJsonAtomic(cfg.persistPath, { v: 1, savedAt: Date.now(), entries });
    } catch (e) {
      this._lastError = (e && e.message) || 'persist error';
    }
  }

  /** Seed the cache from disk (fail-open: any error → start empty). Expired entries
   *  are dropped on load; nothing is fetched here. */
  _load() {
    try {
      if (!cfg.persistPath) return;
      const raw = fs.readFileSync(path.resolve(cfg.persistPath), 'utf-8');
      const data = JSON.parse(raw);
      const entries = data && data.entries;
      if (!entries || typeof entries !== 'object') return;
      const now = Date.now();
      for (const k of Object.keys(entries)) {
        const e = entries[k];
        if (!e || typeof e !== 'object') continue;
        if (e._expires != null && now >= e._expires) continue; // skip already-expired
        this._cache.set(k, e);
      }
    } catch (e) { /* no cache yet / unreadable → start empty */ }
  }

  /** Pacing/backoff sleeps stay REF'd — in-progress queue work should keep the
   *  process alive (unref'ing them makes bare scripts exit mid-fetch). Pass
   *  {unref:true} only for guard timers that must never hold the process open. */
  _sleep(ms, { unref = false } = {}) {
    return new Promise((r) => {
      const t = setTimeout(r, ms);
      if (unref && t.unref) t.unref();
    });
  }
}

module.exports = new WealthEstimator();
