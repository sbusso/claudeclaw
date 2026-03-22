---
name: uninstall-extension
description: Uninstall a ClaudeClaw extension
trigger: /uninstall <name>
---

# Uninstall Extension

Remove an installed ClaudeClaw extension.

## Usage

```
/uninstall slack
/uninstall triage
```

## Flow

### 1. Validate

```bash
EXTENSION_NAME="${1}"
EXT_DIR="extensions/claudeclaw-${EXTENSION_NAME}"
[ ! -d "$EXT_DIR" ] && echo "Extension claudeclaw-${EXTENSION_NAME} is not installed." && exit 1
```

### 2. Read manifest

```bash
cat "$EXT_DIR/manifest.json"
```

### 3. Confirm with user

AskUserQuestion: "Uninstall claudeclaw-<name>? This will remove its skills, agents, and agent skills. The extension's data (groups, messages) is preserved."

### 4. Run post-uninstall hook

If `manifest.json` has `hooks.postUninstall`:

```bash
chmod +x "$EXT_DIR/hooks/uninstall.sh"
bash "$EXT_DIR/hooks/uninstall.sh" "$(git rev-parse --show-toplevel)"
```

### 5. Remove extension directory

```bash
rm -rf "$EXT_DIR"
```

### 6. Rebuild and restart

```bash
npm run build
```

Restart the service (same as install skill step 8).

### 7. Confirm

Print: "Extension claudeclaw-<name> uninstalled. Data in groups/ and store/ is preserved."
