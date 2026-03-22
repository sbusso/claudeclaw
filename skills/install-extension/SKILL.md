---
name: install-extension
description: Install a MotherClaw extension (e.g., slack, triage)
trigger: /install <name>
---

# Install Extension

Install a MotherClaw extension from GitHub.

## Usage

```
/install slack
/install triage
```

## Flow

### 1. Validate input

The argument is the extension short name (e.g., `slack`, `triage`). The full repo name is `motherclaw-<name>`.

```bash
EXTENSION_NAME="${1}"
REPO="https://github.com/sbusso/motherclaw-${EXTENSION_NAME}.git"
EXT_DIR="extensions/motherclaw-${EXTENSION_NAME}"
```

### 2. Check if already installed

```bash
[ -d "$EXT_DIR" ] && echo "Extension motherclaw-${EXTENSION_NAME} is already installed." && exit 0
```

If already installed, ask if the user wants to update instead (git pull + rebuild).

### 3. Clone the extension

```bash
mkdir -p extensions
git clone "$REPO" "$EXT_DIR"
```

### 4. Read manifest and install dependencies

```bash
cat "$EXT_DIR/manifest.json"
```

If `manifest.json` has a `dependencies` field, install them at the root:

```bash
cd "$(git rev-parse --show-toplevel)" && npm install <each dependency with version>
```

### 5. Compile the extension

```bash
cd "$EXT_DIR" && npx tsc
```

### 6. Run post-install hook

If `manifest.json` has `hooks.postInstall`:

```bash
chmod +x "$EXT_DIR/hooks/install.sh"
bash "$EXT_DIR/hooks/install.sh" "$(git rev-parse --show-toplevel)"
```

This copies skills, agents, and agent skills into the MotherClaw root.

### 7. Rebuild core

```bash
npm run build
```

### 8. Restart service

Detect OS and restart:

**macOS:**
```bash
SERVICE_NAME=$(launchctl list | grep motherclaw | awk '{print $3}')
[ -n "$SERVICE_NAME" ] && launchctl kickstart -k "gui/$(id -u)/$SERVICE_NAME"
```

**Linux:**
```bash
systemctl --user restart motherclaw
```

### 9. Verify

Print confirmation:
```
Extension motherclaw-<name> installed successfully.
- Skills: <list from manifest>
- Type: <channel|extension>
- Restart: service restarted
```
