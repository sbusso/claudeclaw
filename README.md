# MotherClaw

Persistent agent orchestrator plugin for Claude Code. Multi-channel message routing, triage, and SWE task management.

## What it does

MotherClaw is a Claude Code plugin that provides an always-on message loop. It listens to channels (Slack, etc.), routes messages to Claude Code agents, and manages ongoing conversations.

### Core (Orchestrator)
- **Always-on message loop** — persistent listener, not one-shot
- **Multi-channel routing** — Slack, WhatsApp, Telegram (pluggable)
- **Thread management** — auto-create threads, follow-ups without re-mentioning
- **Context accumulation** — messages batch between triggers
- **Extension system** — plug in triage, SWE queue, or custom capabilities

### Triage Extension
- First-level support agent — investigates bugs, analyzes feature requests
- Answers users in plain language (no code in user threads)
- Creates GitHub issues when code changes are needed
- Posts to dev channel for technical visibility
- SWE task queue for sequential coding work

## Quick Start

```bash
# Install dependencies
npm install

# Configure
cp .env.example .env
# Edit .env with your Slack tokens

# Run
npm run dev
```

## As a Claude Code Plugin

```bash
claude --plugin-dir ./motherclaw
```

## Structure

```
motherclaw/
├── .claude-plugin/plugin.json   # Claude Code plugin manifest
├── agents/                      # Claude Code sub-agents
│   ├── triage.md               # Triage agent definition
│   └── swe.md                  # SWE agent definition
├── skills/                      # Claude Code skills
│   ├── triage/SKILL.md         # Triage investigation process
│   └── swe/SKILL.md            # SWE implementation process
├── src/
│   ├── index.ts                # Entrypoint — starts orchestrator
│   ├── orchestrator/           # Core message loop
│   │   ├── extensions.ts       # Extension system
│   │   ├── types.ts            # Core types
│   │   ├── channel-registry.ts # Channel registration
│   │   ├── config.ts           # Configuration
│   │   ├── env.ts              # .env reader
│   │   └── logger.ts           # Logging
│   ├── channels/               # Channel implementations
│   │   └── slack.ts            # Slack (Socket Mode)
│   └── triage/                 # Triage extension
│       ├── index.ts            # Extension registration
│       ├── queue-db.ts         # Task queue DB
│       ├── swe-queue.ts        # Sequential SWE processor
│       └── ipc-handlers.ts     # IPC message handlers
└── package.json
```

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

## License

MIT
