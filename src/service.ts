/**
 * MotherClaw Service — Background orchestrator entry point.
 * Run by launchd (macOS) or systemd (Linux) as a persistent service.
 *
 * This is the process that polls for messages, spawns agents, and routes responses.
 * Start with: node dist/service.js
 * Dev mode:   npx tsx src/service.ts
 *
 * IMPORTANT: Uses dynamic imports to guarantee migration runs before
 * channels/extensions load. Static imports are hoisted in ES modules,
 * which would cause config.ts to resolve STATE_ROOT before migration.
 */

import { migrateToInstances } from './orchestrator/instance-migration.js';

// Migrate legacy single-instance plugin state before anything else
if (process.env.CLAUDE_PLUGIN_DATA) {
  migrateToInstances(process.env.CLAUDE_PLUGIN_DATA);
}

// Dynamic imports: channels and extensions self-register on import,
// and they pull in config.ts which computes STATE_ROOT.
// Migration MUST complete before these resolve.
async function start(): Promise<void> {
  // Load channels (self-registering on import)
  await import('./channels/index.js');

  // Load extensions (self-registering on import)
  await import('./triage/index.js');
  await import('./cost-tracking/index.js');
  await import('./webhook/index.js');

  // Start the orchestrator
  const { main } = await import('./orchestrator/message-loop.js');
  await main();
}

start().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
