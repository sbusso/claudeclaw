# ClaudeClaw

Persistent agent orchestrator plugin for Claude Code. Multi-channel message routing, structured memory, webhook triggers, cost tracking — with OS-level sandbox isolation.

Built on [NanoClaw](https://github.com/qwibitai/nanoclaw) — ported to a Claude Code plugin architecture with a pluggable extension system and Anthropic's sandbox runtime.

## What It Does

ClaudeClaw is a Claude Code plugin that provides an always-on message loop. It listens to channels (Slack, WhatsApp, Telegram), routes messages to Claude agents running in isolated sandboxes, and manages ongoing conversations with structured memory.

### Core (Orchestrator)
- **Always-on message loop** — persistent listener, not one-shot
- **Multi-channel routing** — Slack, WhatsApp, Telegram (pluggable)
- **Thread management** — auto-create threads, follow-ups without re-mentioning
- **Context accumulation** — messages batch between triggers
- **Structured memory** — daily logs, topic files, searchable archive with QMD upgrade path
- **Webhook triggers** — HTTP POST with HMAC-SHA256 auth for CI/CD, GitHub, monitoring
- **Per-group agent config** — model, tools, system prompt, cost limits per group
- **Cost tracking** — token usage and estimated cost per agent run
- **Extension system** — plug in triage, SWE queue, or custom capabilities
- **Dual runtime** — OS-level sandbox (default) or container isolation

### Triage Extension
- First-level support agent — investigates bugs, analyzes feature requests
- Answers users in plain language (no code in user threads)
- Creates GitHub issues when code changes are needed
- Posts to dev channel for technical visibility
- SWE task queue for sequential coding work

## Quick Start

```bash
git clone https://github.com/sbusso/claudeclaw.git
cd claudeclaw
claude
# type: /setup
```

`/setup` handles everything interactively: dependencies, runtime selection (sandbox is the default), channel authentication via platform APIs, group registration, and service startup.

## Runtime Options

ClaudeClaw supports two agent execution runtimes. Set `RUNTIME` in `.env`:

| | Sandbox (default) | Container |
|---|---|---|
| **Cold start** | <10ms | ~2-5s |
| **Memory overhead** | None | VM per container |
| **Network isolation** | OS-level `allowedDomains` | Full outbound (credential proxy mitigates) |
| **Credential model** | Direct credentials + restricted network | Proxy service |
| **Setup** | `npm install` | Container daemon + image build |
| **Filesystem isolation** | Kernel-enforced read/write boundaries | Volume mounts |

### Sandbox Runtime (Recommended)

Uses Anthropic's `@anthropic-ai/sandbox-runtime` for OS-level process sandboxing. On macOS it uses Apple's Seatbelt framework; on Linux, bubblewrap. No containers, no VMs — kernel-level restrictions on an ordinary process.

```bash
# .env
RUNTIME=sandbox
```

**Security model:** Real credentials are passed to the agent, but network is restricted to `api.anthropic.com` and `localhost` only. There's nowhere to exfiltrate credentials to. Filesystem access is kernel-enforced per the generated settings file — the agent for a family chat literally cannot read files from a work channel's directory.

Agents run with `permissionMode: 'bypassPermissions'` — the sandbox IS the trust boundary, not application-level permission checks.

### Container Runtime

Uses Apple Container (macOS) or Docker for container-based isolation. Agents run in Linux VMs with volume mounts. A credential proxy on localhost injects real API keys — containers never see actual credentials.

```bash
# .env
RUNTIME=container
```

Per-group override: set `"runtime": "sandbox"` in the registered group config to use sandbox for specific groups while others use containers.

## Agent Triggers

ClaudeClaw agents can be triggered three ways:

| Trigger | How | Use Case |
|---------|-----|----------|
| **Channel message** | @mention in Slack/WhatsApp/Telegram | Interactive conversations |
| **Scheduled task** | Cron, interval, or one-shot | Daily briefings, monitoring, reminders |
| **Webhook** | `POST /webhook/:group` with HMAC-SHA256 | CI/CD pipelines, GitHub events, monitoring alerts |

### Webhook Triggers

External systems can trigger agent runs via HTTP POST. Requires `WEBHOOK_SECRET` in `.env`.

```bash
# Trigger an agent run
PAYLOAD='{"prompt":"CI build failed on main — investigate and summarize"}'
SIGNATURE=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $2}')
curl -X POST http://localhost:3100/webhook/dev-team \
  -H "X-Signature: $SIGNATURE" \
  -d "$PAYLOAD"
```

- HMAC-SHA256 signature verification (timing-safe)
- Per-group rate limiting (10 req/min)
- Health check: `GET /health`
- Response routes through the group's channel

## Memory System

Agents have structured memory tools for persistent recall across conversations:

| Tool | What it does |
|------|-------------|
| **`memory_save`** | Append facts/notes to daily logs, topic files, or long-term CLAUDE.md |
| **`memory_search`** | Search across all memory files and archived conversations |
| **`memory_get`** | Read a specific memory file by path |

```
groups/{folder}/
  CLAUDE.md              # Long-term memory (loaded every session)
  memory/
    YYYY-MM-DD.md        # Daily append-only logs
    topics/{name}.md     # Topic-specific memory (projects, people, domains)
  conversations/         # Archived transcripts (auto-saved before compaction)
```

Claude's built-in auto-memory and our `memory_save` tool write to the same `memory/` directory — unified store, nothing gets lost.

Before context compaction, the PreCompact hook archives the conversation and writes a summary to the daily memory log. PostCompact verifies the flush succeeded. On API errors (rate limits, auth failures), the StopFailure hook notifies you through your channel instead of failing silently.

**QMD upgrade:** Run `/add-qmd` to replace grep-based search with [QMD](https://github.com/tobi/qmd)'s hybrid BM25 + vector semantic search + LLM re-ranking, fully local.

## Per-Group Agent Config

Each group can customize its agent behavior:

```typescript
agentConfig: {
  model: 'haiku',                    // sonnet | opus | haiku | full model ID
  effort: 'low',                     // low | medium | high — reasoning effort
  systemPrompt: 'You are a ...',     // Appended to agent system context
  allowedTools: ['Bash', 'Read'],    // Override default tool allowlist
  disallowedTools: ['WebSearch'],    // Blacklist specific tools
  maxTurns: 10,                      // Limit conversation turns
  costLimitUsd: 0.50,               // Per-run budget cap
}
```

## Cost Tracking

Every agent run is logged with token usage and estimated cost:

```bash
# Total cost per group
sqlite3 store/messages.db \
  "SELECT group_folder, SUM(estimated_cost_usd) as cost, COUNT(*) as runs FROM agent_runs GROUP BY group_folder"

# Recent runs with details
sqlite3 store/messages.db \
  "SELECT group_folder, trigger_type, model, input_tokens+output_tokens as tokens, estimated_cost_usd, duration_ms FROM agent_runs ORDER BY run_at DESC LIMIT 10"
```

## As a Claude Code Plugin

```bash
# Create a directory for your assistant
mkdir ~/my-assistant && cd ~/my-assistant

# Load ClaudeClaw as a plugin
claude --plugin-dir /path/to/claudeclaw

# Run /setup to configure channels and start the service
```

**Directory = Instance.** The current directory IS the ClaudeClaw instance. All state (`.env`, `store/`, `groups/`, `logs/`) lives in cwd. No hidden paths, no `~/.claude/plugin-data/`.

**Multiple instances = multiple directories:**
```bash
~/assistants/personal/    # cd here, run claude
~/assistants/work/        # cd here, run claude
```

Services are named per directory (`com.claudeclaw.personal.plist` on macOS). Want to customize the code? Clone the repo into your data directory — `.env`, `store/`, `groups/` are gitignored, so they survive the clone. Now you're in developer mode with full self-improvement.

## Philosophy

**Small enough to understand.** One process, a few source files, no microservices. The entire codebase fits in Claude's context window (~35K tokens).

**Secure by isolation.** Agents run in OS-level sandboxes or containers — not behind application-level permission checks. The kernel enforces what files are readable and what hosts are reachable.

**Built for the individual user.** Not a monolithic framework; software that fits each user's exact needs. Fork it, modify it, own it.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that Claude can safely change it.

**AI-native.** No installation wizard — Claude Code guides setup. No monitoring dashboard — ask Claude what's happening. No debugging tools — describe the problem and Claude fixes it.

**Skills over features.** Instead of adding features to the core, contributors submit Claude Code skills (like `/add-telegram`) that transform your fork. You end up with clean code that does exactly what you need.

## What It Supports

- **Multi-channel messaging** — Slack, WhatsApp, Telegram, Discord, Gmail. Add channels with skills like `/add-whatsapp` or `/add-telegram`.
- **Isolated group context** — Each group has its own `CLAUDE.md` memory, isolated filesystem, and sandbox/container with only that directory mounted.
- **Main channel** — Your private channel for admin control; every other group is completely isolated.
- **Structured memory** — Daily logs, topic files, long-term CLAUDE.md, searchable archive.
- **Scheduled tasks** — Recurring jobs that run Claude and can message you back.
- **Webhook triggers** — External systems invoke agents via authenticated HTTP POST.
- **Web access** — Search and fetch content from the Web.
- **Agent Swarms** — Spin up teams of specialized agents that collaborate on complex tasks.
- **Per-group agent config** — Model, tools, system prompt, cost limits per group.
- **Cost tracking** — Token usage and estimated cost logged per run.
- **Extension system** — Plug in triage, SWE queue, or custom capabilities without modifying core.

## Usage

Talk to your assistant with the trigger word (default: `@ClaudeClaw`):

```
@ClaudeClaw send an overview of the sales pipeline every weekday morning at 9am
@ClaudeClaw review the git history for the past week each Friday and update the README if there's drift
@ClaudeClaw every Monday at 8am, compile news on AI developments and message me a briefing
```

From the main channel, manage groups and tasks:
```
@ClaudeClaw list all scheduled tasks across groups
@ClaudeClaw pause the Monday briefing task
@ClaudeClaw join the Family Chat group
```

## Architecture

```
Channels → SQLite → Polling loop → Sandbox/Container (Claude Agent SDK) → Response
                                         ↑
Webhooks → HTTP server → HMAC verify → Queue
```

Single Node.js process. Channels self-register at startup — the orchestrator connects whichever ones have credentials in `.env`. Messages land in SQLite, a polling loop picks them up, and the runtime spawns an isolated agent per group. IPC via filesystem.

### Key Files

```
src/
  index.ts                         # Plugin entry (Claude Code --plugin-dir, non-blocking)
  service.ts                       # Service entry (launchd/systemd, runs message loop)
  orchestrator/
    message-loop.ts                # THE HEART: poll, trigger, thread, queue, dispatch
    sandbox-runner.ts              # Sandbox runtime (srt CLI, settings, credentials)
    container-runner.ts            # Container runtime (Apple Container / Docker)
    container-runtime.ts           # Container binary abstraction
    extensions.ts                  # Pluggable extension system
    channel-registry.ts            # Channel self-registration
    config.ts                      # Configuration (from .env, including RUNTIME)
    env.ts                         # .env reader (secrets never in process.env)
    db.ts                          # SQLite operations
    group-queue.ts                 # Concurrency control
    ipc.ts                         # File-based IPC watcher
    types.ts                       # Core types (AgentConfig, RegisteredGroup, etc.)
  channels/
    slack.ts                       # Slack (Socket Mode, thread JIDs, reaction typing)
  webhook/
    server.ts                      # HTTP server with HMAC-SHA256 auth
    index.ts                       # Webhook extension registration
  cost-tracking/
    index.ts                       # Cost tracking extension (agent_runs table)
  triage/
    index.ts                       # Triage extension registration
agent/
  runner/src/index.ts              # Runs inside sandbox/container — Claude Agent SDK
  runner/src/ipc-mcp-stdio.ts      # MCP server (memory, tasks, messaging tools)
  skills/                          # Skills available to agents
docker/
  Dockerfile                       # Container image definition
  build.sh                         # Container build script
groups/*/CLAUDE.md                 # Per-group memory (isolated)
groups/*/memory/                   # Daily logs and topic files
```

### Sandbox Runtime Internals

The sandbox runner (`sandbox-runner.ts`) generates a per-agent srt settings JSON:

```json
{
  "network": {
    "allowedDomains": ["api.anthropic.com", "*.anthropic.com", "localhost", "127.0.0.1"],
    "deniedDomains": [],
    "allowLocalBinding": true
  },
  "filesystem": {
    "denyRead": ["/path/to/project/.env"],
    "allowRead": ["/path/to/project"],
    "allowWrite": ["/path/to/group"],
    "denyWrite": ["/path/to/project/.env"]
  }
}
```

Path mapping via `CLAUDECLAW_*_DIR` env vars makes the agent runner runtime-agnostic — same binary works in both sandbox and container mode.

## Extension System

Extensions register capabilities without modifying core:

```typescript
import { registerExtension } from '../orchestrator/extensions.js';

registerExtension({
  name: 'my-extension',
  ipcHandlers: { 'my_action': handler },
  onStartup: (deps) => { ... },
  dbSchema: ['CREATE TABLE IF NOT EXISTS ...'],
  containerEnvKeys: ['MY_API_KEY'],
});
```

Built-in extensions: **webhook triggers**, **cost tracking**, **triage + SWE queue**.

## Customizing

ClaudeClaw doesn't use configuration files. To make changes, just tell Claude Code what you want:

- "Change the trigger word to @Bob"
- "Add a morning briefing that runs at 7am and posts to Slack"
- "Give the family group access to my Obsidian vault"
- "Use opus for the dev-team group and haiku for everything else"

Or run `/customize` for guided changes. Each change is a code change, committed to your fork, reversible with `git revert`.

## Requirements

- macOS or Linux
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- No Docker required (sandbox mode is the default)

## FAQ

**Why sandbox over Docker?**

Sandbox provides better security (kernel-enforced vs proxy-based credential protection), faster startup (<10ms vs seconds), and simpler setup (no daemon, no image builds). Docker/Apple Container is available as a per-group fallback for cases needing custom agent-runner customization.

**Is this secure?**

Agents run in OS-level sandboxes, not behind application-level permission checks. Network is restricted to Anthropic's API. Filesystem access is kernel-enforced. The attack surface is a JSON settings file and ~150 lines of runtime configuration, not 500K lines of application logic. You should still review what you're running, but the codebase is small enough that you actually can.

**Can I run this on Linux?**

Yes. Sandbox uses bubblewrap on Linux. Container mode uses Docker. Just run `/setup`.

**Why no configuration files?**

We don't want configuration sprawl. Every user should customize ClaudeClaw so that the code does exactly what they want, rather than configuring a generic system.

**How do I debug issues?**

Ask Claude Code. "Why isn't the scheduler running?" "What's in the recent logs?" Or run `/debug` for guided troubleshooting.

## Development

```bash
npm run build    # Compile TypeScript
npm run dev      # Run with tsx
npm test         # Run tests (415 tests)
```

## License

MIT
