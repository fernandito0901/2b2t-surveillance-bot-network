/**
 * metrics/MetricsStore.js — Operational time-series for each account's ZenithProxy.
 *
 * Two streams, both append-only JSONL under data/metrics/ so they survive restarts:
 *   - samples: the account's coarse state (in-world / queuing / offline …) sampled
 *     by the tmux poller. Written on every state change + at most once a minute
 *     otherwise (so a steady state doesn't bloat the file). Drives availability %
 *     and the 24h state timeline.
 *   - events:  sparse, meaningful transitions (dropped from 2b2t, reached in-world,
 *     needs login, proxy swapped). Drives the drop count + events feed.
 *
 * In-memory we keep the last ~48h so the dashboard can render without re-reading
 * disk; older on-disk files are pruned on startup.
 *
 * IMPORTANT — the queryable window is the in-memory window (MAX_AGE_MS, ~48h), NOT
 * the on-disk retention (RETENTION_DAYS). All range queries (availability/segments/
 * queueSeries/countEvents/recentEvents) read only the in-memory series/events; the
 * on-disk JSONL exists for restart re-seeding and pruning, not for querying. Callers
 * (and the dashboard range selector) must clamp their range to availableWindowMs()
 * so a longer span (e.g. "7d") is never labelled over ≤48h of real data.
 */
const fs = require('fs');
const path = require('path');

// Compact one-letter codes for the poller states (kept short in the JSONL).
const CODE = { in_game: 'G', queuing: 'Q', login_required: 'L', offline: 'O', idle: 'I', starting: 'I' };
const MAX_AGE_MS = 48 * 60 * 60 * 1000;
const WRITE_INTERVAL_MS = 60 * 1000;   // persist a steady state at most once a minute
const RETENTION_DAYS = 14;             // prune on-disk metrics older than this
const MAX_EVENTS = 4000;               // in-memory events cap

class MetricsStore {
  constructor() {
    this.dir = path.resolve('./data/metrics');
    this.series = new Map();        // id → [{ t, s, q }]
    this.events = [];               // [{ t, id, type, detail }]
    this._last = new Map();         // id → { s, q, t }
    this._lastWrite = new Map();    // id → ts of last persisted sample
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (e) {}
    this._pruneFiles();
    this._load();
  }

  static code(state) { return CODE[state] || 'U'; }

  /** Record the current poller state for an account (called every tick). */
  recordSample(id, state, queuePosition) {
    const t = Date.now();
    const s = CODE[state] || 'U';
    const q = (queuePosition == null) ? null : queuePosition;
    let arr = this.series.get(id);
    if (!arr) { arr = []; this.series.set(id, arr); }
    arr.push({ t, s, q });
    this._pruneSeries(arr);
    const last = this._last.get(id);
    const changed = !last || last.s !== s;
    this._last.set(id, { s, q, t });
    const lw = this._lastWrite.get(id) || 0;
    if (changed || t - lw >= WRITE_INTERVAL_MS) {
      this._append('samples', { t, id, s, q });
      this._lastWrite.set(id, t);
    }
  }

  /** Record a sparse, meaningful event. type: drop|in_game|login_required|offline|proxy_swap|remediate */
  recordEvent(id, type, detail) {
    const e = { t: Date.now(), id, type, detail: detail || null };
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this._append('events', e);
  }

  // ── queries (sinceT = epoch ms lower bound) ──────────────────────────────

  current(id) { return this._last.get(id) || null; }

  /** The honest queryable window in ms: range queries read only the in-memory
   *  series (capped to MAX_AGE_MS), so no query can return more history than this
   *  regardless of the requested range. The dashboard caps its range selector to
   *  this so it never presents ≤48h of data as a longer span. */
  availableWindowMs() { return MAX_AGE_MS; }

  /** Collapse samples into [{ s, t0, t1 }] runs within [sinceT, now]; the final
   *  run is extended to now only if the last sample is fresh (else it's a gap). */
  segments(id, sinceT) {
    const arr = (this.series.get(id) || []).filter(p => p.t >= sinceT);
    const now = Date.now();
    if (!arr.length) return [];
    const segs = [];
    for (let i = 0; i < arr.length; i++) {
      const p = arr[i];
      const next = arr[i + 1];
      const end = next ? next.t : (now - p.t < 90 * 1000 ? now : p.t);
      if (segs.length && segs[segs.length - 1].s === p.s) segs[segs.length - 1].t1 = end;
      else segs.push({ s: p.s, t0: p.t, t1: end });
    }
    return segs;
  }

  /** Milliseconds spent in each state within range, keyed by code. */
  availability(id, sinceT) {
    const out = {};
    for (const seg of this.segments(id, sinceT)) {
      out[seg.s] = (out[seg.s] || 0) + Math.max(0, seg.t1 - Math.max(seg.t0, sinceT));
    }
    return out;
  }

  /** Downsampled queue-position points within range (for the sparkline). */
  queueSeries(id, sinceT, maxPoints = 240) {
    const pts = (this.series.get(id) || []).filter(p => p.t >= sinceT && p.q != null).map(p => ({ t: p.t, q: p.q }));
    if (pts.length <= maxPoints) return pts;
    const step = Math.ceil(pts.length / maxPoints);
    const out = [];
    for (let i = 0; i < pts.length; i += step) out.push(pts[i]);
    if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
    return out;
  }

  countEvents(id, type, sinceT) {
    return this.events.filter(e => e.id === id && e.type === type && e.t >= sinceT).length;
  }
  lastEvent(id, type) {
    for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i].id === id && this.events[i].type === type) return this.events[i];
    return null;
  }
  recentEvents(sinceT, limit = 200, ids = null) {
    const set = ids ? new Set(ids) : null;
    const out = [];
    for (let i = this.events.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.events[i];
      if (e.t < sinceT) break;
      if (set && !set.has(e.id)) continue;
      out.push(e);
    }
    return out;
  }

  // ── persistence ──────────────────────────────────────────────────────────

  _file(kind, date) { return path.join(this.dir, `${kind}-${date}.jsonl`); }
  _today() { return new Date().toISOString().slice(0, 10); }

  _append(kind, obj) {
    try { fs.appendFileSync(this._file(kind, this._today()), JSON.stringify(obj) + '\n'); } catch (e) {}
  }

  _pruneSeries(arr) {
    const cutoff = Date.now() - MAX_AGE_MS;
    let i = 0;
    while (i < arr.length && arr[i].t < cutoff) i++;
    if (i > 0) arr.splice(0, i);
  }

  /** Public: prune on-disk metrics beyond the retention window (called daily by the
   *  orchestrator's maintenance timer, not just at startup). */
  prune() { this._pruneFiles(); }

  /** Drop metrics files older than the retention window. */
  _pruneFiles() {
    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    let files = [];
    try { files = fs.readdirSync(this.dir); } catch (e) { return; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      try { if (fs.statSync(path.join(this.dir, f)).mtimeMs < cutoff) fs.unlinkSync(path.join(this.dir, f)); } catch (e) {}
    }
  }

  /** Seed in-memory series/events from the last 2 days of files (post-restart). */
  _load() {
    const days = [0, 1, 2].map(d => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10));
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const date of days.slice().reverse()) {
      this._loadFile('samples', date, cutoff, (o) => {
        if (!o.id || !o.t || o.t < cutoff) return;
        let arr = this.series.get(o.id);
        if (!arr) { arr = []; this.series.set(o.id, arr); }
        arr.push({ t: o.t, s: o.s, q: o.q == null ? null : o.q });
        this._last.set(o.id, { s: o.s, q: o.q, t: o.t });
      });
      this._loadFile('events', date, cutoff, (o) => {
        if (o.t && o.t >= cutoff) this.events.push(o);
      });
    }
    for (const arr of this.series.values()) arr.sort((a, b) => a.t - b.t);
    this.events.sort((a, b) => a.t - b.t);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  _loadFile(kind, date, cutoff, fn) {
    const fp = this._file(kind, date);
    let raw;
    try { raw = fs.readFileSync(fp, 'utf-8'); } catch (e) { return; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { fn(JSON.parse(line)); } catch (e) {}
    }
  }
}

module.exports = new MetricsStore();
