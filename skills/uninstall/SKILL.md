---
name: uninstall
description: Stop and remove the ClaudeClaw background service and agents for this instance
trigger: /uninstall
---

# Uninstall Service

Stop and remove the ClaudeClaw background service for the current instance. Data (store/, groups/, .env) is preserved — only the service unit is removed.

## Flow

### 1. Detect OS and find service

**macOS:**
```bash
DIRNAME=$(basename "$(pwd)")
PLIST_NAME="com.claudeclaw.${DIRNAME}"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
```

**Linux:**
```bash
DIRNAME=$(basename "$(pwd)")
SERVICE_NAME="claudeclaw-${DIRNAME}"
SERVICE_PATH="$HOME/.config/systemd/user/${SERVICE_NAME}.service"
```

### 2. Check if service exists

```bash
# macOS
[ ! -f "$PLIST_PATH" ] && echo "No service found at $PLIST_PATH" && exit 0

# Linux
[ ! -f "$SERVICE_PATH" ] && echo "No service found at $SERVICE_PATH" && exit 0
```

If no service file found, also check for running processes:
```bash
# macOS — check if loaded even without plist
launchctl list | grep claudeclaw
# Linux
systemctl --user list-units | grep claudeclaw
```

### 3. Confirm with user

AskUserQuestion: "Remove ClaudeClaw service for this instance? This will stop the background process. Your data (groups, messages, .env) is preserved."

### 4. Stop and unload

**macOS:**
```bash
launchctl bootout "gui/$(id -u)/${PLIST_NAME}" 2>/dev/null || true
rm -f "$PLIST_PATH"
```

**Linux:**
```bash
systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
rm -f "$SERVICE_PATH"
systemctl --user daemon-reload
```

### 5. Verify stopped

```bash
# macOS
launchctl list | grep "$PLIST_NAME" && echo "WARNING: service still loaded" || echo "Service removed"

# Linux
systemctl --user is-active "$SERVICE_NAME" 2>/dev/null && echo "WARNING: service still running" || echo "Service removed"
```

### 6. Kill any orphan processes

```bash
pkill -f "dist/service.js" 2>/dev/null || true
```

Only kill processes whose cwd matches the current directory to avoid killing other instances.

### 7. Confirm

Print:
```
ClaudeClaw service removed for this instance.
- Service file: deleted
- Process: stopped
- Data: preserved (store/, groups/, .env still in place)
- To reinstall: run /setup
```
