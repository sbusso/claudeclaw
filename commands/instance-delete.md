---
description: Delete a MotherClaw instance and its data
---

# Delete Instance

If `$CLAUDE_PLUGIN_DATA` is not set, print "Instance management is only available in plugin mode." and exit.

Arguments: `$ARGUMENTS` is the instance name to delete.

1. Read `$CLAUDE_PLUGIN_DATA/instances.json`
2. Verify instance exists — if not, print error and list available instances
3. If instance is the current `default`: print "Cannot delete the default instance. Switch to another instance first with `/instance-switch <name>`." and exit
4. AskUserQuestion: "Delete instance **<name>**? This removes all data (groups, messages, config). This cannot be undone."
5. If confirmed, stop the instance's service:
   - macOS: `launchctl unload ~/Library/LaunchAgents/com.motherclaw.<name>.plist 2>/dev/null; rm -f ~/Library/LaunchAgents/com.motherclaw.<name>.plist`
   - Linux: `systemctl --user stop motherclaw-<name> 2>/dev/null; systemctl --user disable motherclaw-<name> 2>/dev/null; rm -f ~/.config/systemd/user/motherclaw-<name>.service; systemctl --user daemon-reload`
6. Remove instance directory: `rm -rf $CLAUDE_PLUGIN_DATA/instances/<name>`
7. Remove entry from `instances.json` and write back
8. Print: "Instance **<name>** deleted."
