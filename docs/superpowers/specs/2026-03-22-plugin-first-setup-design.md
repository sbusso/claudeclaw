# Plugin-First Setup Design

## Context

MotherClaw was ported from NanoClaw (a repo-first model where users clone and run `claude` inside the repo). As a Claude Code plugin loaded via `--plugin-dir`, the `/setup` skill fails immediately because step 0 tries to update a git repo — but in plugin mode there's no repo to update, just a plugin directory.

The setup flow needs to detect which mode it's running in and adapt accordingly, while keeping both modes as first-class citizens.

## Two Modes, One Codebase

### Plugin mode
- Loaded via `claude --plugin-dir /path/to/motherclaw` or marketplace
- Skills discovered from `skills/` automatically
- All state (DB, groups, logs, .env) lives in `CLAUDE_PLUGIN_DATA`
- Background service runs `node <plugin-dir>/dist/service.js`
- launchd/systemd plist sets `CLAUDE_PLUGIN_DATA` env var
- No git operations, no fork, no self-improvement
- Upgrade to developer mode via `/customize` (fork + migrate)

### Developer mode
- User cloned the repo, runs `claude` from inside it
- Same skills, same service, same agents
- State lives locally: `store/`, `groups/`, `logs/`, `.env`
- Full self-improvement: Claude edits its own source
- Git/fork workflow preserved

## Mode Detection

At the top of `/setup`, before any steps:

```
if CLAUDE_PLUGIN_DATA is set:
  → Plugin mode
else:
  → Developer mode
```

`CLAUDE_PLUGIN_DATA` is set by Claude Code only for plugins loaded via `--plugin-dir`. A developer running `claude` from inside the cloned repo does not have this set. No secondary cwd check needed — the env var alone is the discriminator.

## Setup Flow Changes

### Step 0: Git & Fork (developer mode only)

**Plugin mode:** Skip entirely. Print: "Running as plugin. State will be stored in CLAUDE_PLUGIN_DATA."

**Developer mode:** Unchanged — check remotes, offer fork, configure upstream.

### Step 1: Bootstrap

**Plugin mode:** Dependencies are already installed in the plugin dir. Just verify Node.js version and that `dist/service.js` exists. If agent runner needs compilation: `cd <plugin-dir>/agent/runner && npx tsc`.

**Developer mode:** Unchanged — run `bash setup.sh`.

### Steps 2-6: Environment, Runtime, Auth, Channels, Mounts

Both modes run these identically, but all file operations use the resolved base directory:
- Plugin mode: `CLAUDE_PLUGIN_DATA` for state, plugin-dir for code
- Developer mode: project root for both

### Step 7: Start Service

**Plugin mode:** Generate plist/systemd unit with:
- `ExecStart` → `node <plugin-dir>/dist/service.js`
- `WorkingDirectory` → `<plugin-dir>`
- `CLAUDE_PLUGIN_DATA` → set in environment variables
- `MOTHERCLAW_ENV_FILE` → `<CLAUDE_PLUGIN_DATA>/.env`

**Developer mode:** Unchanged — `WorkingDirectory` is project root, `.env` read from project root.

### Step 8: Verify

Both modes: same checks, paths resolved per mode.

## State Layout

### Plugin mode (`CLAUDE_PLUGIN_DATA/`)
```
CLAUDE_PLUGIN_DATA/
  .env                    # Credentials and config
  messages.db             # SQLite message store
  groups/                 # Per-group directories
    main/
      CLAUDE.md           # Agent memory
      memory/             # Auto-memory
  logs/
    motherclaw.log
    motherclaw.error.log
```

### Developer mode (project root)
```
motherclaw/
  .env
  store/messages.db
  groups/main/CLAUDE.md
  logs/motherclaw.log
```

## Config Changes (`src/orchestrator/config.ts`)

The `STORE_DIR`, `GROUPS_DIR`, and log paths need to resolve from `CLAUDE_PLUGIN_DATA` when set. Note: the existing `DATA_DIR` export (line 46) points to `project_root/data` — rename the new variable to `STATE_ROOT` to avoid collision:

```typescript
const PROJECT_ROOT = process.cwd();
const STATE_ROOT = process.env.CLAUDE_PLUGIN_DATA
  ? path.resolve(process.env.CLAUDE_PLUGIN_DATA)
  : PROJECT_ROOT;

export const STORE_DIR = path.resolve(STATE_ROOT, 'store');
export const GROUPS_DIR = path.resolve(STATE_ROOT, 'groups');
export const LOG_DIR = path.resolve(STATE_ROOT, 'logs');
```

**`src/orchestrator/env.ts`** — `readEnvFile()` currently hardcodes `path.join(process.cwd(), '.env')`. Must be updated to check `MOTHERCLAW_ENV_FILE` first, then fall back to `STATE_ROOT/.env`:

```typescript
const envFile = process.env.MOTHERCLAW_ENV_FILE
  || path.join(process.env.CLAUDE_PLUGIN_DATA || process.cwd(), '.env');
```

**`setup/service.ts`** — Plist/systemd PATH must include `/opt/homebrew/bin` for Apple Silicon (existing gap, fix now).

## Customization Upgrade Path

When a plugin user wants to customize, `/customize` detects plugin mode and offers:

1. Fork `sbusso/motherclaw` on GitHub
2. Clone to a local directory
3. Migrate state from `CLAUDE_PLUGIN_DATA` to the local repo
4. Switch to developer mode (stop using `--plugin-dir`, run `claude` from repo)

This is a clean break — no hybrid state.

## Customization Migration

When a plugin user runs `/customize` and chooses to fork to developer mode:

### What gets copied

Everything from `CLAUDE_PLUGIN_DATA/` to the cloned repo:
- `store/messages.db` — full conversation history, group registrations, sessions, scheduled tasks
- `groups/` — all group directories with CLAUDE.md memory, auto-memory, conversation archives
- `.env` — credentials and config
- `logs/` — optional, user's choice

### Why no path fixup is needed

The DB stores group folders as **relative names** (e.g. `'main'`, `'family'`), not absolute paths. `resolveGroupFolderPath()` in `group-folder.ts` resolves them at runtime via `GROUPS_DIR`. Since `GROUPS_DIR` is derived from `STATE_ROOT` (which changes from `CLAUDE_PLUGIN_DATA` to project root), the same relative folder names resolve correctly in both modes.

### Migration steps

1. Stop running service: `launchctl unload ~/Library/LaunchAgents/com.motherclaw.plist` (macOS) or `systemctl --user stop motherclaw` (Linux)
2. Fork `sbusso/motherclaw` on GitHub (user does this in browser)
3. Clone: `git clone https://github.com/<user>/motherclaw.git ~/motherclaw`
4. Copy state: `cp -r $CLAUDE_PLUGIN_DATA/{store,groups,.env,logs} ~/motherclaw/`
5. Clear stale sessions: `sqlite3 ~/motherclaw/store/messages.db "DELETE FROM sessions"`
6. Install deps and build: `cd ~/motherclaw && npm install && npm run build`
7. Re-run `/setup` step 7 (service) from inside the repo to generate new plist/systemd pointing to repo's `dist/service.js`
8. Remove `--plugin-dir` from user's Claude Code invocation

Old `CLAUDE_PLUGIN_DATA` directory is left as backup. User can delete manually after confirming migration works.

## Files to Modify

| File | Change |
|------|--------|
| `skills/setup/SKILL.md` | Add mode detection at top, conditional step 0, plugin-mode state paths |
| `src/orchestrator/config.ts` | Add `STATE_ROOT` from `CLAUDE_PLUGIN_DATA`, resolve STORE_DIR/GROUPS_DIR/LOG_DIR |
| `src/orchestrator/env.ts` | `readEnvFile()` checks `MOTHERCLAW_ENV_FILE` / `CLAUDE_PLUGIN_DATA` before cwd |
| `setup/service.ts` | Pass CLAUDE_PLUGIN_DATA and MOTHERCLAW_ENV_FILE in plist/systemd env; add `/opt/homebrew/bin` to PATH |
| `setup/service.test.ts` | Add plugin-mode test cases; test config.ts path resolution with/without CLAUDE_PLUGIN_DATA |
| `skills/customize/SKILL.md` | Add fork-and-migrate flow for plugin→developer upgrade |
| `CLAUDE.md` | Document both modes |

## Verification

1. `claude plugin validate .` — passes
2. `claude --plugin-dir .` then `/setup` — detects plugin mode, skips git step, creates state in CLAUDE_PLUGIN_DATA
3. `cd motherclaw && claude` then `/setup` — detects developer mode, runs full git/fork flow
4. `npm test` — all tests pass with both CLAUDE_PLUGIN_DATA set and unset
5. Service starts and reads .env from correct location in both modes
