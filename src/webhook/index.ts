import { registerExtension } from '../orchestrator/extensions.js';
import { WEBHOOK_SECRET } from '../orchestrator/config.js';
import { logger } from '../orchestrator/logger.js';

// Register webhook extension for DB schema only.
// The webhook server itself is started in message-loop.ts main()
// using the MessageIngestion service.
if (WEBHOOK_SECRET) {
  registerExtension({
    name: 'webhook',
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
