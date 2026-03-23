# ClaudeClaw

Persistent agent orchestrator plugin for Claude Code.

## Entry Points

Two separate entry points — plugin and service must not be conflated:

- **`src/index.ts`** → `dist/index.js` — **Plugin entry.** Loaded by Claude Code via `--plugin-dir`. Returns immediately, no side effects. No channel/extension imports.
- **`src/service.ts`** → `dist/service.js` — **Service entry.** Run by launchd/systemd as persistent background process. Imports channels/extensions, starts the message loop.

The plugin entry is what `.claude-plugin/plugin.json` points to. The service entry is what `npm start`, `npm run dev`, and the launchd plist/systemd unit run.

## Modes

ClaudeClaw runs in two modes, detected by `.claude-plugin/plugin.json` in cwd:

**Plugin mode** (no `.claude-plugin/` in cwd):
- Loaded via `claude --plugin-dir /path/to/claudeclaw`
- Current directory IS the instance — all state lives in cwd
- No hidden paths, no `~/.claude/plugin-data/`
- Multiple instances = multiple directories (`cd` is the instance switcher)
- Service per directory: `com.claudeclaw.<dirname>.plist` (macOS), `claudeclaw-<dirname>.service` (Linux)
- Upgrade to developer mode: clone the repo INTO the data directory

**Developer mode** (`.claude-plugin/plugin.json` exists in cwd):
- Cloned repo, `claude` runs from inside it
- Code and state in the same directory
- Full self-improvement — Claude edits its own source
- Git/fork workflow

### Directory = Instance

No instance manager. No switching commands. The directory you run `claude` from IS the ClaudeClaw instance.

```
~/assistants/personal/    ← one instance (cd here, run claude)
  .env, store/, groups/, logs/, .claudeclaw.json
~/assistants/work/        ← another instance
  .env, store/, groups/, logs/, .claudeclaw.json
```

**Path resolution:** `STATE_ROOT` = `process.cwd()` always. `STORE_DIR`, `GROUPS_DIR`, `LOG_DIR` derive from it. `readEnvFile()` checks `CLAUDECLAW_ENV_FILE` then `cwd/.env`.

## Architecture

```
src/
  index.ts                    # Plugin entry (Claude Code --plugin-dir, non-blocking)
  service.ts                  # Service entry (launchd/systemd, runs message loop)
  orchestrator/               # Core
    message-loop.ts           # THE HEART: poll, trigger, thread, queue, dispatch
    group-queue.ts            # Concurrency control for agent execution
    extensions.ts             # Pluggable extension system (registerExtension API)
    extension-loader.ts       # Scans extensions/ dir, loads manifests, dynamic imports
    extension-manifest.ts     # Manifest schema + validation
    channel-registry.ts       # Channel self-registration
    ingestion.ts              # Inbound message processing (pre/post hooks)
    outbound-router.ts        # Outbound message routing (pre/post hooks)
    db.ts                     # SQLite with extension schema support
    config.ts                 # Core config (from .env)
    env.ts                    # .env reader
    logger.ts                 # Pino logger
    types.ts                  # Core types (Channel, RegisteredGroup, NewMessage)
  runtimes/                   # Agent execution backends
    container-runtime.ts      # Container runtime abstraction (binary detection, lifecycle)
    container-runner.ts       # Container-based agent runner (Docker/Apple Container)
    sandbox-runner.ts         # Sandbox-based agent runner (srt, OS-level sandboxing)
  channels/                   # Built-in channels (whatsapp, telegram)
  cost-tracking/              # Built-in: token usage + cost estimation
  webhook/                    # Built-in: HTTP webhook triggers
extensions/                   # Installable extensions (gitignored, per-instance)
  claudeclaw-slack/           # Slack channel (install with /install slack)
  claudeclaw-triage/          # Triage + SWE agents (install with /install triage)
```

## Extension System

Extensions are installable packages in `extensions/claudeclaw-*/`. Each has a `manifest.json`:

```json
{
  "name": "claudeclaw-slack",
  "version": "0.1.0",
  "type": "channel",
  "entry": "dist/index.js",
  "dependencies": { "@slack/bolt": "^4.6.0" },
  "provides": { "channel": "slack", "envKeys": ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"] },
  "skills": ["add-slack"],
  "hooks": { "postInstall": "hooks/install.sh", "postUninstall": "hooks/uninstall.sh" }
}
```

**Install/uninstall:** `/install slack` clones, compiles, installs deps, copies skills, restarts. `/uninstall slack` reverses it.

**Creating extensions:** Extension source imports core via `../../../dist/orchestrator/*.js` (relative paths). Core compiles first with `declaration: true`. Extensions compile against the `.d.ts` output. Self-register via `registerChannel()` or `registerExtension()` on import.

**Available extensions:**
- `claudeclaw-slack` — Slack channel (Socket Mode, threads, reaction typing)
- `claudeclaw-triage` — Triage agent + SWE task queue + GitHub issue integration

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

**Path mapping:** Container mode maps `/workspace/*` via volume mounts. Sandbox runs on the host, so the agent runner uses `CLAUDECLAW_*_DIR` env vars (`CLAUDECLAW_GROUP_DIR`, `CLAUDECLAW_IPC_DIR`, `CLAUDECLAW_PROJECT_DIR`, `CLAUDECLAW_GLOBAL_DIR`, `CLAUDECLAW_EXTRA_DIR`) to resolve actual host paths.

**Agent runner compilation:** Sandbox can't use `tsx` (blocked Unix sockets). Pre-compile with `cd agent/runner && npx tsc`. The compiled output at `agent/runner/dist/index.js` is used by sandbox; container mode uses its own copy baked into the image.

**srt settings schema:** The `--settings <path>` JSON file requires ALL fields including `allowRead: []` even if empty. Omitting causes silent schema validation failure. Key fields: `network.allowedDomains`, `network.deniedDomains`, `network.allowLocalBinding`, `filesystem.denyRead`, `filesystem.allowRead`, `filesystem.allowWrite`, `filesystem.denyWrite`.

**Config reading:** ClaudeClaw does NOT use `dotenv`. The `RUNTIME` value in `.env` is read via `readEnvFile()` in `config.ts`.

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
  disallowedTools: ['Write'],      // Block specific tools
  maxTurns: 10,             // Limit conversation turns
  costLimitUsd: 0.50,       // Per-run budget cap
  effort: 'high',           // Model reasoning effort
  allowedDomains: [          // Extra network domains for sandbox
    'api.github.com',        // GitHub API (for gh CLI)
    '*.github.com',          // GitHub web
    'my-db.railway.app',     // Database host
  ],
}
```

Stored as JSON in `registered_groups.agent_config` column. Passed through `ContainerInput` to the agent runner, which applies overrides to the SDK `query()` call.

### Network Access (Sandbox Mode)

The sandbox restricts outbound network by default. Agents can only connect to domains listed in `allowedDomains`. The final domain list is built from three sources:

1. **Base (always):** `api.anthropic.com`, `*.anthropic.com`, `localhost`, `127.0.0.1`
2. **Extension manifests:** each extension declares domains it needs in `manifest.json` → `provides.allowedDomains`
3. **Per-group `agentConfig.allowedDomains`:** custom domains for this group's specific needs

Common domains to add:
- `api.github.com`, `*.github.com` — for `gh` CLI and GitHub API
- `*.railway.app` — for Railway-hosted databases
- `*.amazonaws.com` — for AWS services
- `api.openai.com` — for OpenAI API access (multi-model routing)

To update a group's allowed domains:
```sql
UPDATE registered_groups
SET agent_config = json_set(COALESCE(agent_config, '{}'), '$.allowedDomains', json('["api.github.com","*.github.com"]'))
WHERE folder = 'mygroup';
```

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

## Security Rules

**NEVER hardcode credentials, API keys, database URLs, hostnames, or project-specific identifiers in any committed file** — especially skills, agent prompts, and extension templates. All secrets and project-specific values MUST come from `.env` or group-level environment variables.

- Use `$DATABASE_READONLY_URL`, `$GITHUB_REPO`, `$PROJECT_DIR` style env var references in skills
- Use `<OWNER>/<REPO>`, `<PROJECT>`, `<HOST>` placeholders in template examples
- Credentials belong in `.env` (gitignored), never in `.md`, `.ts`, or `.json` files
- Before committing: mentally scan every staged file for passwords, tokens, hostnames, internal repo names, database connection strings
- If you find hardcoded secrets in existing files, replace with env var references immediately

This rule exists because credentials were previously committed to a public repo. Treat every commit as public.

## Troubleshooting

**Stale sessions after switching runtimes:** When switching between container and sandbox (or vice versa), existing session IDs may cause "No conversation found" errors. Clear with: `sqlite3 store/messages.db "DELETE FROM sessions"`

**Sandbox agent EPERM on network:** The srt settings `allowRead: []` field MUST be present (even empty). Without it, the entire settings file silently fails validation and network is fully blocked. Also verify `allowedDomains` includes `api.anthropic.com`.

**Sandbox agent can't find paths:** Check that `CLAUDECLAW_*_DIR` env vars are being set in `sandbox-runner.ts` `runSandboxAgent()`. The agent runner falls back to `/workspace/*` (container paths) if env vars are missing.
