---
name: add-slack
description: Add Slack as a channel. Can replace WhatsApp entirely or run alongside it. Uses Socket Mode (no public URL needed).
---

# Add Slack Channel

This skill adds Slack support to MotherClaw, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/slack.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

**Do they already have a Slack app configured?** If yes, collect the Bot Token and App Token now. If no, we'll create one in Phase 3.

## Phase 2: Apply Code Changes

### Ensure channel remote

```bash
git remote -v
```

If `slack` is missing, add it:

```bash
git remote add slack https://github.com/sbusso/motherclaw-slack.git
```

### Merge the skill branch

```bash
git fetch slack main
git merge slack/main || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `src/channels/slack.ts` (SlackChannel class with self-registration via `registerChannel`)
- `src/channels/slack.test.ts` (46 unit tests)
- `import './slack.js'` appended to the channel barrel file `src/channels/index.ts`
- `@slack/bolt` npm dependency in `package.json`
- `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` in `.env.example`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install
npm run build
npx vitest run src/channels/slack.test.ts
```

All tests must pass (including the new Slack tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create Slack App (if needed)

If the user doesn't have a Slack app, share [SLACK_SETUP.md](SLACK_SETUP.md) which has step-by-step instructions with screenshots guidance, troubleshooting, and a token reference table.

Quick summary of what's needed:
1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps)
2. Enable Socket Mode and generate an App-Level Token (`xapp-...`)
3. Subscribe to bot events: `message.channels`, `message.groups`, `message.im`
4. Add OAuth scopes: `chat:write`, `channels:history`, `groups:history`, `im:history`, `channels:read`, `groups:read`, `users:read`
5. Install to workspace and copy the Bot Token (`xoxb-...`)

Wait for the user to provide both tokens.

### Configure environment

Add to `.env`:

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
```

Channels auto-enable when their credentials are present — no extra configuration needed.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

> **Service name:** Derived from the directory name: `com.motherclaw.<dirname>` (macOS) / `motherclaw-<dirname>` (Linux). For example, if cwd is `my-assistant`, the service is `com.motherclaw.my-assistant`. Determine the correct service name before running service commands below.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.motherclaw
```

## Phase 4: Registration

### 4a. Auto-detect bot display name

Use the Slack API to get the bot's actual display name. Do NOT ask the user — detect it:

```bash
# Get bot user ID
BOT_USER_ID=$(curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" "https://slack.com/api/auth.test" | jq -r '.user_id')
echo "Bot user ID: $BOT_USER_ID"

# Get bot display name
BOT_DISPLAY_NAME=$(curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" "https://slack.com/api/users.info?user=$BOT_USER_ID" | jq -r '.user.profile.display_name // .user.real_name // .user.name')
echo "Bot display name: $BOT_DISPLAY_NAME"
```

**Set ASSISTANT_NAME in .env** to the detected bot name:

```bash
# Update or add ASSISTANT_NAME in .env
if grep -q '^ASSISTANT_NAME=' .env; then
  sed -i'' -e "s/^ASSISTANT_NAME=.*/ASSISTANT_NAME=$BOT_DISPLAY_NAME/" .env
else
  echo "ASSISTANT_NAME=$BOT_DISPLAY_NAME" >> .env
fi
```

Print: "Detected Slack bot name: **$BOT_DISPLAY_NAME** — trigger pattern will be @$BOT_DISPLAY_NAME"

If `BOT_DISPLAY_NAME` is empty or the API call failed, AskUserQuestion: "Couldn't auto-detect your Slack bot's display name. What is the bot's display name in Slack?"

### 4b. List available channels

Instead of asking the user to manually find channel IDs, list them:

```bash
curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  "https://slack.com/api/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=100" \
  | jq -r '.channels[] | select(.is_member == true) | "\(.id) #\(.name)"'
```

This shows only channels where the bot is already a member. If the list is empty, tell the user to add the bot to a channel first (right-click channel → **View channel details** → **Integrations** → **Add apps**), then re-run the list.

AskUserQuestion: "Which channel should be the main channel? (Select from the list above, or provide a channel ID)"

For each additional channel the user wants, repeat the selection.

### 4c. Register the channel

The channel ID, name, and folder name are needed. Use `npx tsx setup/index.ts --step register` with the appropriate flags. Use `$BOT_DISPLAY_NAME` for the trigger, NOT `${ASSISTANT_NAME}` (which may still be the old default).

For a main channel (responds to all messages):

```bash
npx tsx setup/index.ts --step register -- --jid "slack:<channel-id>" --name "<channel-name>" --folder "slack_main" --trigger "@$BOT_DISPLAY_NAME" --channel slack --no-trigger-required --is-main
```

For additional channels (trigger-only):

```bash
npx tsx setup/index.ts --step register -- --jid "slack:<channel-id>" --name "<channel-name>" --folder "slack_<channel-name>" --trigger "@$BOT_DISPLAY_NAME" --channel slack
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message in your registered Slack channel:
> - For main channel: Any message works
> - For non-main: `@<assistant-name> hello` (using the configured trigger word)
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/motherclaw.log
```

## Troubleshooting

### Bot not responding

1. Check `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set in `.env` AND synced to `data/env/env`
2. Check channel is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'slack:%'"`
3. For non-main channels: message must include trigger pattern
4. Service is running: `launchctl list | grep motherclaw`

### Bot connected but not receiving messages

1. Verify Socket Mode is enabled in the Slack app settings
2. Verify the bot is subscribed to the correct events (`message.channels`, `message.groups`, `message.im`)
3. Verify the bot has been added to the channel
4. Check that the bot has the required OAuth scopes

### Bot not seeing messages in channels

By default, bots only see messages in channels they've been explicitly added to. Make sure to:
1. Add the bot to each channel you want it to monitor
2. Check the bot has `channels:history` and/or `groups:history` scopes

### "missing_scope" errors

If the bot logs `missing_scope` errors:
1. Go to **OAuth & Permissions** in your Slack app settings
2. Add the missing scope listed in the error message
3. **Reinstall the app** to your workspace — scope changes require reinstallation
4. Copy the new Bot Token (it changes on reinstall) and update `.env`
5. Sync: `mkdir -p data/env && cp .env data/env/env`
6. Restart: `launchctl kickstart -k gui/$(id -u)/com.motherclaw`

### Getting channel ID

If the channel ID is hard to find:
- In Slack desktop: right-click channel → **Copy link** → extract the `C...` ID from the URL
- In Slack web: the URL shows `https://app.slack.com/client/TXXXXXXX/C0123456789`
- Via API: `curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" "https://slack.com/api/conversations.list" | jq '.channels[] | {id, name}'`

## After Setup

The Slack channel supports:
- **Public channels** — Bot must be added to the channel
- **Private channels** — Bot must be invited to the channel
- **Direct messages** — Users can DM the bot directly
- **Multi-channel** — Can run alongside WhatsApp or other channels (auto-enabled by credentials)

## Known Limitations

- **Threads are flattened** — Threaded replies are delivered to the agent as regular channel messages. The agent sees them but has no awareness they originated in a thread. Responses always go to the channel, not back into the thread. Users in a thread will need to check the main channel for the bot's reply. Full thread-aware routing (respond in-thread) requires pipeline-wide changes: database schema, `NewMessage` type, `Channel.sendMessage` interface, and routing logic.
- **No typing indicator** — Slack's Bot API does not expose a typing indicator endpoint. The `setTyping()` method is a no-op. Users won't see "bot is typing..." while the agent works.
- **Message splitting is naive** — Long messages are split at a fixed 4000-character boundary, which may break mid-word or mid-sentence. A smarter split (on paragraph or sentence boundaries) would improve readability.
- **No file/image handling** — The bot only processes text content. File uploads, images, and rich message blocks are not forwarded to the agent.
- **Channel metadata sync is unbounded** — `syncChannelMetadata()` paginates through all channels the bot is a member of, but has no upper bound or timeout. Workspaces with thousands of channels may experience slow startup.
- **Workspace admin policies not detected** — If the Slack workspace restricts bot app installation, the setup will fail at the "Install to Workspace" step with no programmatic detection or guidance. See SLACK_SETUP.md troubleshooting section.
