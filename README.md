# MotherClaw

Persistent agent orchestrator plugin for Claude Code. Multi-channel message routing, triage, and SWE task management — with OS-level sandbox isolation.

Built on [NanoClaw](https://github.com/qwibitai/nanoclaw) — ported to a Claude Code plugin architecture with a pluggable extension system and Anthropic's sandbox runtime.

## What It Does

MotherClaw is a Claude Code plugin that provides an always-on message loop. It listens to channels (Slack, WhatsApp, Telegram), routes messages to Claude agents running in isolated sandboxes, and manages ongoing conversations.

### Core (Orchestrator)
- **Always-on message loop** — persistent listener, not one-shot
- **Multi-channel routing** — Slack, WhatsApp, Telegram (pluggable)
- **Thread management** — auto-create threads, follow-ups without re-mentioning
- **Context accumulation** — messages batch between triggers
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
git clone https://github.com/sbusso/motherclaw.git
cd motherclaw
claude
# type: /setup
```

`/setup` handles everything interactively: dependencies, runtime selection (sandbox is the default), channel authentication via platform APIs, group registration, and service startup.

## Runtime Options

MotherClaw supports two agent execution runtimes. Set `RUNTIME` in `.env`:

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

## As a Claude Code Plugin

```bash
claude --plugin-dir ./motherclaw
```

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
- **Scheduled tasks** — Recurring jobs that run Claude and can message you back.
- **Web access** — Search and fetch content from the Web.
- **Agent Swarms** — Spin up teams of specialized agents that collaborate on complex tasks.
- **Extension system** — Plug in triage, SWE queue, or custom capabilities without modifying core.

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```
@Andy send an overview of the sales pipeline every weekday morning at 9am
@Andy review the git history for the past week each Friday and update the README if there's drift
@Andy every Monday at 8am, compile news on AI developments and message me a briefing
```

From the main channel, manage groups and tasks:
```
@Andy list all scheduled tasks across groups
@Andy pause the Monday briefing task
@Andy join the Family Chat group
```

## Architecture

```
Channels → SQLite → Polling loop → Sandbox/Container (Claude Agent SDK) → Response
```

Single Node.js process. Channels self-register at startup — the orchestrator connects whichever ones have credentials in `.env`. Messages land in SQLite, a polling loop picks them up, and the runtime spawns an isolated agent per group. IPC via filesystem.

### Key Files

```
src/
  index.ts                         # Entrypoint: DB → channels → extensions → loop
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
    types.ts                       # Core types
  channels/
    slack.ts                       # Slack (Socket Mode, thread JIDs, reaction typing)
  triage/
    index.ts                       # Triage extension registration
agent/
  runner/src/index.ts              # Runs inside sandbox/container — Claude Agent SDK
  skills/                          # Skills available to agents
docker/
  Dockerfile                       # Container image definition
  build.sh                         # Container build script
groups/*/CLAUDE.md                 # Per-group memory (isolated)
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

Path mapping via `MOTHERCLAW_*_DIR` env vars makes the agent runner runtime-agnostic — same binary works in both sandbox and container mode.

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

## Customizing

MotherClaw doesn't use configuration files. To make changes, just tell Claude Code what you want:

- "Change the trigger word to @Bob"
- "Add a morning briefing that runs at 7am and posts to Slack"
- "Give the family group access to my Obsidian vault"

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

We don't want configuration sprawl. Every user should customize MotherClaw so that the code does exactly what they want, rather than configuring a generic system.

**How do I debug issues?**

Ask Claude Code. "Why isn't the scheduler running?" "What's in the recent logs?" Or run `/debug` for guided troubleshooting.

## Development

```bash
npm run build    # Compile TypeScript
npm run dev      # Run with tsx
npm test         # Run tests (377 tests)
```

## License

MIT
