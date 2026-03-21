# Plugin Instances Design

## Context

MotherClaw's plugin mode stores all state in a single `CLAUDE_PLUGIN_DATA` directory. Users with multiple projects or sharing a machine need isolated configurations — different API keys, channels, agent configs, and groups running simultaneously without interference.

## Design

### Instance Directory Layout

```
CLAUDE_PLUGIN_DATA/
  instances.json              # {"default": "personal", "instances": {"personal": {...}, "work": {...}}}
  instances/
    personal/
      .env
      store/messages.db
      groups/main/CLAUDE.md
      logs/motherclaw.log
    work/
      .env
      store/messages.db
      groups/main/CLAUDE.md
      logs/motherclaw.log
```

`instances.json` schema:
```json
{
  "default": "personal",
  "instances": {
    "personal": { "created_at": "2026-03-22T...", "description": "Personal assistant", "last_used": "2026-03-22T..." },
    "work": { "created_at": "2026-03-22T...", "description": "Work channels", "last_used": "2026-03-22T..." }
  }
}
```

Each instance is a complete, independent MotherClaw state directory. No shared state between instances.

### STATE_ROOT Resolution

```typescript
function resolveStateRoot(): string {
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (!pluginData) return process.cwd(); // developer mode — unchanged

  const instance = process.env.MOTHERCLAW_INSTANCE
    || readDefaultInstance(pluginData);
  return path.resolve(pluginData, 'instances', instance);
}

function readDefaultInstance(pluginData: string): string {
  const configPath = path.join(pluginData, 'instances.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return config.default || 'default';
  } catch {
    return 'default';
  }
}
```

Everything downstream (`STORE_DIR`, `GROUPS_DIR`, `LOG_DIR`, `readEnvFile()`) already derives from `STATE_ROOT`. Only the resolution of `STATE_ROOT` itself changes.

### Instance Selection Flow

**First run (no instances exist):**
1. Plugin detects no `instances.json`
2. If existing state (store/, .env) in `CLAUDE_PLUGIN_DATA` root → auto-migrate to `instances/default/`
3. If no existing state → prompt: "Create your first MotherClaw instance. What should it be called?" (default: "default")
4. Create `instances/<name>/`, write `instances.json`, set as default
5. Proceed to `/setup` for that instance

**Subsequent runs:**
1. Read `instances.json`, load default instance name
2. Set `STATE_ROOT` to `CLAUDE_PLUGIN_DATA/instances/<name>`
3. No prompt — auto-selects

**Override:** `MOTHERCLAW_INSTANCE=work claude --plugin-dir motherclaw`

### Instance Commands

Flat `.md` files in `commands/` (lightweight one-shot operations):

**`/instance-list`** — Show all instances with status (running/stopped, channel count, last used)

**`/instance-switch <name>`** — Change the default in `instances.json`. Print: "Switched to <name>. Restart Claude Code for the change to take effect."

**`/instance-create <name>`** — Create `instances/<name>/` directory, add to `instances.json`. Offer to run `/setup` for the new instance.

**`/instance-delete <name>`** — Confirm with user. Stop the instance's service (unload plist / stop systemd unit). Remove `instances/<name>/` directory and entry from `instances.json`. Cannot delete the current default instance without switching first.

### Service Management

Each instance gets its own background service:

| Platform | Service name | File |
|----------|-------------|------|
| macOS | `com.motherclaw.<name>` | `~/Library/LaunchAgents/com.motherclaw.<name>.plist` |
| Linux (systemd) | `motherclaw-<name>` | `~/.config/systemd/user/motherclaw-<name>.service` |
| WSL (nohup) | N/A | `start-motherclaw-<name>.sh` |

Service env vars:
- `CLAUDE_PLUGIN_DATA` — plugin data root (same for all instances)
- `MOTHERCLAW_INSTANCE` — instance name (unique per service)
- `MOTHERCLAW_ENV_FILE` — `CLAUDE_PLUGIN_DATA/instances/<name>/.env`

Port isolation: each instance's `.env` must set unique `WEBHOOK_PORT` (default 3100, suggest 3100 + instance index) and `CREDENTIAL_PROXY_PORT` if using container mode.

### Migration: Existing Plugin State

On first run in a `CLAUDE_PLUGIN_DATA` that has state but no `instances/` directory:

1. Detect: `store/` or `.env` exists at `CLAUDE_PLUGIN_DATA/` root
2. Create `instances/default/`
3. Move `store/`, `groups/`, `logs/`, `.env` into `instances/default/`
4. Create `instances.json` with `{"default": "default", "instances": {"default": {...}}}`
5. Update launchd/systemd service to include `MOTHERCLAW_INSTANCE=default`

This is automatic and transparent — existing setups continue working.

### Developer Mode

No changes. Developer mode (`CLAUDE_PLUGIN_DATA` not set) has no instance concept. `STATE_ROOT` = `process.cwd()` as before.

## Files to Modify

| File | Change |
|------|--------|
| `src/orchestrator/config.ts` | `resolveStateRoot()` adds instance subdirectory in plugin mode |
| `setup/service.ts` | Service names include instance name; pass `MOTHERCLAW_INSTANCE` env var |
| `setup/service.test.ts` | Tests for instance-aware service generation |
| `skills/setup/SKILL.md` | First-run instance creation prompt; migration logic |
| `commands/instance-list.md` | New — list instances |
| `commands/instance-switch.md` | New — switch default instance |
| `commands/instance-create.md` | New — create new instance |
| `commands/instance-delete.md` | New — delete instance |
| `CLAUDE.md` | Document instances |

## Verification

1. `npm run build` — compiles
2. `npm test` — all tests pass with and without CLAUDE_PLUGIN_DATA/MOTHERCLAW_INSTANCE
3. Fresh plugin install → prompts to create first instance → runs /setup → service starts
4. `/instance-create work` → creates second instance → `/setup` for it → second service starts
5. `/instance-list` → shows both instances
6. `/instance-switch work` → changes default
7. Migration: existing state auto-moved to `instances/default/` transparently
