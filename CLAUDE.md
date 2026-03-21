# MotherClaw

Persistent agent orchestrator plugin for Claude Code.

## Architecture

```
src/
  index.ts                    # Entrypoint: DB → channels → extensions → message loop
  orchestrator/               # Core
    message-loop.ts           # THE HEART: poll, trigger, thread, queue, dispatch
    group-queue.ts            # Concurrency control for agent execution
    extensions.ts             # Pluggable extension system
    channel-registry.ts       # Channel self-registration
    db.ts                     # SQLite with extension schema support
    config.ts                 # Core config (from .env)
    env.ts                    # .env reader
    logger.ts                 # Pino logger
    types.ts                  # Core types (Channel, RegisteredGroup, NewMessage)
  channels/                   # Channel implementations
    slack.ts                  # Slack (Socket Mode, thread JIDs, reaction typing)
  triage/                     # Triage extension
    index.ts                  # Extension registration
    queue-db.ts               # Task queue DB operations
    swe-queue.ts              # Sequential SWE task processor
    ipc-handlers.ts           # queue_swe_task + set_github_issue → dev channel
```

## Key Concepts

- **Message loop** polls DB for new messages, checks triggers, dispatches to agents
- **GroupQueue** manages concurrent containers per group with retry/backoff
- **Thread auto-creation**: @mention on trigger-required channel → reply in thread → register thread with requiresTrigger: false
- **Extensions** register IPC handlers, startup hooks, DB schema, container env vars
- **Channels** self-register via `registerChannel()` on import

## Runtime Configuration

Set `RUNTIME` in `.env`:
- `container` (default) — runs agents in Apple Container / Docker
- `sandbox` — uses `@anthropic-ai/sandbox-runtime` (OS-level sandboxing, <10ms cold start)

Per-group override: set `"runtime": "sandbox"` in the registered group config.

### Sandbox Runtime Details

**Auth:** Sandbox passes real credentials directly (not through credential proxy). Network isolation via `allowedDomains` restricts outbound traffic to `api.anthropic.com` and `localhost` only, preventing credential exfiltration.

**Path mapping:** Container mode maps `/workspace/*` via volume mounts. Sandbox runs on the host, so the agent runner uses `MOTHERCLAW_*_DIR` env vars (`MOTHERCLAW_GROUP_DIR`, `MOTHERCLAW_IPC_DIR`, `MOTHERCLAW_PROJECT_DIR`, `MOTHERCLAW_GLOBAL_DIR`, `MOTHERCLAW_EXTRA_DIR`) to resolve actual host paths.

**Agent runner compilation:** Sandbox can't use `tsx` (blocked Unix sockets). Pre-compile with `cd container/agent-runner && npx tsc`. The compiled output at `container/agent-runner/dist/index.js` is used by sandbox; container mode uses its own copy baked into the image.

**srt settings schema:** The `--settings <path>` JSON file requires ALL fields including `allowRead: []` even if empty. Omitting causes silent schema validation failure. Key fields: `network.allowedDomains`, `network.deniedDomains`, `network.allowLocalBinding`, `filesystem.denyRead`, `filesystem.allowRead`, `filesystem.allowWrite`, `filesystem.denyWrite`.

**Config reading:** MotherClaw does NOT use `dotenv`. The `RUNTIME` value in `.env` is read via `readEnvFile()` in `config.ts`.

## Development

```bash
npm run build    # Compile TypeScript
npm run dev      # Run with tsx
npm test         # Run tests
```

## Extension System

```typescript
import { registerExtension } from '../orchestrator/extensions.js';
registerExtension({
  name: 'my-ext',
  ipcHandlers: { 'my_type': handler },
  onStartup: (deps) => { ... },
  dbSchema: ['CREATE TABLE IF NOT EXISTS ...'],
  containerEnvKeys: ['MY_KEY'],
});
```

Then import in `src/index.ts`.

## Troubleshooting

**Stale sessions after switching runtimes:** When switching between container and sandbox (or vice versa), existing session IDs may cause "No conversation found" errors. Clear with: `sqlite3 store/messages.db "DELETE FROM sessions"`

**Sandbox agent EPERM on network:** The srt settings `allowRead: []` field MUST be present (even empty). Without it, the entire settings file silently fails validation and network is fully blocked. Also verify `allowedDomains` includes `api.anthropic.com`.

**Sandbox agent can't find paths:** Check that `MOTHERCLAW_*_DIR` env vars are being set in `sandbox-runner.ts` `runSandboxAgent()`. The agent runner falls back to `/workspace/*` (container paths) if env vars are missing.
