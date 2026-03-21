import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

const STATE_DIRS = ['store', 'groups', 'logs'];
const LOCK_FILE = '.migration-lock';

/**
 * Migrate legacy single-instance plugin state into instances/default/.
 * Called once at startup when CLAUDE_PLUGIN_DATA is set.
 * No-op if instances/ already exists or if no legacy state found.
 *
 * Uses an advisory lock file to prevent concurrent migrations.
 * Writes instances.json first (sentinel) so partial migrations
 * are detectable and the instances/ guard catches them on retry.
 */
export function migrateToInstances(pluginData: string): void {
  const instancesDir = path.join(pluginData, 'instances');
  const lockPath = path.join(pluginData, LOCK_FILE);

  // Already migrated
  if (fs.existsSync(instancesDir)) return;

  // Check for legacy state
  const hasLegacyState = STATE_DIRS.some(d => fs.existsSync(path.join(pluginData, d)))
    || fs.existsSync(path.join(pluginData, '.env'));

  if (!hasLegacyState) return;

  // Advisory lock — prevent concurrent migrations
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); // fails if exists
  } catch {
    logger.warn('Migration lock exists — another process may be migrating. Waiting...');
    // Wait briefly, then check if migration completed
    for (let i = 0; i < 10; i++) {
      if (fs.existsSync(instancesDir)) {
        return; // Migration completed by other process
      }
      const start = Date.now();
      while (Date.now() - start < 500) { /* busy wait 500ms */ }
    }
    logger.error('Migration lock held too long. Remove manually: ' + lockPath);
    return;
  }

  try {
    logger.info('Migrating legacy plugin state to instances/default/');

    const defaultDir = path.join(instancesDir, 'default');
    fs.mkdirSync(defaultDir, { recursive: true });

    // Write instances.json first as a sentinel — if we crash after this,
    // the instancesDir guard will catch it on next start
    const config = {
      default: 'default',
      instances: {
        default: {
          created_at: new Date().toISOString(),
          description: 'Migrated from single-instance',
          last_used: new Date().toISOString(),
        },
      },
    };
    fs.writeFileSync(path.join(pluginData, 'instances.json'), JSON.stringify(config, null, 2));

    // Move state directories
    for (const dir of STATE_DIRS) {
      const src = path.join(pluginData, dir);
      if (fs.existsSync(src)) {
        fs.renameSync(src, path.join(defaultDir, dir));
      }
    }

    // Move .env
    const envSrc = path.join(pluginData, '.env');
    if (fs.existsSync(envSrc)) {
      fs.renameSync(envSrc, path.join(defaultDir, '.env'));
    }

    logger.info('Migration complete — state now at instances/default/');
  } finally {
    // Always remove lock
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  }
}
