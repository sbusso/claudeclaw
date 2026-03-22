# Plugin-First Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MotherClaw work as a Claude Code plugin where `/setup` adapts to plugin mode (CLAUDE_PLUGIN_DATA) vs developer mode (cloned repo).

**Architecture:** Add `STATE_ROOT` to config.ts that resolves from `CLAUDE_PLUGIN_DATA` or falls back to `PROJECT_ROOT`. Update `env.ts` to read `.env` from the correct location. Update `setup/service.ts` to pass plugin env vars in generated plist/systemd. Update the setup skill to detect mode and skip git operations in plugin mode.

**Tech Stack:** TypeScript, Node.js, vitest, launchd/systemd

**Spec:** `docs/superpowers/specs/2026-03-22-plugin-first-setup-design.md`

---

### Task 1: Add STATE_ROOT to config.ts

**Files:**
- Modify: `src/orchestrator/config.ts`
- Create: `src/orchestrator/config.test.ts`

- [ ] **Step 1: Write failing tests for STATE_ROOT resolution**

```typescript
// src/orchestrator/config.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('config path resolution', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses CLAUDE_PLUGIN_DATA for STORE_DIR when set', async () => {
    process.env.CLAUDE_PLUGIN_DATA = '/tmp/test-plugin-data';
    const config = await import('./config.js');
    expect(config.STORE_DIR).toBe('/tmp/test-plugin-data/store');
  });

  it('uses CLAUDE_PLUGIN_DATA for GROUPS_DIR when set', async () => {
    process.env.CLAUDE_PLUGIN_DATA = '/tmp/test-plugin-data';
    const config = await import('./config.js');
    expect(config.GROUPS_DIR).toBe('/tmp/test-plugin-data/groups');
  });

  it('uses CLAUDE_PLUGIN_DATA for LOG_DIR when set', async () => {
    process.env.CLAUDE_PLUGIN_DATA = '/tmp/test-plugin-data';
    const config = await import('./config.js');
    expect(config.LOG_DIR).toBe('/tmp/test-plugin-data/logs');
  });

  it('falls back to PROJECT_ROOT when CLAUDE_PLUGIN_DATA not set', async () => {
    delete process.env.CLAUDE_PLUGIN_DATA;
    const config = await import('./config.js');
    expect(config.GROUPS_DIR).toContain('groups');
    expect(config.STORE_DIR).toContain('store');
  });

  it('exports STATE_ROOT', async () => {
    process.env.CLAUDE_PLUGIN_DATA = '/tmp/test-plugin-data';
    const config = await import('./config.js');
    expect(config.STATE_ROOT).toBe('/tmp/test-plugin-data');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/sbusso/Code/dev/motherclaw && npx vitest run src/orchestrator/config.test.ts`
Expected: FAIL — `GROUPS_DIR` and `LOG_DIR` don't resolve from `CLAUDE_PLUGIN_DATA`

- [ ] **Step 3: Implement STATE_ROOT in config.ts**

In `src/orchestrator/config.ts`, replace lines 24 and 42-46:

```typescript
// Before:
const PROJECT_ROOT = process.cwd();
// ...
export const STORE_DIR = process.env.CLAUDE_PLUGIN_DATA
  ? path.resolve(process.env.CLAUDE_PLUGIN_DATA)
  : path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// After:
const PROJECT_ROOT = process.cwd();
export const STATE_ROOT = process.env.CLAUDE_PLUGIN_DATA
  ? path.resolve(process.env.CLAUDE_PLUGIN_DATA)
  : PROJECT_ROOT;

export const STORE_DIR = path.resolve(STATE_ROOT, 'store');
export const GROUPS_DIR = path.resolve(STATE_ROOT, 'groups');
export const LOG_DIR = path.resolve(STATE_ROOT, 'logs');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/sbusso/Code/dev/motherclaw && npx vitest run src/orchestrator/config.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite for regressions**

Run: `cd /Users/sbusso/Code/dev/motherclaw && npx vitest run`
Expected: All tests pass (GROUPS_DIR is used by group-folder.ts, db.ts — verify no breakage)

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/config.ts src/orchestrator/config.test.ts
git commit -m "feat: add STATE_ROOT — resolve state paths from CLAUDE_PLUGIN_DATA"
```

---

### Task 2: Update env.ts to read .env from correct location

**Files:**
- Modify: `src/orchestrator/env.ts`
- Create: `src/orchestrator/env.test.ts` (if not exists, add plugin-mode test)

- [ ] **Step 1: Write failing test for env file resolution**

```typescript
// src/orchestrator/env.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('readEnvFile', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('reads from MOTHERCLAW_ENV_FILE when set', async () => {
    const tmpEnv = path.join(process.env.TMPDIR || '/tmp', 'test-motherclaw.env');
    fs.writeFileSync(tmpEnv, 'TEST_KEY=from_env_file\n');
    process.env.MOTHERCLAW_ENV_FILE = tmpEnv;

    const { readEnvFile } = await import('./env.js');
    const result = readEnvFile(['TEST_KEY']);
    expect(result.TEST_KEY).toBe('from_env_file');

    fs.unlinkSync(tmpEnv);
  });

  it('reads from CLAUDE_PLUGIN_DATA/.env when set', async () => {
    const tmpDir = path.join(process.env.TMPDIR || '/tmp', 'test-plugin-data');
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.env'), 'TEST_KEY=from_plugin_data\n');
    process.env.CLAUDE_PLUGIN_DATA = tmpDir;

    const { readEnvFile } = await import('./env.js');
    const result = readEnvFile(['TEST_KEY']);
    expect(result.TEST_KEY).toBe('from_plugin_data');

    fs.rmSync(tmpDir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/sbusso/Code/dev/motherclaw && npx vitest run src/orchestrator/env.test.ts`
Expected: FAIL — readEnvFile ignores MOTHERCLAW_ENV_FILE and CLAUDE_PLUGIN_DATA

- [ ] **Step 3: Update readEnvFile in env.ts**

In `src/orchestrator/env.ts`, replace line 12:

```typescript
// Before:
const envFile = path.join(process.cwd(), '.env');

// After:
const envFile = process.env.MOTHERCLAW_ENV_FILE
  || path.join(process.env.CLAUDE_PLUGIN_DATA || process.cwd(), '.env');
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/sbusso/Code/dev/motherclaw && npx vitest run src/orchestrator/env.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `cd /Users/sbusso/Code/dev/motherclaw && npx vitest run`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/env.ts src/orchestrator/env.test.ts
git commit -m "feat: readEnvFile checks MOTHERCLAW_ENV_FILE and CLAUDE_PLUGIN_DATA"
```

---

### Task 3: Update service.ts for plugin mode

**Files:**
- Modify: `setup/service.ts`
- Modify: `setup/service.test.ts`

- [ ] **Step 1: Write failing tests for plugin-mode plist**

Add to `setup/service.test.ts`:

```typescript
describe('plugin-mode plist generation', () => {
  it('includes CLAUDE_PLUGIN_DATA env var', () => {
    const plist = generatePluginPlist(
      '/usr/local/bin/node',
      '/Users/user/.claude/plugins/motherclaw',
      '/Users/user',
      '/Users/user/Library/Application Support/Claude/plugin-data/motherclaw',
    );
    expect(plist).toContain('CLAUDE_PLUGIN_DATA');
    expect(plist).toContain('plugin-data/motherclaw');
  });

  it('includes MOTHERCLAW_ENV_FILE env var', () => {
    const plist = generatePluginPlist(
      '/usr/local/bin/node',
      '/Users/user/.claude/plugins/motherclaw',
      '/Users/user',
      '/Users/user/Library/Application Support/Claude/plugin-data/motherclaw',
    );
    expect(plist).toContain('MOTHERCLAW_ENV_FILE');
  });

  it('includes /opt/homebrew/bin in PATH', () => {
    const plist = generatePluginPlist(
      '/usr/local/bin/node',
      '/Users/user/.claude/plugins/motherclaw',
      '/Users/user',
      '/Users/user/Library/Application Support/Claude/plugin-data/motherclaw',
    );
    expect(plist).toContain('/opt/homebrew/bin');
  });

  it('sets log paths to CLAUDE_PLUGIN_DATA/logs/', () => {
    const pluginData = '/Users/user/Library/Application Support/Claude/plugin-data/motherclaw';
    const plist = generatePluginPlist(
      '/usr/local/bin/node',
      '/Users/user/.claude/plugins/motherclaw',
      '/Users/user',
      pluginData,
    );
    expect(plist).toContain(`${pluginData}/logs/motherclaw.log`);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/sbusso/Code/dev/motherclaw && npx vitest run setup/service.test.ts`
Expected: FAIL — `generatePluginPlist` does not exist

- [ ] **Step 3: Refactor service.ts to accept optional pluginDataDir**

Add a `pluginDataDir` parameter to `setupLaunchd` and `setupSystemd`. When provided:
- Add `CLAUDE_PLUGIN_DATA` and `MOTHERCLAW_ENV_FILE` to environment variables
- Log paths point to `pluginDataDir/logs/` instead of `projectRoot/logs/`
- PATH includes `/opt/homebrew/bin`

Key changes in `setupLaunchd()`:

```typescript
function setupLaunchd(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
  pluginDataDir?: string,
): void {
  const logDir = pluginDataDir ? path.join(pluginDataDir, 'logs') : path.join(projectRoot, 'logs');
  const envVars = pluginDataDir
    ? `        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin</string>
        <key>HOME</key>
        <string>${homeDir}</string>
        <key>CLAUDE_PLUGIN_DATA</key>
        <string>${pluginDataDir}</string>
        <key>MOTHERCLAW_ENV_FILE</key>
        <string>${pluginDataDir}/.env</string>`
    : `        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin</string>
        <key>HOME</key>
        <string>${homeDir}</string>`;
  // ... rest uses envVars and logDir
}
```

Also add `/opt/homebrew/bin` to PATH in both modes (existing gap fix).

- [ ] **Step 4: Update run() to detect plugin mode and pass pluginDataDir**

```typescript
export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA || undefined;
  // ... pass pluginDataDir to setupLaunchd/setupSystemd/setupNohupFallback
}
```

- [ ] **Step 5: Add generatePluginPlist helper to test file and update existing tests**

Mirror the new plist structure in the test helper. Ensure existing tests still pass with the updated PATH.

- [ ] **Step 6: Run tests**

Run: `cd /Users/sbusso/Code/dev/motherclaw && npx vitest run setup/service.test.ts`
Expected: All pass (old + new)

- [ ] **Step 7: Run full test suite**

Run: `cd /Users/sbusso/Code/dev/motherclaw && npx vitest run`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add setup/service.ts setup/service.test.ts
git commit -m "feat: service.ts supports plugin mode — CLAUDE_PLUGIN_DATA in plist/systemd"
```

---

### Task 4: Update /setup skill for mode detection

**Files:**
- Modify: `skills/setup/SKILL.md`

- [ ] **Step 1: Add mode detection section at the top of the skill**

Insert after the "Principle" paragraph, before step 0:

```markdown
## Mode Detection

Before any steps, detect the execution mode:

Run:
- `echo $CLAUDE_PLUGIN_DATA`

**If CLAUDE_PLUGIN_DATA is set → Plugin mode:**
- Skip step 0 (Git & Fork) entirely
- Print: "Running as MotherClaw plugin. State stored in $CLAUDE_PLUGIN_DATA"
- Ensure state directories exist: `mkdir -p $CLAUDE_PLUGIN_DATA/{store,groups,logs}`
- All subsequent steps use CLAUDE_PLUGIN_DATA for state paths

**If CLAUDE_PLUGIN_DATA is not set → Developer mode:**
- Proceed with all steps unchanged
```

- [ ] **Step 2: Update step 0 to be conditional**

Wrap step 0 content with: "**Developer mode only.** In plugin mode, skip to step 1."

- [ ] **Step 3: Update step 1 (Bootstrap) for plugin mode**

Add plugin-mode variant:

```markdown
**Plugin mode:** Dependencies are pre-installed. Verify only:
- `node --version` (must be 20+)
- `ls dist/service.js` (must exist — if not, run `npm run build`)
- If agent runner needs compilation: `cd agent/runner && npx tsc`
```

- [ ] **Step 4: Update step 7 (Start Service) for plugin mode**

Add note that in plugin mode, `CLAUDE_PLUGIN_DATA` is passed to the service via plist/systemd env vars. The setup script auto-detects this from the environment.

- [ ] **Step 5: Commit**

```bash
git add skills/setup/SKILL.md
git commit -m "feat: /setup detects plugin vs developer mode via CLAUDE_PLUGIN_DATA"
```

---

### Task 5: Update /customize skill with migration flow

**Files:**
- Modify: `skills/customize/SKILL.md`

- [ ] **Step 1: Add plugin-mode detection at the top of /customize**

```markdown
## Plugin Mode Detection

Run: `echo $CLAUDE_PLUGIN_DATA`

If set, offer the user a choice:
- **Fork to developer mode** — Clone the repo, migrate state, full self-improvement
- **Continue in plugin mode** — Limited customization (channel setup, config changes)

If "Fork to developer mode" chosen, run the migration flow below.
```

- [ ] **Step 2: Add migration flow section**

```markdown
## Migration: Plugin → Developer Mode

1. AskUserQuestion: "Fork sbusso/motherclaw on GitHub first. What's your GitHub username?"
2. Stop service: detect platform, run appropriate unload/stop command
3. Clone: `git clone https://github.com/<username>/motherclaw.git ~/Code/motherclaw` (ask for preferred path)
4. Copy state: `cp -r $CLAUDE_PLUGIN_DATA/{store,groups,.env} <clone-path>/`
5. Copy logs (optional): AskUserQuestion: "Copy logs too?"
6. Clear sessions: `sqlite3 <clone-path>/store/messages.db "DELETE FROM sessions"`
7. Install and build: `cd <clone-path> && npm install && npm run build`
8. Set up upstream: `cd <clone-path> && git remote add upstream https://github.com/sbusso/motherclaw.git`
9. Run service setup: `npx tsx setup/index.ts --step service`
10. Print: "Migration complete. Run `cd <clone-path> && claude` to use developer mode. Remove --plugin-dir from your Claude Code invocation."
```

- [ ] **Step 3: Commit**

```bash
git add skills/customize/SKILL.md
git commit -m "feat: /customize supports plugin→developer migration"
```

---

### Task 6: Update CLAUDE.md and build

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add "Modes" section to CLAUDE.md**

After the "Entry Points" section:

```markdown
## Modes

MotherClaw runs in two modes, detected by `CLAUDE_PLUGIN_DATA`:

**Plugin mode** (`CLAUDE_PLUGIN_DATA` set):
- Loaded via `claude --plugin-dir /path/to/motherclaw`
- State in `CLAUDE_PLUGIN_DATA` (store/, groups/, logs/, .env)
- Service plist/systemd passes `CLAUDE_PLUGIN_DATA` and `MOTHERCLAW_ENV_FILE`
- No git operations, no self-improvement
- Upgrade via `/customize` → fork + migrate

**Developer mode** (`CLAUDE_PLUGIN_DATA` not set):
- Cloned repo, `claude` runs from inside it
- State in project root (store/, groups/, logs/, .env)
- Full self-improvement
- Git/fork workflow
```

- [ ] **Step 2: Build and run full test suite**

Run:
```bash
cd /Users/sbusso/Code/dev/motherclaw && npm run build && npx vitest run
```
Expected: Build clean, all tests pass

- [ ] **Step 3: Validate plugin**

Run: `cd /Users/sbusso/Code/dev/motherclaw && claude plugin validate .`
Expected: Validation passed

- [ ] **Step 4: Commit and push**

```bash
git add CLAUDE.md
git commit -m "docs: document plugin vs developer modes in CLAUDE.md"
git push
```
