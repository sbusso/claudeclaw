---
title: "ClaudeClaw: A Composable Agent Orchestrator for Claude Code"
date: 2026-03-22
tags: [claudeclaw, nanoclaw, claude-code, plugin, agents, sandbox, extensions]
---

## What Is ClaudeClaw

ClaudeClaw is a Claude Code plugin that turns Claude into a persistent, always-on agent orchestrator. It listens to messaging channels (Slack, WhatsApp, Telegram, Discord, Gmail), routes messages to isolated Claude agents, and manages conversations, memory, scheduled tasks, and webhooks — all from a single Node.js process.

It started as a fork of [NanoClaw](https://github.com/qwibitai/nanoclaw), a minimal agent orchestrator. The fork diverged significantly: ClaudeClaw was rebuilt as a Claude Code plugin with a pluggable extension system, structured memory, webhook triggers, per-group agent configuration, cost tracking, and native sandbox runtime support.

The core is ~8K lines of TypeScript with 355 tests. Channels and agents are installable extensions. The entire codebase fits in Claude's context window.

## Why Fork NanoClaw

NanoClaw is a good minimal base — single process, SQLite, channels that self-register. But it has limitations:

- **No plugin architecture.** Customization means modifying core code directly. There's no clean boundary between the orchestrator and extensions.
- **Container-only runtime.** Docker or Apple Container required. 2-5 second cold starts per agent invocation. Credential proxy adds attack surface.
- **No structured memory.** Agents have `CLAUDE.md` but no search, no daily logs, no topic files, no memory tools.
- **No external triggers.** Agents only respond to channel messages and scheduled tasks. No webhook integration for CI/CD or monitoring.
- **No cost visibility.** No tracking of token usage or estimated cost per run.
- **No per-group agent config.** Every group uses the same model, tools, and behavior.

ClaudeClaw addresses all of these.

## The Port: NanoClaw → ClaudeClaw

The port was done in a single day. Here's what happened, commit by commit:

### Phase 1: Plugin Architecture

The core was restructured into a Claude Code plugin layout:

```
.claude-plugin/plugin.json    # Plugin manifest
src/
  index.ts                    # Entrypoint
  orchestrator/               # Core (message-loop, queue, config, db, IPC)
  channels/                   # Channel implementations
  triage/                     # Triage extension
  webhook/                    # Webhook extension
  cost-tracking/              # Cost tracking extension
agent/
  runner/                     # Agent runner (Claude Agent SDK)
  skills/                     # Agent-side skills
```

Two key architectural changes:

**Extension system.** Extensions register capabilities without modifying core. Triage, webhook triggers, and cost tracking are all extensions — the orchestrator core doesn't know about them.

**Two entry points.** The plugin entry (`src/index.ts`) loads via `claude --plugin-dir` and returns immediately — no side effects. The service entry (`src/service.ts`) runs the message loop as a persistent background process. They must never be conflated.

### Phase 2: Sandbox Runtime

NanoClaw's sandbox runtime was ported and made the default. Anthropic's `@anthropic-ai/sandbox-runtime` provides OS-level process sandboxing — Seatbelt on macOS, bubblewrap on Linux. No containers, no VMs, sub-10ms cold starts.

The security model inverts Docker's approach:
- **Docker:** Protect credentials (proxy), allow network (full outbound)
- **Sandbox:** Trust credentials (direct), restrict network (allowedDomains)

The agent runner is runtime-agnostic — `CLAUDECLAW_*_DIR` env vars resolve paths, falling back to `/workspace/*` for container mode. Same binary, both runtimes.

### Phase 3: Directory Reorganization

The Docker-era `container/` directory was split:
- `agent/runner/` — runtime-agnostic agent code (used by both sandbox and Docker)
- `agent/skills/` — agent-side skills
- `docker/` — Docker-only files (Dockerfile, build.sh)

30 files updated across source, tests, docs, and 13 skills.

### Phase 4: New Features

Three features inspired by [9to5](https://github.com/Michaelliv/9to5):

**Webhook Triggers.** External systems trigger agent runs via HTTP POST with HMAC-SHA256 authentication. Per-group rate limiting, health check endpoint, response routes through the group's channel. CI failures, GitHub events, monitoring alerts can all invoke agents.

**Per-Group Agent Config.** Each group can override model (sonnet/opus/haiku), reasoning effort (low/medium/high), system prompt, allowed/disallowed tools, max turns, and cost limits. Stored in the database, passed through to the agent runner.

**Cost Tracking.** Every agent run is logged with token usage (input, output, cache creation, cache read), estimated cost in USD, duration, turns, model, and trigger type. Query costs per group with a single SQL statement.

### Phase 5: Memory System

Agents got structured memory tools via MCP:

- **`memory_save`** — Append facts to daily logs (`memory/YYYY-MM-DD.md`), topic files (`memory/topics/{name}.md`), or long-term `CLAUDE.md`
- **`memory_search`** — Grep-based search across all memory files and archived conversations
- **`memory_get`** — Read any memory file by path

Claude's built-in auto-memory and our `memory_save` tool write to the same `memory/` directory via `autoMemoryDirectory` — unified store.

Before context compaction, the PreCompact hook archives the conversation and writes a summary to the daily memory log. PostCompact verifies the flush. StopFailure notifies the user through their channel on API errors.

A `/add-qmd` skill stub is ready for upgrading to [QMD](https://github.com/tobi/qmd)'s hybrid BM25 + vector semantic search + LLM re-ranking — fully local, no API keys.

### Phase 6: Claude Code Changelog Adoption

Recent Claude Code features (v2.1.76–81) were adopted:

| Feature | Version | What We Did |
|---------|---------|-------------|
| PostCompact hook | v2.1.76 | Verify memory flush after compaction |
| StopFailure hook | v2.1.78 | Notify user on rate limits / auth errors |
| effort frontmatter | v2.1.78 | Per-group reasoning effort control |
| disallowedTools | v2.1.78 | Per-group tool blacklisting |
| CLAUDE_PLUGIN_DATA | v2.1.78 | Persistent store path survives plugin updates |
| autoMemoryDirectory | v2.1.80 | Unified SDK auto-memory + memory tools |
| SendMessage auto-resume | v2.1.77 | Background agents auto-recover (zero code change) |

### Phase 7: Message Router Refactor

The monolithic `message-loop.ts` was split into two clean services:

**MessageIngestion** — single entry point for all inbound messages (channels, webhooks, cron, IPC). Extensions hook pre/post processing without touching core.

**MessageRouter** — single exit point for all outbound messages (agent responses, task results, extension output). Finds the right channel, formats, delivers.

```
Channels ──► MessageIngestion ──► GroupQueue ──► Agent
Webhooks ──►   (pre/post hooks)
Cron     ──►

Agent    ──► MessageRouter ──► Channel.sendMessage()
IPC      ──►   (pre/post hooks)
Extensions─►
```

Extensions register hooks on both services: pre-hooks can modify/drop envelopes, post-hooks observe. This eliminated five separate `sendMessage` closures scattered through `main()` and replaced them with `router.route(envelope)`.

### Phase 8: Composable Extension System

The biggest architectural change: **channels and agents are now installable extensions**, not bundled in core.

Slack and Triage+SWE were extracted into separate repos:
- [claudeclaw-slack](https://github.com/sbusso/claudeclaw-slack) — Slack channel (Socket Mode, threads, typing)
- [claudeclaw-triage](https://github.com/sbusso/claudeclaw-triage) — Triage agent + SWE queue + GitHub issues

Each extension has a `manifest.json` declaring what it provides — channel, DB schema, env keys, skills, agent prompts, and lifecycle hooks:

```json
{
  "name": "claudeclaw-slack",
  "type": "channel",
  "entry": "dist/index.js",
  "dependencies": { "@slack/bolt": "^4.6.0" },
  "skills": ["add-slack"],
  "hooks": { "postInstall": "hooks/install.sh" }
}
```

A manifest-based loader scans `extensions/claudeclaw-*/` at startup, validates each manifest, and dynamically imports the entry point. Extensions self-register via `registerChannel()` or `registerExtension()` on import.

Install is a skill: `/install-extension slack` clones from GitHub, installs deps, compiles, copies skills into the host, and restarts the service. Uninstall reverses it. No merge conflicts — extensions are directories, not branches merged into your fork.

This solves NanoClaw's biggest maintenance pain: upstream updates and extension conflicts. Core updates are `git pull`. Extension updates are `git pull` inside the extension directory. They never touch the same files.

### Phase 9: Directory-as-Instance Model

Plugin mode was simplified: **the current directory IS the instance**. No hidden paths, no `~/.claude/plugin-data/`, no instance manager.

```
~/assistants/personal/    ← one instance (cd here, run claude)
  .env, store/, groups/, logs/, .claudeclaw.json
~/assistants/work/        ← another instance
```

Multiple instances = multiple directories. `cd` is the instance switcher. Each directory gets its own launchd/systemd service (`com.claudeclaw.<dirname>.plist`).

Want to customize the code? Clone the repo INTO the data directory. `.env`, `store/`, `groups/` are gitignored — they survive the clone. You're now in developer mode with full self-improvement capability.

## What ClaudeClaw Has Now

### Agent Triggers

| Trigger | Mechanism |
|---------|-----------|
| Channel message | @mention in Slack, WhatsApp, Telegram, Discord, Gmail |
| Scheduled task | Cron, interval, or one-shot |
| Webhook | HTTP POST with HMAC-SHA256 |

### Per-Group Isolation

Each group gets its own:
- Sandbox process with kernel-enforced filesystem/network
- `CLAUDE.md` long-term memory
- `memory/` directory with daily logs and topic files
- `conversations/` archive
- Session state
- Agent config (model, effort, tools, system prompt, cost limit)

### 24 Skills

```
/setup                    /add-slack              /add-telegram
/add-whatsapp             /add-discord            /add-gmail
/add-telegram-swarm       /add-parallel           /add-compact
/add-voice-transcription  /use-local-whisper      /add-image-vision
/add-pdf-reader           /add-ollama-tool        /add-reactions
/add-qmd                  /x-integration          /convert-to-apple-container
/customize                /debug                  /setup
/update-claudeclaw        /update-skills          /get-qodo-rules
/qodo-pr-resolver
```

### Built-in Extensions (core)

- **Webhook triggers** — HTTP server, HMAC auth, rate limiting
- **Cost tracking** — Token usage, estimated cost per run

### Installable Extensions

- **[claudeclaw-slack](https://github.com/sbusso/claudeclaw-slack)** — Slack channel (Socket Mode, threads, typing)
- **[claudeclaw-triage](https://github.com/sbusso/claudeclaw-triage)** — Triage agent + SWE queue + GitHub issues

## What's Next

### Multi-Model Agent Routing

Support multiple LLM providers per agent. The `agentConfig.model` field expands to accept provider-prefixed strings (`openai/gpt-4o`, `google/gemini-pro`, `ollama/llama3`).

**Phased approach:**
1. **Provider-aware model field** — agent runner switches SDK based on prefix
2. **Provider abstraction** — unified `Provider` interface wrapping each SDK, tool schema translation
3. **Smart routing** — pick provider/model by task complexity, cost budget, latency. Fallback chains.

### QMD Semantic Memory

Replace grep-based `memory_search` with [QMD](https://github.com/tobi/qmd)'s hybrid BM25 + vector semantic search + LLM re-ranking. Fully local, no API keys. Automatic indexing of daily logs, topic files, CLAUDE.md, and archived conversations. `/add-qmd` skill handles installation and migration.

### Future Extensions

| Extension | Purpose |
|-----------|---------|
| `claudeclaw-discord` | Discord channel integration |
| `claudeclaw-gmail` | Gmail as a full channel |
| `claudeclaw-memory` | QMD-powered semantic memory |
| `claudeclaw-tui` | Terminal UI for instance management |

## Numbers

- **40+ commits** across two days
- **~8K lines** core TypeScript (extensions separate)
- **355 core tests** passing
- **2 installable extensions** (Slack, Triage+SWE)
- **2 built-in extensions** (webhook, cost tracking)
- **2 runtimes** (sandbox default, container fallback)
- **5 channels** supported (Slack, WhatsApp, Telegram, Discord, Gmail)
- **3 agent triggers** (message, scheduled, webhook)
- **3 memory tools** (save, search, get)
- **Directory-as-instance** — no hidden state, no config files

## Try It

```bash
git clone https://github.com/sbusso/claudeclaw.git
cd claudeclaw
claude
# type: /setup
```

The full source is at [github.com/sbusso/claudeclaw](https://github.com/sbusso/claudeclaw).
