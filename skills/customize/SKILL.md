---
name: customize
description: Add new capabilities or modify MotherClaw behavior. Use when user wants to add channels (Telegram, Slack, email input), change triggers, add integrations, modify the router, or make any other customizations. This is an interactive skill that asks questions to understand what the user wants.
---

# MotherClaw Customization

This skill helps users add capabilities or modify behavior. Use AskUserQuestion to understand what they want before making changes.

## Plugin Mode Detection

Run: `echo $CLAUDE_PLUGIN_DATA`

If set (plugin mode), offer the user a choice via AskUserQuestion:
- **Fork to developer mode (Recommended)** — Clone the repo, migrate state, full self-improvement and customization
- **Continue in plugin mode** — Limited to channel setup and config changes (no code editing)

If "Fork to developer mode" is chosen, run the migration flow below. Otherwise, proceed with the normal workflow (limited to invoking existing skills like `/add-slack`, `/add-telegram`).

### Migration: Plugin → Developer Mode

1. AskUserQuestion: "To customize MotherClaw fully, you need your own fork. First, fork sbusso/motherclaw on GitHub. What's your GitHub username?"
2. AskUserQuestion: "Where should I clone the repo?" (default: `~/Code/motherclaw`)
3. Stop running service:
   - macOS: `launchctl unload ~/Library/LaunchAgents/com.motherclaw.plist`
   - Linux: `systemctl --user stop motherclaw`
4. Clone: `git clone https://github.com/<username>/motherclaw.git <clone-path>`
5. Copy state: `cp -r $CLAUDE_PLUGIN_DATA/{store,groups,.env} <clone-path>/`
6. AskUserQuestion: "Copy logs too?" If yes: `cp -r $CLAUDE_PLUGIN_DATA/logs <clone-path>/`
7. Clear stale sessions: `sqlite3 <clone-path>/store/messages.db "DELETE FROM sessions"`
8. Install and build: `cd <clone-path> && npm install && npm run build`
9. Set up upstream: `cd <clone-path> && git remote add upstream https://github.com/sbusso/motherclaw.git`
10. Run service setup: `cd <clone-path> && npx tsx setup/index.ts --step service`
11. Print: "Migration complete! Run `cd <clone-path> && claude` to use developer mode. Remove `--plugin-dir` from your Claude Code invocation."

## Workflow

1. **Understand the request** - Ask clarifying questions
3. **Plan the changes** - Identify files to modify. If a skill exists for the request (e.g., `/add-telegram` for adding Telegram), invoke it instead of implementing manually.
4. **Implement** - Make changes directly to the code
5. **Test guidance** - Tell user how to verify

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/orchestrator/ipc.ts` | IPC watcher and task processing |
| `src/orchestrator/router.ts` | Message formatting and outbound routing |
| `src/orchestrator/types.ts` | TypeScript interfaces (includes Channel) |
| `src/orchestrator/config.ts` | Assistant name, trigger pattern, directories |
| `src/orchestrator/db.ts` | Database initialization and queries |
| `src/channels/whatsapp-auth.ts` | Standalone WhatsApp authentication script |
| `groups/CLAUDE.md` | Global memory/persona |

## Common Customization Patterns

### Adding a New Input Channel (e.g., Telegram, Slack, Email)

Questions to ask:
- Which channel? (Telegram, Slack, Discord, email, SMS, etc.)
- Same trigger word or different?
- Same memory hierarchy or separate?
- Should messages from this channel go to existing groups or new ones?

Implementation pattern:
1. Create `src/channels/{name}.ts` implementing the `Channel` interface from `src/orchestrator/types.ts` (see `src/channels/whatsapp.ts` for reference)
2. Add the channel instance to `main()` in `src/index.ts` and wire callbacks (`onMessage`, `onChatMetadata`)
3. Messages are stored via the `onMessage` callback; routing is automatic via `ownsJid()`

### Adding a New MCP Integration

Questions to ask:
- What service? (Calendar, Notion, database, etc.)
- What operations needed? (read, write, both)
- Which groups should have access?

Implementation:
1. Add MCP server config to the container settings (see `src/orchestrator/container-runner.ts` for how MCP servers are mounted)
2. Document available tools in `groups/CLAUDE.md`

### Changing Assistant Behavior

Questions to ask:
- What aspect? (name, trigger, persona, response style)
- Apply to all groups or specific ones?

Simple changes → edit `src/orchestrator/config.ts`
Persona changes → edit `groups/CLAUDE.md`
Per-group behavior → edit specific group's `CLAUDE.md`

### Adding New Commands

Questions to ask:
- What should the command do?
- Available in all groups or main only?
- Does it need new MCP tools?

Implementation:
1. Commands are handled by the agent naturally — add instructions to `groups/CLAUDE.md` or the group's `CLAUDE.md`
2. For trigger-level routing changes, modify `processGroupMessages()` in `src/index.ts`

### Changing Deployment

Questions to ask:
- Target platform? (Linux server, Docker, different Mac)
- Service manager? (systemd, Docker, supervisord)

Implementation:
1. Create appropriate service files
2. Update paths in config
3. Provide setup instructions

## After Changes

Always tell the user:
```bash
# Rebuild and restart
npm run build
# macOS:
launchctl unload ~/Library/LaunchAgents/com.motherclaw.plist
launchctl load ~/Library/LaunchAgents/com.motherclaw.plist
# Linux:
# systemctl --user restart motherclaw
```

## Example Interaction

User: "Add Telegram as an input channel"

1. Ask: "Should Telegram use the same @Andy trigger, or a different one?"
2. Ask: "Should Telegram messages create separate conversation contexts, or share with WhatsApp groups?"
3. Create `src/channels/telegram.ts` implementing the `Channel` interface (see `src/channels/whatsapp.ts`)
4. Add the channel to `main()` in `src/index.ts`
5. Tell user how to authenticate and test
