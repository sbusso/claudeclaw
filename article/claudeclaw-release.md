---
title: "ClaudeClaw: From NanoClaw Fork to Claude Code Plugin"
date: 2026-03-21
tags: [claudeclaw, nanoclaw, claude-code, plugin, agents, sandbox]
---

## What Is ClaudeClaw

ClaudeClaw is a Claude Code plugin that turns Claude into a persistent, always-on agent orchestrator. It listens to messaging channels (Slack, WhatsApp, Telegram, Discord, Gmail), routes messages to isolated Claude agents, and manages conversations, memory, scheduled tasks, and webhooks — all from a single Node.js process.

It started as a fork of [NanoClaw](https://github.com/qwibitai/nanoclaw), a minimal agent orchestrator. The fork diverged significantly: ClaudeClaw was rebuilt as a Claude Code plugin with a pluggable extension system, structured memory, webhook triggers, per-group agent configuration, cost tracking, and native sandbox runtime support.

The entire codebase is ~10K lines of TypeScript across 126 files, with 386 tests. It fits in Claude's context window.

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

The key architectural change is the **extension system**. Extensions register capabilities without modifying core:

```typescript
registerExtension({
  name: 'my-extension',
  ipcHandlers: { 'my_action': handler },
  onStartup: (deps) => { ... },
  dbSchema: ['CREATE TABLE IF NOT EXISTS ...'],
});
```

Triage, webhook triggers, and cost tracking are all implemented as extensions. The orchestrator core doesn't know about any of them.

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

### Built-in Extensions

- **Webhook triggers** — HTTP server, HMAC auth, rate limiting
- **Cost tracking** — Token usage, estimated cost per run
- **Triage + SWE queue** — First-level support, GitHub issue creation, sequential coding tasks

## What's Next

### Near-Term

**QMD Memory Backend (`/add-qmd`).** Replace grep-based `memory_search` with QMD's hybrid search — BM25 keyword matching + vector semantic search + LLM re-ranking. Fully local, no API keys, ~2GB for embedding models. The skill stub is ready; implementation is the next memory milestone.

**Channel Permission Relay.** Claude Code v2.1.81 introduced `--channels` for forwarding tool approval prompts. This could enable agents that mostly run autonomously but ask permission for destructive operations — "Should I delete this file?" appears as a Slack message with approve/deny. Waiting for the API to stabilize before building.

### Longer-Term

**TUI Dashboard Plugin.** A terminal UI for monitoring agent activity — running jobs, recent runs, cost by group, memory stats, webhook events. React-based using a library like [OpenTUI](https://github.com/nicepkg/opentui) or [Ink](https://github.com/vadimdemedes/ink). Could be a standalone Claude Code plugin that reads ClaudeClaw's SQLite database.

**Memory Graph.** Beyond flat files — relationships between memory entries. "This person mentioned that project in this conversation." QMD gets us search; a graph layer gets us traversal and connection discovery.

**Multi-Model Routing.** Use haiku for simple questions, sonnet for general tasks, opus for complex reasoning — automatically, based on message complexity or group config. The per-group `agentConfig.model` is the foundation; auto-routing is the next step.

**Agent Marketplace.** Shareable agent configurations — not just skills (code changes) but agent profiles (model, system prompt, tools, memory templates). "Install the code reviewer agent for your dev channel."

**Workflow Chains.** Agent A completes → triggers Agent B. Webhook triggers are the primitive; workflow chains compose them. A CI failure triggers investigation → investigation triggers fix → fix triggers PR review.

## Numbers

- **22 commits** in one day
- **126 files** changed
- **~10K lines** of TypeScript
- **386 tests** passing
- **24 skills** available
- **3 built-in extensions** (webhook, cost tracking, triage)
- **2 runtimes** (sandbox default, container fallback)
- **5 channels** supported (Slack, WhatsApp, Telegram, Discord, Gmail)
- **3 agent triggers** (message, scheduled, webhook)
- **3 memory tools** (save, search, get)

## Try It

```bash
git clone https://github.com/sbusso/claudeclaw.git
cd claudeclaw
claude
# type: /setup
```

The full source is at [github.com/sbusso/claudeclaw](https://github.com/sbusso/claudeclaw).
