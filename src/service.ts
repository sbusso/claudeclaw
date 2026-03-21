/**
 * MotherClaw Service — Background orchestrator entry point.
 * Run by launchd (macOS) or systemd (Linux) as a persistent service.
 *
 * This is the process that polls for messages, spawns agents, and routes responses.
 * Start with: node dist/service.js
 * Dev mode:   npx tsx src/service.ts
 */

// Load channels (self-registering on import)
import './channels/index.js';

// Load extensions (self-registering on import)
import './triage/index.js';
import './cost-tracking/index.js';
import './webhook/index.js';

// Start the orchestrator
import { main } from './orchestrator/message-loop.js';

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
