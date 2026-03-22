import { registerExtension } from '../orchestrator/extensions.js';
import { WEBHOOK_SECRET } from '../orchestrator/config.js';
import { logger } from '../orchestrator/logger.js';

// Only register if webhook secret is configured
if (WEBHOOK_SECRET) {
  registerExtension({
    name: 'webhook',
    onStartup: (deps) => {
      const { sendMessage, findChannel } = deps;
      // We need group lookup and queue — wire via deps
      // The extension startup receives limited deps, so we store the server reference
      // and let message-loop wire the full deps
      logger.info('Webhook extension registered (will start on main init)');
    },
    dbSchema: [
      `CREATE TABLE IF NOT EXISTS webhook_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_folder TEXT NOT NULL,
        payload TEXT NOT NULL,
        received_at TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        run_status TEXT,
        error TEXT
      )`,
    ],
  });
} else {
  logger.debug('Webhook extension skipped (WEBHOOK_SECRET not set)');
}
