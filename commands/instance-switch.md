---
description: Switch the default MotherClaw instance
---

# Switch Instance

Check: `cat .claude-plugin/plugin.json 2>/dev/null | grep '"name": "motherclaw"'`. If it matches, we're in the MotherClaw repo (developer mode) — print "Instance management is only available in plugin mode." and exit.

Arguments: `$ARGUMENTS` is the instance name to switch to.

1. Read `${CLAUDE_PLUGIN_DATA}/instances.json`
2. Verify the instance exists in the `instances` map
3. If not found, list available instances and exit
4. Update `default` field to the requested instance name
5. Update `last_used` timestamp on the target instance
6. Write back to `instances.json`
7. Print: "Switched default to **<name>**. Restart Claude Code for the change to take effect."
