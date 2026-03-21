import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

const STATE_DIRS = ['store', 'groups', 'logs'];

/**
 * Migrate legacy single-instance plugin state into instances/default/.
 * Called once at startup when CLAUDE_PLUGIN_DATA is set.
 * No-op if instances/ already exists or if no legacy state found.
 */
export function migrateToInstances(pluginData: string): void {
  const instancesDir = path.join(pluginData, 'instances');

  // Already migrated
  if (fs.existsSync(instancesDir)) return;

  // Check for legacy state
  const hasLegacyState = STATE_DIRS.some(d => fs.existsSync(path.join(pluginData, d)))
    || fs.existsSync(path.join(pluginData, '.env'));

  if (!hasLegacyState) return;

  logger.info('Migrating legacy plugin state to instances/default/');

  const defaultDir = path.join(instancesDir, 'default');
  fs.mkdirSync(defaultDir, { recursive: true });

  for (const dir of STATE_DIRS) {
    const src = path.join(pluginData, dir);
    if (fs.existsSync(src)) {
      fs.renameSync(src, path.join(defaultDir, dir));
    }
  }

  const envSrc = path.join(pluginData, '.env');
  if (fs.existsSync(envSrc)) {
    fs.renameSync(envSrc, path.join(defaultDir, '.env'));
  }

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

  logger.info('Migration complete — state now at instances/default/');
}
