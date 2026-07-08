/**
 * logging/Logger.js — Structured logging for the bot network.
 * Per-bot colored console output + JSONL activity files.
 */
const fs = require('fs');
const path = require('path');
const util = require('util');
const chalk = require('chalk');
const config = require('../config');
const EventEmitter = require('events');

const loggerEvents = new EventEmitter();

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[config.logging.level] || LEVELS.info;

// Coalesce identical consecutive console lines ("last message repeated N times")
// so a stuck retry loop can't bury real events / balloon app.log. Opt-out with
// config.logging.coalesce = false. A running summary is flushed at most every
// COALESCE_FLUSH_EVERY repeats so a long burst still surfaces periodically.
const COALESCE = (config.logging.coalesce !== false);
const COALESCE_FLUSH_EVERY = 100;
// Also flush a pending run after this idle gap, so a burst that stops BELOW the
// every-100 threshold (e.g. 40 "Connecting…" then quiet) still surfaces its count
// instead of being silently swallowed until some other line happens to arrive.
const COALESCE_IDLE_FLUSH_MS = 10000;

// Console tag column width: fits a 16-char IGN in brackets; shorter tags pad out so
// every message starts at the same column.
const TAG_WIDTH = 18;

// Color palette for distinguishing bots in console
const BOT_COLORS = [
  chalk.cyan, chalk.magenta, chalk.yellow, chalk.green,
  chalk.blue, chalk.red, chalk.white, chalk.gray,
];
let colorIndex = 0;
const botColors = {};

function getColor(botId) {
  if (!botColors[botId]) {
    botColors[botId] = BOT_COLORS[colorIndex % BOT_COLORS.length];
    colorIndex++;
  }
  return botColors[botId];
}

class Logger {
  /**
   * @param {string} botId - stable id used for DATA attribution (activity JSONL botId)
   * @param {string} [label] - human display name for the console tag (e.g. the bot's
   *   IGN). Falls back to botId. Console lines show the label; stored data keeps the id.
   */
  constructor(botId, label) {
    this.botId = botId;
    this.color = getColor(botId);
    // Bracketed tag padded to a fixed column so messages line up whatever the
    // name length — scanning a mixed [SYSTEM]/[IGN] log stays columnar.
    this.prefix = this.color(`[${label || botId}]`.padEnd(TAG_WIDTH));
    // Coalescing state (per logger instance).
    this._lastKey = null;      // level + rendered message of the last emitted line
    this._repeatCount = 0;     // consecutive identical lines suppressed since then
    this._lastEmit = null;     // { method, label } to reprint the "repeated" summary at the right level
    this._flushTimer = null;   // idle-flush handle so a stalled burst still prints its count
  }

  _shouldLog(level) {
    return (LEVELS[level] || 0) >= currentLevel;
  }

  /** ISO timestamp — for STORED data (activity JSONL). Machine-parseable, never
   *  changed for display reasons. */
  _timestamp() {
    return new Date().toISOString();
  }

  /** Console timestamp: `YYYY-MM-DD HH:MM:SS` — the ISO "T"/"Z"/millis carry no
   *  operator value and made every line start with 24 chars of noise. */
  _displayTs() {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
  }

  /** Write one line in the standard format: <ts> <LEVEL> <tag> <...args>.
   *  Level comes right after the time (fixed width) so WARN/ERROR pop in a column
   *  instead of hiding mid-line behind a variable-length tag. */
  _writeLine(method, label, args) {
    method(chalk.gray(this._displayTs()), label, this.prefix, ...args);
  }

  /** Flush a pending run of suppressed duplicates as a single summary line. */
  _flushRepeat() {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    const n = this._repeatCount;
    this._repeatCount = 0;
    if (n <= 0 || !this._lastEmit) return;
    const { method, label } = this._lastEmit;
    this._writeLine(method, label, [chalk.gray(`(last message repeated ${n} time${n === 1 ? '' : 's'})`)]);
  }

  /** Shared gate + optional coalescing for the console levels. */
  _log(method, label, level, args) {
    if (!this._shouldLog(level)) return;
    if (COALESCE) {
      const key = level + ' ' + util.format(...args); // level+message identity for coalescing
      if (key === this._lastKey) {
        this._repeatCount++;
        if (this._repeatCount >= COALESCE_FLUSH_EVERY) { this._flushRepeat(); return; }
        // Arm (once) an idle flush so a burst that goes quiet below the threshold still
        // prints its "(repeated N times)" summary rather than vanishing.
        if (!this._flushTimer) {
          this._flushTimer = setTimeout(() => { this._flushTimer = null; this._flushRepeat(); }, COALESCE_IDLE_FLUSH_MS);
          if (this._flushTimer.unref) this._flushTimer.unref();
        }
        return;
      }
      // A different line arrived — summarize the previous run before printing it.
      if (this._repeatCount > 0) this._flushRepeat();
      this._lastKey = key;
      this._lastEmit = { method, label };
    }
    this._writeLine(method, label, args);
  }

  // Level labels are bare fixed-width words (no brackets) — they sit in their own
  // column right after the time, so WARN/ERROR scan vertically.
  debug(...args) {
    this._log(console.log, chalk.gray('DEBUG'), 'debug', args);
  }

  info(...args) {
    this._log(console.log, chalk.blue('INFO '), 'info', args);
  }

  warn(...args) {
    this._log(console.warn, chalk.yellow('WARN '), 'warn', args);
  }

  error(...args) {
    this._log(console.error, chalk.red('ERROR'), 'error', args);
  }

  /**
   * Log a player detection event to the activity JSONL file.
   * @param {string} spotId - The monitoring spot ID
   * @param {object} detection - { playerName, x, y, z, direction, heading, speed, distance, equipment }
   */
  logActivity(spotId, detection) {
    const activityDir = path.resolve(config.logging.activityDir);
    if (!fs.existsSync(activityDir)) {
      fs.mkdirSync(activityDir, { recursive: true });
    }

    const date = new Date().toISOString().slice(0, 10);
    const filePath = path.join(activityDir, `${spotId}_${date}.jsonl`);

    const entry = {
      timestamp: this._timestamp(),
      botId: this.botId,
      spotId,
      ...detection,
    };

    try {
      fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
      loggerEvents.emit('activity', entry);
    } catch (err) {
      this.error('Failed to write activity log:', err.message);
    }
  }
}

/** System-level logger (not associated with any bot) */
class SystemLogger extends Logger {
  constructor() {
    super('SYSTEM');
    this.prefix = chalk.bold.white('[SYSTEM]'.padEnd(TAG_WIDTH));
  }
}

module.exports = { Logger, SystemLogger, systemLogger: new SystemLogger(), loggerEvents };
