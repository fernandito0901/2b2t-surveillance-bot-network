/**
 * lib/parsers.js — Pure parsers for ZenithProxy tmux-pane output.
 *
 * These were the fragile, regex-driven bits that silently broke when ZenithProxy's
 * output format changed (the device-code format, etc.). Kept dependency-free and
 * unit-tested (test/run.js) so a format change is caught instead of shipping blind.
 */

/** Drop player-chat lines ("[Chat] [INFO] <name> …") from a pane block. 2b2t chat is
 *  ATTACKER-CONTROLLED, so any signal that comes from ZenithProxy's own terminal/module
 *  output (device code, visualRange, kick reason, login IGN) must be matched only against
 *  NON-chat lines — otherwise a passing player can forge it by typing it in chat. (Server
 *  broadcasts are "[Chat] [INFO] …" WITHOUT a "<name>" and are kept; only "<name>" player
 *  messages are removed.) Does NOT affect in-world detection, which legitimately keys off
 *  chat existing at all. */
function withoutPlayerChat(text) {
  return String(text).split('\n').filter(l => !/\[Chat\][^\n]*<[^>]+>/.test(l)).join('\n');
}

/** The most recent "Position in queue: N" in the text, or null. */
function lastQueuePosition(text) {
  const m = [...String(text).matchAll(/Position in queue:\s*(\d+)/g)];
  return m.length ? parseInt(m[m.length - 1][1], 10) : null;
}

/** A device-code login prompt → { url, code }, or null. Supports the newer URL form
 *  (.../link?otc=CODE) and the older "Login Here: <url> with code: <CODE>". Player-chat
 *  lines are stripped first so a griefer can't forge an attacker-controlled login URL. */
function deviceCode(text) {
  const s = withoutPlayerChat(text);
  const dc = s.match(/Login Here:\s*(\S*[?&]otc=([A-Za-z0-9]+))/i)
    || s.match(/Login Here:\s*(\S+)\s*with code:\s*(\S+)/i);
  return dc ? { url: dc[1], code: dc[2] } : null;
}

/** True if the recent pane text indicates the account is in-world (not queuing). */
function isInGame(text) {
  const s = String(text);
  return /Connected to the server|connected to 2b2t|joined the game/i.test(s)
    || /\[Chat\]\s*\[INFO\]\s*</.test(s);
}

/** A ZenithProxy native visualRange alert line → { player, kind: enter|leave|logout }, or null.
 *  Rejects [Chat]/"<name>" lines so a passing player can't forge a sighting by typing the
 *  visualRange text in chat (real VR lines are "[Module] [WARN] [VisualRange] …", never chat). */
function visualRangeEvent(line) {
  const s = String(line);
  if (/\[Chat\]|</.test(s)) return null;
  const m = s.match(/\[VisualRange\]\s+(\S+)\s+(entered visual range|left visual range|logged out)/i);
  if (!m) return null;
  const kind = /entered/i.test(m[2]) ? 'enter' : (/logged out/i.test(m[2]) ? 'logout' : 'leave');
  return { player: m[1], kind };
}

/** "Logged in as <IGN>" → the cleaned IGN, or null. Player-chat lines are stripped first so
 *  a griefer can't set the account's captured IGN by typing "Logged in as <name>" in chat. */
function loggedInAs(text) {
  const m = withoutPlayerChat(text).match(/Logged in as\s+(\S+)/i);
  return m ? m[1].replace(/[.\[\]]/g, '').trim() : null;
}

// 2b2t replaces vanilla death messages with custom flavour text ("…tripped, broke a
// bone or died somehow inside lava.") and kill messages often put the KILLER first, so
// the wording is unreliable to match. The robust signal is ZenithProxy's own
// AutoRespawn module: it logs "[AutoRespawn] Performing Respawn" only when OUR account
// dies. We trigger on that, then read the cause from the nearby broadcast naming us.

/** A ZenithProxy "Player Death" terminal marker — printed only when OUR account dies
 *  (other players' deaths appear only in chat). It anchors a contiguous block whose
 *  cause, coordinates and dimension sit on the surrounding lines, so it's reliable even
 *  when AutoRespawn fires many lines later (after a respawn delay + busy chat). */
function isPlayerDeath(line) {
  const s = String(line).trim();
  // Match the marker at the END of the line so a future timestamp/tag prefix
  // (as ZenithProxy adds to most lines) can't silently disable ALL death
  // detection. Never on a [Chat] <player> line, so a passing player typing
  // "Player Death" can't forge OUR account's death.
  if (/\[Chat\]|</.test(s)) return false;
  return s.endsWith('Player Death');
}

/** A death-block coordinate line "||[x, y, z]||" → { x, y, z }, or null. */
function deathCoords(line) {
  const m = String(line).match(/\|\|\[\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\s*\]\|\|/);
  return m ? { x: +m[1], y: +m[2], z: +m[3] } : null;
}

/** If `line` is a 2b2t death/kill broadcast (a [Chat] [INFO] line, NOT <player> chat)
 *  that names `ign`, return its text as the cause; else null. Wording varies and the
 *  victim isn't always first, so we only require our IGN to appear in a server
 *  broadcast — used solely to label a death already confirmed by respawnPerformed. */
function deathBroadcast(line, ign) {
  const s = String(line);
  const i = s.indexOf('[Chat]');
  if (i === -1) return null;
  const body = s.slice(i).replace(/\[Chat\]\s*(?:\[[A-Z]+\]\s*)?/, '').trim();
  if (!body || body[0] === '<') return null; // <player> chat, not a server broadcast
  const re = new RegExp('\\b' + String(ign).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
  return re.test(body) ? body : null;
}

/** In-world vs queue by recency. The queue prints "Position in queue" periodically;
 *  in-world produces chat / respawn lines. Whichever appears LAST wins — robust to a
 *  quiet in-world bot and to a cold start (app restart) where stale queue lines linger
 *  in the scrollback. Note: "Server teleport" and "Unknown legacy biome" are NOT
 *  in-world signals — the 2b2t End queue room emits them while still queuing, which
 *  would flip a queuing bot to in_game. "Queued for server 2b2t." is likewise a
 *  [Chat] [INFO] line the QUEUE prints on (re)entry, so it must not count as world
 *  chat. A "[Client] … Disconnected:" line NEWER than every world/queue signal means
 *  the bot just dropped — the hours of chat above it are stale, so that wins too
 *  (this stale-chat window after a drop kept re-attaching the monitor until
 *  ZenithProxy answered "Login Rate Limited"). Returns true (in-world), false (queue
 *  or a fresh drop is most recent), or null (no signal either way). */
function inWorldByRecency(text) {
  const s = String(text);
  const qIdx = s.lastIndexOf('Position in queue');
  let wIdx = -1, m;
  const re = /\[Chat\]\s*\[INFO\]\s*(?!Position in queue|Queued for server)\S|Connected to the server|joined the game|\[AutoRespawn\]/gi;
  while ((m = re.exec(s))) wIdx = m.index;
  let dIdx = -1;
  // Lookbehind rejects "[Client] … Disconnected:" typed INSIDE a chat line (which
  // starts with "[Chat] [INFO] <name>"), so a griefer can't forge a drop that would
  // flip our state to queuing and detach the monitor.
  const dre = /(?<!\[Chat\][^\n]*)\[Client\][^\n]*\]\s*Disconnected:/g;
  while ((m = dre.exec(s))) dIdx = m.index;
  if (qIdx === -1 && wIdx === -1) return null;
  if (dIdx > wIdx && dIdx > qIdx) return false; // dropped after everything → not in-world
  return wIdx > qIdx;
}

/** Map a recent disconnect line in the pane to a human-readable reason, or null.
 *  Order matters — the session-limit kick also prints "lost connection", so the more
 *  specific reasons are checked first. */
function kickReason(text) {
  // Strip player chat so a passing player can't forge a kick/ban alert by typing e.g.
  // "banned from this server" in chat — real kick lines are ZenithProxy/[Client] output.
  const s = withoutPlayerChat(text);
  if (/non-?prio(rity)? session time limit/i.test(s)) return "hit 2b2t's non-priority session time limit (the free-account cap — happens anywhere in the world)";
  if (/you are (permanently )?banned|banned from (this )?server/i.test(s)) return 'account appears BANNED — check it';
  if (/server (is )?restart/i.test(s)) return '2b2t restarted';
  if (/Connection reset by peer/i.test(s)) return 'connection reset by 2b2t (server-side blip)';
  if (/timed out|read timed out|\btimeout\b/i.test(s)) return 'connection timed out';
  if (/Cancelling AutoReconnect|not reconnectable/i.test(s)) return 'ZenithProxy stopped reconnecting (likely a proxy/auth issue)';
  if (/lost connection to the server/i.test(s)) return 'lost connection to 2b2t';
  return null;
}

/** A real BOT disconnect from 2b2t — the [Client] side losing the server connection →
 *  { reason }, or null. Excludes "[Server] Player disconnected: <name>" (that's a client
 *  such as you or the monitor leaving the proxy, NOT the bot itself dropping). */
function disconnectEvent(line) {
  const s = String(line);
  // Chat lines can't be drop events: a passing player typing "[Client] [INFO]
  // Disconnected: …" in chat must not forge a drop alert. Real client-drop lines
  // are ZenithProxy's own "[ts] [Client] [INFO] Disconnected: …" — never chat.
  if (/\[Chat\]/.test(s)) return null;
  const m = s.match(/\[Client\][^\]]*\]\s*Disconnected:\s*(.+?)\s*$/);
  if (!m) return null;
  const reason = m[1].replace(/-{3,}/g, '').trim(); // 2b2t's throttle msg is a row of dashes
  return { reason: reason || 'connection closed' };
}

/** True if a controlling player (you, driving) was logged in within this text block —
 *  lets a drop be tagged "while you were driving" vs "on its own". */
function controllerActive(text) {
  return /as controlling player/i.test(String(text));
}

module.exports = { lastQueuePosition, deviceCode, isInGame, visualRangeEvent, loggedInAs, isPlayerDeath, deathCoords, deathBroadcast, inWorldByRecency, kickReason, disconnectEvent, controllerActive };
