/**
 * MotherClaw Service — Background orchestrator entry point.
 * Run by launchd (macOS) or systemd (Linux) as a persistent service.
 *
 * This is the process that polls for messages, spawns agents, and routes responses.
 * Start with: node dist/service.js
 * Dev mode:   npx tsx src/service.ts
 *
 * The working directory IS the instance — all state (store/, groups/, .env)
 * lives in cwd. Multiple instances = multiple directories.
 */

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
