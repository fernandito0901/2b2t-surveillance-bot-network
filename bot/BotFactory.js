/**
 * bot/BotFactory.js — Creates a mineflayer instance that connects (offline) to a
 * local ZenithProxy endpoint to observe/monitor.
 *
 * No plugins and no SOCKS proxy here: mineflayer talks to localhost, and
 * per-account outbound proxying to 2b2t is ZenithProxy's job, not this one.
 * (See ARCHITECTURE.md.)
 */
const mineflayer = require('mineflayer');
const config = require('../config');
const { Logger } = require('../logging/Logger');

class BotFactory {
  /**
   * @param {object} account - { id, email, username, upstream?: { host, port } }
   * @returns {Promise<{ bot: import('mineflayer').Bot, logger: Logger }>}
   */
  static async create(account) {
    // Console tag = the bot's real IGN (displayName survives the username being
    // overwritten with the shared spectator identity below the orchestrator); the
    // stable account.id stays the DATA attribution key (activity JSONL botId).
    const logger = new Logger(account.id, account.displayName || account.username);

    // Per-account upstream = its ZenithProxy port; fall back to global default.
    const host = account.upstream?.host || config.server.host;
    const port = account.upstream?.port || config.server.port;
    logger.info(`Connecting spectator → ${host}:${port}`);

    const bot = mineflayer.createBot({
      host,
      port,
      version: config.server.version,
      auth: config.server.auth,
      viewDistance: config.gameplay.monitorViewDistance, // low: save RAM, detection unaffected
      // Offline (through ZenithProxy) uses a plain username, not the MS email.
      username: config.server.auth === 'offline'
        ? (account.username || account.id)
        : account.email,
      profilesFolder: `./data/auth_cache/${account.id}`,
      onMsaCode: (data) => {
        logger.info(`🚨 LOGIN REQUIRED for ${account.email}: ${data.message}`);
      },
      respawn: false,
    });

    bot._accountId = account.id;
    bot._account = account;
    bot._logger = logger;

    bot.on('login', () => logger.info('Connected.'));
    bot.on('error', (err) => logger.error('Bot error:', err.message));
    bot.on('kicked', (reason) =>
      logger.warn('Kicked:', typeof reason === 'object' ? JSON.stringify(reason) : reason));
    bot.on('end', (reason) => logger.info('Disconnected:', reason));

    // NOTE: no death-cause chat handler here. It keyed on `message.includes(bot.username)`,
    // but bot.username is the shared spectator IGN while 2b2t's death broadcast names the
    // ACCOUNT — so it could never match. Real death detection lives in index.js
    // `_parseDeaths`, which reads the ZenithProxy pane (see SYSTEM_AUDIT #6/#37).

    return { bot, logger };
  }
}

module.exports = BotFactory;
