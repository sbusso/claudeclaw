---
description: Create a new MotherClaw instance
---

# Create Instance

If `${CLAUDE_PLUGIN_DATA}` is not set, print "Instance management is only available in plugin mode." and exit.

Arguments: `$ARGUMENTS` is the instance name.

1. Validate name: alphanumeric, hyphens, underscores only. Max 64 chars. No spaces or special characters.
2. Read `${CLAUDE_PLUGIN_DATA}/instances.json` (create if missing with empty instances map)
3. Check name doesn't already exist — if it does, print error and exit
4. Create directory: `mkdir -p ${CLAUDE_PLUGIN_DATA}/instances/<name>/{store,groups,logs}`
5. Add entry to `instances.json`:
   ```json
   { "created_at": "<now>", "description": "", "last_used": "<now>" }
   ```
6. AskUserQuestion: "Set **<name>** as the default instance?"
   - If yes: update `default` in `instances.json`
7. AskUserQuestion: "Run `/setup` for the new instance now?"
   - If yes: set `MOTHERCLAW_INSTANCE=<name>` in environment and invoke `/setup`
8. Print: "Instance **<name>** created."
