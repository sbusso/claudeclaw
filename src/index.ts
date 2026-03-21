/**
 * MotherClaw — Persistent agent orchestrator for Claude Code.
 */

// Load channels (self-registering on import)
import './channels/index.js';

// Load extensions (self-registering on import)
import './triage/index.js';

// Start the orchestrator
import { main } from './orchestrator/message-loop.js';

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
