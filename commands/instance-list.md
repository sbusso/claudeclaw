---
description: List all MotherClaw instances with status
---

# List Instances

If `$CLAUDE_PLUGIN_DATA` is not set, print "Instance management is only available in plugin mode." and exit.

Read `$CLAUDE_PLUGIN_DATA/instances.json`. For each instance, show:

- **Name** (mark default with `*`)
- **Description**
- **Last used**
- **Service status:**
  - macOS: `launchctl list | grep com.motherclaw.<name>` — running if found
  - Linux: `systemctl --user is-active motherclaw-<name>` — running if exit 0
- **Channels:** `sqlite3 $CLAUDE_PLUGIN_DATA/instances/<name>/store/messages.db "SELECT COUNT(*) FROM registered_groups"` (0 if DB doesn't exist)

Format as a table. Example:

```
  Name        Status    Channels  Last Used    Description
* personal    running   3         2026-03-22   Personal assistant
  work        stopped   1         2026-03-20   Work channels
```
