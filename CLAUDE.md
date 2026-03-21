# MotherClaw

Persistent agent orchestrator plugin for Claude Code.

## Entry Points

Two separate entry points — plugin and service must not be conflated:

- **`src/index.ts`** → `dist/index.js` — **Plugin entry.** Loaded by Claude Code via `--plugin-dir`. Returns immediately, no side effects. No channel/extension imports.
- **`src/service.ts`** → `dist/service.js` — **Service entry.** Run by launchd/systemd as persistent background process. Imports channels/extensions, starts the message loop.

The plugin entry is what `.claude-plugin/plugin.json` points to. The service entry is what `npm start`, `npm run dev`, and the launchd plist/systemd unit run.

## Modes

MotherClaw runs in two modes, detected by `CLAUDE_PLUGIN_DATA`:

**Plugin mode** (`CLAUDE_PLUGIN_DATA` set):
- Loaded via `claude --plugin-dir /path/to/motherclaw`
- Supports multiple **instances** — each with isolated state
- State in `CLAUDE_PLUGIN_DATA/instances/<name>/` (store/, groups/, logs/, .env)
- Service per instance: `com.motherclaw.<name>.plist` (macOS), `motherclaw-<name>.service` (Linux)
- No git operations, no self-improvement
- Upgrade via `/customize` → fork + migrate

**Developer mode** (`CLAUDE_PLUGIN_DATA` not set):
- Cloned repo, `claude` runs from inside it
- State in project root (store/, groups/, logs/, .env)
- No instance concept — single instance only
- Full self-improvement — Claude edits its own source
- Git/fork workflow

### Instances (plugin mode only)

Each instance gets fully isolated state, its own background service, and can run simultaneously.

```
CLAUDE_PLUGIN_DATA/
  instances.json                    # default instance + metadata
  instances/
    personal/                       # Full isolated state
      .env, store/, groups/, logs/
    work/
      .env, store/, groups/, logs/
```

**Detection:** `MOTHERCLAW_INSTANCE` env var → `instances.json` default → `'default'`
**Commands:** `/instance-list`, `/instance-create`, `/instance-switch`, `/instance-delete`
**Migration:** Legacy single-instance state auto-moves to `instances/default/` on first service startup.

**Path resolution:** `STATE_ROOT` in config.ts resolves to `CLAUDE_PLUGIN_DATA/instances/<name>` (plugin) or `PROJECT_ROOT` (developer). `STORE_DIR`, `GROUPS_DIR`, `LOG_DIR` derive from `STATE_ROOT`. `readEnvFile()` checks `MOTHERCLAW_ENV_FILE` then `CLAUDE_PLUGIN_DATA/.env` then `cwd/.env`.

## Architecture

```
src/
  index.ts                    # Plugin entry (Claude Code --plugin-dir, non-blocking)
  service.ts                  # Service entry (launchd/systemd, runs message loop)
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
- **Webhook triggers** allow external systems to invoke agents via HTTP POST
- **Per-group agent config** customizes model, tools, system prompt, cost limits per group
- **Cost tracking** records token usage, estimated cost, duration per agent run

## Runtime Configuration

Set `RUNTIME` in `.env`:
- `container` (default) — runs agents in Apple Container / Docker
- `sandbox` — uses `@anthropic-ai/sandbox-runtime` (OS-level sandboxing, <10ms cold start)

Per-group override: set `"runtime": "sandbox"` in the registered group config.

### Sandbox Runtime Details

**Auth:** Sandbox passes real credentials directly (not through credential proxy). Network isolation via `allowedDomains` restricts outbound traffic to `api.anthropic.com` and `localhost` only, preventing credential exfiltration.

**Path mapping:** Container mode maps `/workspace/*` via volume mounts. Sandbox runs on the host, so the agent runner uses `MOTHERCLAW_*_DIR` env vars (`MOTHERCLAW_GROUP_DIR`, `MOTHERCLAW_IPC_DIR`, `MOTHERCLAW_PROJECT_DIR`, `MOTHERCLAW_GLOBAL_DIR`, `MOTHERCLAW_EXTRA_DIR`) to resolve actual host paths.

**Agent runner compilation:** Sandbox can't use `tsx` (blocked Unix sockets). Pre-compile with `cd agent/runner && npx tsc`. The compiled output at `agent/runner/dist/index.js` is used by sandbox; container mode uses its own copy baked into the image.

**srt settings schema:** The `--settings <path>` JSON file requires ALL fields including `allowRead: []` even if empty. Omitting causes silent schema validation failure. Key fields: `network.allowedDomains`, `network.deniedDomains`, `network.allowLocalBinding`, `filesystem.denyRead`, `filesystem.allowRead`, `filesystem.allowWrite`, `filesystem.denyWrite`.

**Config reading:** MotherClaw does NOT use `dotenv`. The `RUNTIME` value in `.env` is read via `readEnvFile()` in `config.ts`.

## Memory System

Agents have structured memory tools via MCP:

- **`memory_save`** — Append facts/notes to memory. Categories: `daily` (memory/YYYY-MM-DD.md), `topic` (memory/topics/{name}.md), `longterm` (CLAUDE.md)
- **`memory_search`** — Grep-based search across all memory files, CLAUDE.md, and archived conversations. Upgradeable to QMD semantic search via `/add-qmd`.
- **`memory_get`** — Read a specific memory file by relative path. Returns empty if not found.

Memory files per group:
```
groups/{folder}/
  CLAUDE.md              # Long-term memory (loaded by SDK every session)
  memory/
    YYYY-MM-DD.md        # Daily append-only logs
    topics/{name}.md     # Topic-specific memory
  conversations/         # Archived transcripts (from PreCompact hook)
```

Before context compaction, the PreCompact hook automatically archives the conversation and writes a summary to the daily memory log (memory flush).

## Per-Group Agent Config

Groups can override agent behavior via `agentConfig` on `RegisteredGroup`:

```typescript
agentConfig: {
  model: 'haiku',           // 'sonnet' | 'opus' | 'haiku' | full model ID
  systemPrompt: '...',      // Appended to agent system context
  allowedTools: ['Bash', 'Read'],  // Override default tool allowlist
  maxTurns: 10,             // Limit conversation turns
  costLimitUsd: 0.50,       // Per-run budget cap
}
```

Stored as JSON in `registered_groups.agent_config` column. Passed through `ContainerInput` to the agent runner, which applies overrides to the SDK `query()` call.

## Webhook Triggers

External systems can trigger agent runs via HTTP POST. Requires `WEBHOOK_SECRET` in `.env`.

```bash
# Trigger an agent run for a group
SIGNATURE=$(echo -n '{"prompt":"Check CI status"}' | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $2}')
curl -X POST http://localhost:3100/webhook/mygroup \
  -H "X-Signature: $SIGNATURE" \
  -d '{"prompt":"Check CI status"}'
```

- HMAC-SHA256 signature verification (timing-safe)
- Per-group rate limiting (10 req/min)
- Health check: `GET /health`
- Response routes through the group's channel (Slack, Telegram, etc.)

Config: `WEBHOOK_PORT` (default: 3100), `WEBHOOK_SECRET` (required to enable)

## Cost Tracking

Every agent run is logged to the `agent_runs` table with token usage and estimated cost:
- `input_tokens`, `output_tokens`, `cache_creation_tokens`, `cache_read_tokens`
- `estimated_cost_usd` (calculated from Anthropic pricing)
- `duration_ms`, `turns`, `model`, `trigger_type` (message/scheduled/webhook)

Query costs: `sqlite3 store/messages.db "SELECT group_folder, SUM(estimated_cost_usd) as total_cost, COUNT(*) as runs FROM agent_runs GROUP BY group_folder"`

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
