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
