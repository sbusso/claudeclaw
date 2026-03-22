---
name: setup
description: Run initial MotherClaw setup. Use when user wants to install dependencies, authenticate messaging channels, register their main channel, or start the background services. Triggers on "setup", "install", "configure motherclaw", or first-time setup requests.
---

# MotherClaw Setup

Run setup steps automatically. Only pause when user action is required (channel authentication, configuration choices). Setup uses `bash setup.sh` for bootstrap, then `npx tsx setup/index.ts --step <name>` for all other steps. Steps emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. authenticating a channel, pasting a secret token). If a dependency is missing, install it. If a service won't start, diagnose and repair. Ask the user for permission when needed, then do the work.

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

## Mode Detection

Before any steps, detect the execution mode:

```bash
cat .claude-plugin/plugin.json 2>/dev/null | grep '"name": "motherclaw"' && echo "DEVELOPER_MODE" || echo "PLUGIN_MODE"
```

If `.claude-plugin/plugin.json` exists in the current directory AND contains `"name": "motherclaw"`, we're inside the MotherClaw repo → **Developer mode**. Otherwise, the skill was loaded via `--plugin-dir` → **Plugin mode**.

### Directory = Instance model

The current working directory IS the MotherClaw instance. All state (`.env`, `store/`, `groups/`, `logs/`) lives in cwd. Multiple instances = multiple directories. No hidden state, no `~/.claude/plugin-data/`.

**Plugin mode** (no `.claude-plugin/` in cwd):
- Skip step 0 (Git & Fork) entirely
- The current directory is the data directory — all state goes here
- Plugin code directory: `${CLAUDE_PLUGIN_ROOT}`
- Ensure data directories exist: `mkdir -p store groups logs`
- Check for `.motherclaw.json` — if it exists, this directory has been set up before; if not, this is a fresh setup

**CRITICAL — Plugin mode command prefix:** All `npx tsx setup/index.ts` commands in subsequent steps MUST be run from the plugin code directory with `CLAUDE_PLUGIN_ROOT` set, but the working directory for the service must be the USER's current directory (the data dir). Use this pattern:

```bash
cd ${CLAUDE_PLUGIN_ROOT} && MOTHERCLAW_ENV_FILE=$(pwd)/.env npx tsx setup/index.ts --step <name>
```

Where `$(pwd)` resolves to the user's data directory BEFORE the `cd`. Store the data dir first:
```bash
MCLAW_PROJECT=$(pwd) && cd ${CLAUDE_PLUGIN_ROOT} && MOTHERCLAW_PROJECT_DIR=$MCLAW_PROJECT MOTHERCLAW_ENV_FILE=$MCLAW_PROJECT/.env npx tsx setup/index.ts --step <name>
```

`MOTHERCLAW_PROJECT_DIR` tells setup scripts the actual project directory (where `.env`, `store/`, `groups/`, `logs/` live). Without it, they fall back to `process.cwd()` which is the plugin code root after the `cd`.

**Developer mode** (`.claude-plugin/` in cwd):
- Proceed with all steps unchanged
- Code and state live in the same directory

## 0. Git & Fork Setup (Developer mode only)

**Plugin mode:** Skip this step entirely — there is no git repo to manage.

Check the git remote configuration to ensure the user has a fork and upstream is configured.

Run:
- `git remote -v`

**Case A — `origin` points to `sbusso/motherclaw` (user cloned directly):**

The user cloned instead of forking. AskUserQuestion: "You cloned MotherClaw directly. We recommend forking so you can push your customizations. Would you like to set up a fork?"
- Fork now (recommended) — walk them through it
- Continue without fork — they'll only have local changes

If fork: instruct the user to fork `sbusso/motherclaw` on GitHub (they need to do this in their browser), then ask them for their GitHub username. Run:
```bash
git remote rename origin upstream
git remote add origin https://github.com/<their-username>/motherclaw.git
git push --force origin main
```
Verify with `git remote -v`.

If continue without fork: add upstream so they can still pull updates:
```bash
git remote add upstream https://github.com/sbusso/motherclaw.git
```

**Case B — `origin` points to user's fork, no `upstream` remote:**

Add upstream:
```bash
git remote add upstream https://github.com/sbusso/motherclaw.git
```

**Case C — both `origin` (user's fork) and `upstream` (qwibitai) exist:**

Already configured. Continue.

**Verify:** `git remote -v` should show `origin` → user's repo, `upstream` → `sbusso/motherclaw.git`.

## 1. Bootstrap (Node.js + Dependencies)

**Plugin mode:** Dependencies are pre-installed in the plugin directory. Verify only:
- `node --version` (must be 20+)
- `ls dist/service.js` (must exist — if not, run `npm run build` in the plugin dir)
- If agent runner needs compilation: `cd agent/runner && npx tsc`
- Skip `bash setup.sh` entirely.

**Developer mode:** Run `bash setup.sh` and parse the status block.

- If NODE_OK=false → Node.js is missing or too old. Use `AskUserQuestion: Would you like me to install Node.js 22?` If confirmed:
  - macOS: `brew install node@22` (if brew available) or install nvm then `nvm install 22`
  - Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`, or nvm
  - After installing Node, re-run `bash setup.sh`
- If DEPS_OK=false → Read `logs/setup.log`. Try: delete `node_modules`, re-run `bash setup.sh`. If native module build fails, install build tools (`xcode-select --install` on macOS, `build-essential` on Linux), then retry.
- If NATIVE_OK=false → better-sqlite3 failed to load. Install build tools and re-run.
- Record PLATFORM and IS_WSL for later steps.

## 2. Check Environment

Run `npx tsx setup/index.ts --step environment` and parse the status block.

- If HAS_AUTH=true → WhatsApp is already configured, note for step 5
- If HAS_REGISTERED_GROUPS=true → note existing config, offer to skip or reconfigure
- Record APPLE_CONTAINER and DOCKER values for step 3

## 3. Container Runtime

### 3a. Choose runtime

Check the preflight results for `APPLE_CONTAINER` and `DOCKER`, and the PLATFORM from step 1.

Use `AskUserQuestion` with options:
- **Sandbox (Recommended)** — OS-level sandboxing via `@anthropic-ai/sandbox-runtime`. <10ms cold starts, no container daemon needed, kernel-enforced isolation. macOS/Linux only.
- **Apple Container** — Native macOS container (if APPLE_CONTAINER=installed)
- **Docker** — Cross-platform container runtime

If **Sandbox** chosen:
- Run `npm install @anthropic-ai/sandbox-runtime` if not already installed
- Set `RUNTIME=sandbox` in `.env`
- Pre-compile agent runner: `cd agent/runner && npx tsc`
- Skip container build (3b, 3c) — go directly to step 4

If **Apple Container** or **Docker** chosen, continue with the container setup below:

- PLATFORM=linux → Docker (only option among container runtimes)
- PLATFORM=macos + APPLE_CONTAINER=installed → Apple Container or Docker
- PLATFORM=macos + APPLE_CONTAINER=not_found → Docker

### 3a-docker. Install Docker

- DOCKER=running → continue to 4b
- DOCKER=installed_not_running → start Docker: `open -a Docker` (macOS) or `sudo systemctl start docker` (Linux). Wait 15s, re-check with `docker info`.
- DOCKER=not_found → Use `AskUserQuestion: Docker is required for running agents. Would you like me to install it?` If confirmed:
  - macOS: install via `brew install --cask docker`, then `open -a Docker` and wait for it to start. If brew not available, direct to Docker Desktop download at https://docker.com/products/docker-desktop
  - Linux: install with `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`. Note: user may need to log out/in for group membership.

### 3b. Apple Container conversion gate (if needed)

**If the chosen runtime is Apple Container**, you MUST check whether the source code has already been converted from Docker to Apple Container. Do NOT skip this step. Run:

```bash
grep -q "CONTAINER_RUNTIME_BIN = 'container'" src/orchestrator/container-runtime.ts && echo "ALREADY_CONVERTED" || echo "NEEDS_CONVERSION"
```

**If NEEDS_CONVERSION**, the source code still uses Docker as the runtime. You MUST run the `/convert-to-apple-container` skill NOW, before proceeding to the build step.

**If ALREADY_CONVERTED**, the code already uses Apple Container. Continue to 3c.

**If the chosen runtime is Docker**, no conversion is needed. Continue to 3c.

### 3c. Build and test

Run `npx tsx setup/index.ts --step container -- --runtime <chosen>` and parse the status block.

**If BUILD_OK=false:** Read `logs/setup.log` tail for the build error.
- Cache issue (stale layers): `docker builder prune -f` (Docker) or `container builder stop && container builder rm && container builder start` (Apple Container). Retry.
- Dockerfile syntax or missing files: diagnose from the log and fix, then retry.

**If TEST_OK=false but BUILD_OK=true:** The image built but won't run. Check logs — common cause is runtime not fully started. Wait a moment and retry the test.

## 4. Claude Authentication (No Script)

If HAS_ENV=true from step 2, read `.env` and check for `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. If present, confirm with user: keep or reconfigure?

AskUserQuestion: Claude subscription (Pro/Max) vs Anthropic API key?

**Subscription:** Tell user to run `claude setup-token` in another terminal, copy the token, add `CLAUDE_CODE_OAUTH_TOKEN=<token>` to `.env`. Do NOT collect the token in chat.

**API key:** Tell user to add `ANTHROPIC_API_KEY=<key>` to `.env`.

## 5. Set Up Channels

AskUserQuestion (multiSelect): Which messaging channels do you want to enable?
- WhatsApp (authenticates via QR code or pairing code)
- Telegram (authenticates via bot token from @BotFather)
- Slack (authenticates via Slack app with Socket Mode)
- Discord (authenticates via Discord bot token)

**Delegate to each selected channel's own skill.** Each channel skill handles its own code installation, authentication, registration, and JID resolution. This avoids duplicating channel-specific logic and ensures JIDs are always correct.

For each selected channel, invoke its skill:

- **WhatsApp:** Invoke `/add-whatsapp`
- **Telegram:** Invoke `/add-telegram`
- **Slack:** Invoke `/add-slack`
- **Discord:** Invoke `/add-discord`

Each skill will:
1. Install the channel code (via `git merge` of the skill branch)
2. Collect credentials/tokens and write to `.env`
3. Authenticate (WhatsApp QR/pairing, or verify token-based connection)
4. **Auto-detect the bot's display name** from the platform API and set `ASSISTANT_NAME` in `.env`
5. Register the chat with the correct JID format (trigger uses the detected bot name)
6. Build and verify

**IMPORTANT:** The channel skill sets `ASSISTANT_NAME` in `.env` based on the platform API (e.g., Slack's `auth.test` → `users.info`). This ensures the trigger pattern matches the bot's actual display name. Never hardcode a name or use the default.

**After all channel skills complete**, install dependencies and rebuild — channel merges may introduce new packages:

```bash
npm install && npm run build
```

If the build fails, read the error output and fix it (usually a missing dependency). Then continue to step 6.

## 6. Mount Allowlist

AskUserQuestion: Agent access to external directories?

**No:** `npx tsx setup/index.ts --step mounts -- --empty`
**Yes:** Collect paths/permissions. `npx tsx setup/index.ts --step mounts -- --json '{"allowedRoots":[...],"blockedPatterns":[],"nonMainReadOnly":true}'`

## 7. Start Service

The setup script generates a service whose WorkingDirectory is the current data directory. In plugin mode, the ExecStart points to `${CLAUDE_PLUGIN_ROOT}/dist/service.js`. Logs go to `<dataDir>/logs/`.

> **Service name:** Derived from the directory name: `com.motherclaw.<dirname>` (macOS) / `motherclaw-<dirname>` (Linux). For example, if cwd is `/home/user/my-assistant`, the service is `com.motherclaw.my-assistant`. Determine the correct service name before running service commands below.

If service already running: unload first.
- macOS: `launchctl unload ~/Library/LaunchAgents/com.motherclaw.plist`
- Linux: `systemctl --user stop motherclaw` (or `systemctl stop motherclaw` if root)

Run `npx tsx setup/index.ts --step service` and parse the status block.

**If FALLBACK=wsl_no_systemd:** WSL without systemd detected. Tell user they can either enable systemd in WSL (`echo -e "[boot]\nsystemd=true" | sudo tee /etc/wsl.conf` then restart WSL) or use the generated `start-motherclaw.sh` wrapper.

**If DOCKER_GROUP_STALE=true:** The user was added to the docker group after their session started — the systemd service can't reach the Docker socket. Ask user to run these two commands:

1. Immediate fix: `sudo setfacl -m u:$(whoami):rw /var/run/docker.sock`
2. Persistent fix (re-applies after every Docker restart):
```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/socket-acl.conf << 'EOF'
[Service]
ExecStartPost=/usr/bin/setfacl -m u:USERNAME:rw /var/run/docker.sock
EOF
sudo systemctl daemon-reload
```
Replace `USERNAME` with the actual username (from `whoami`). Run the two `sudo` commands separately — the `tee` heredoc first, then `daemon-reload`. After user confirms setfacl ran, re-run the service step.

**If SERVICE_LOADED=false:**
- Read `logs/setup.log` for the error.
- macOS: check `launchctl list | grep motherclaw`. If PID=`-` and status non-zero, read `logs/motherclaw.error.log`.
- Linux: check `systemctl --user status motherclaw`.
- Re-run the service step after fixing.

## 8. Verify

Run `npx tsx setup/index.ts --step verify` and parse the status block.

**If STATUS=failed, fix each:**
- SERVICE=stopped → `npm run build`, then restart: `launchctl kickstart -k gui/$(id -u)/com.motherclaw` (macOS) or `systemctl --user restart motherclaw` (Linux) or `bash start-motherclaw.sh` (WSL nohup)
- SERVICE=not_found → re-run step 7
- CREDENTIALS=missing → re-run step 4
- CHANNEL_AUTH shows `not_found` for any channel → re-invoke that channel's skill (e.g. `/add-telegram`)
- REGISTERED_GROUPS=0 → re-invoke the channel skills from step 5
- MOUNT_ALLOWLIST=missing → `npx tsx setup/index.ts --step mounts -- --empty`

Tell user to test: send a message in their registered chat. Show: `tail -f logs/motherclaw.log`

## 9. Post-Setup Audit

After verify passes, run a deeper sanity check. This catches configuration mismatches that individual steps miss.

### 9a. Bot name consistency

For Slack channels, verify ASSISTANT_NAME matches the actual Slack bot display name:

```bash
# Get actual bot name from Slack API
SLACK_BOT_TOKEN=$(grep SLACK_BOT_TOKEN .env | cut -d= -f2)
BOT_USER_ID=$(curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" "https://slack.com/api/auth.test" | python3 -c "import sys,json; print(json.load(sys.stdin).get('user_id',''))")
ACTUAL_NAME=$(curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" "https://slack.com/api/users.info?user=$BOT_USER_ID" | python3 -c "import sys,json; u=json.load(sys.stdin).get('user',{}); p=u.get('profile',{}); print(p.get('display_name') or u.get('real_name') or u.get('name',''))")

# Get configured name
CONFIGURED_NAME=$(grep ASSISTANT_NAME .env | cut -d= -f2)

echo "Slack bot name: $ACTUAL_NAME"
echo "Configured name: $CONFIGURED_NAME"
```

If they don't match (or ASSISTANT_NAME is missing):
1. Set `ASSISTANT_NAME=$ACTUAL_NAME` in `.env`
2. Update all registered groups: `sqlite3 store/messages.db "UPDATE registered_groups SET trigger_pattern = '@$ACTUAL_NAME'"`
3. Restart the service

### 9b. Service points to correct directories

```bash
# macOS
PLIST=$(ls ~/Library/LaunchAgents/com.motherclaw.*.plist 2>/dev/null | head -1)
if [ -n "$PLIST" ]; then
  WORKING_DIR=$(plutil -extract WorkingDirectory raw "$PLIST" 2>/dev/null)
  CURRENT_DIR=$(pwd)
  echo "Plist WorkingDirectory: $WORKING_DIR"
  echo "Current project dir:    $CURRENT_DIR"
fi
```

If `WorkingDirectory` doesn't match the current project directory, the service is running from the wrong place. Re-run step 7.

### 9c. No state in plugin source

In plugin mode only — verify no state leaked into the plugin code directory:

```bash
PLUGIN_DIR=${CLAUDE_PLUGIN_ROOT}
if [ -n "$PLUGIN_DIR" ]; then
  LEAKED=""
  [ -f "$PLUGIN_DIR/store/messages.db" ] && LEAKED="$LEAKED store/messages.db"
  [ -d "$PLUGIN_DIR/groups" ] && [ "$(ls -A $PLUGIN_DIR/groups 2>/dev/null)" ] && LEAKED="$LEAKED groups/"
  [ -f "$PLUGIN_DIR/logs/motherclaw.log" ] && LEAKED="$LEAKED logs/motherclaw.log"
  if [ -n "$LEAKED" ]; then
    echo "WARNING: State found in plugin source dir: $LEAKED"
    echo "This data should be in the project dir, not the plugin code."
  else
    echo "OK: No state in plugin source dir"
  fi
fi
```

If state leaked, move it to the project dir and clean the plugin source.

### 9d. Channel activation matches config

Check that only configured channels are active in the service logs:

```bash
echo "=== Channels that should be active ==="
grep 'SLACK_BOT_TOKEN' .env >/dev/null 2>&1 && echo "Slack: configured"
[ -f store/auth/creds.json ] && echo "WhatsApp: configured"
grep 'TELEGRAM_BOT_TOKEN' .env >/dev/null 2>&1 && echo "Telegram: configured"

echo "=== Channels in service logs ==="
grep -E 'Connected to|skipping|credentials missing' logs/motherclaw.log | tail -10
```

If a channel shows "credentials missing — skipping" that's correct for unconfigured channels. If a channel crashes or loops, that's a bug.

### 9e. Summary

Print a final summary:

```
✓ Bot name: ClaudeDev (matches Slack API)
✓ Trigger: @ClaudeDev
✓ Service: com.motherclaw.my-assistant (running, PID 12345)
✓ WorkingDirectory: /home/user/my-assistant
✓ Channels: Slack (connected)
✓ No state in plugin source
```

If any check fails, fix it before telling the user setup is complete.

## Troubleshooting

**Service not starting:** Check `logs/motherclaw.error.log`. Common: wrong Node path (re-run step 7), missing `.env` (step 4), missing channel credentials (re-invoke channel skill).

**Container agent fails ("Claude Code process exited with code 1"):** Ensure the container runtime is running — `open -a Docker` (macOS Docker), `container system start` (Apple Container), or `sudo systemctl start docker` (Linux). Check container logs in `groups/main/logs/container-*.log`.

**No response to messages:** Check trigger pattern. Main channel doesn't need prefix. Check DB: `npx tsx setup/index.ts --step verify`. Check `logs/motherclaw.log`.

**Channel not connecting:** Verify the channel's credentials are set in `.env`. Channels auto-enable when their credentials are present. For WhatsApp: check `store/auth/creds.json` exists. For token-based channels: check token values in `.env`. Restart the service after any `.env` change.

**Unload service:** macOS: `launchctl unload ~/Library/LaunchAgents/com.motherclaw.plist` | Linux: `systemctl --user stop motherclaw`
