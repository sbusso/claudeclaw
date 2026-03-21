import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../orchestrator/config.js';
import { updateChatName } from '../orchestrator/db.js';
import { readEnvFile } from '../orchestrator/env.js';
import { logger } from '../orchestrator/logger.js';
import { registerChannel, ChannelOpts } from '../orchestrator/channel-registry.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../orchestrator/types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined) and bot messages
// (BotMessageEvent, subtype 'bot_message') so we can track our own output.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botUserId: string | undefined;
  private botId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  // Track the last inbound message ts per JID for reaction-based typing indicator
  private lastMessageTs = new Map<string, string>();

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching MotherClaw's security pattern)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.app.event('message', async ({ event }) => {
      const subtype = (event as { subtype?: string }).subtype;
      // Skip list_record_comment — list items are status display only
      if (subtype === 'list_record_comment') return;
      if (subtype && subtype !== 'bot_message') return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;

      if (!msg.text) return;

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery (using base channel JID)
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Check for thread_ts to build a thread-encoded JID.
      // If that thread JID is registered as a group, route there instead.
      const threadTs = (msg as any).thread_ts as string | undefined;
      const threadJid = threadTs ? `slack:${msg.channel}:${threadTs}` : null;

      const groups = this.opts.registeredGroups();
      const effectiveJid = threadJid && groups[threadJid] ? threadJid : jid;

      // DMs are auto-accepted and auto-registered.
      // Channel messages require prior registration.
      const isDM = msg.channel_type === 'im';
      if (!isDM && !groups[effectiveJid]) return;

      // Auto-register DMs on first contact so the orchestrator can process them
      if (isDM && !groups[effectiveJid] && this.opts.registerGroup) {
        const userName = msg.user
          ? await this.resolveUserName(msg.user)
          : undefined;
        const folderName = `slack_dm_${msg.user || msg.channel}`;
        this.opts.registerGroup(effectiveJid, {
          name: userName ? `DM: ${userName}` : `DM: ${msg.channel}`,
          folder: folderName,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        });
        logger.info(
          { jid: effectiveJid, folder: folderName },
          'Auto-registered Slack DM',
        );
      }

      // Only treat messages from OUR bot as "from me". Other bots (Workflow
      // Builder, integrations) should be processed as regular inbound messages.
      const isBotMessage =
        msg.user === this.botUserId ||
        (!!msg.bot_id && msg.bot_id === this.botId);

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot is @mentioned.
      let content = msg.text;
      if (this.botUserId && !isBotMessage) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (
          content.includes(mentionPattern) &&
          !TRIGGER_PATTERN.test(content)
        ) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Track last inbound message for reaction-based typing indicator
      if (!isBotMessage) {
        this.lastMessageTs.set(effectiveJid, msg.ts);
      }

      this.opts.onMessage(effectiveJid, {
        id: msg.ts,
        chat_jid: effectiveJid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
      });
    });
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      this.botId = auth.bot_id as string | undefined;
      logger.info(
        { botUserId: this.botUserId, botId: this.botId },
        'Connected to Slack',
      );
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Parse thread-encoded JID: slack:<channel> or slack:<channel>:<thread_ts>
    const stripped = jid.replace(/^slack:/, '');
    const colonIdx = stripped.indexOf(':');
    const channelId = colonIdx === -1 ? stripped : stripped.slice(0, colonIdx);
    const threadTs = colonIdx === -1 ? undefined : stripped.slice(colonIdx + 1);

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      // Slack limits messages to ~4000 characters; split if needed
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        });
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: text.slice(i, i + MAX_MESSAGE_LENGTH),
            ...(threadTs ? { thread_ts: threadTs } : {}),
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  // Use emoji reactions as a typing indicator since Slack has no typing API for bots.
  // Adds 👀 to the last user message when working, removes it when done.
  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const messageTs = this.lastMessageTs.get(jid);
    if (!messageTs) {
      logger.debug(
        { jid, isTyping, trackedJids: [...this.lastMessageTs.keys()] },
        'setTyping: no message ts tracked',
      );
      return;
    }

    // Parse channel from JID
    const stripped = jid.replace(/^slack:/, '');
    const colonIdx = stripped.indexOf(':');
    const channelId = colonIdx === -1 ? stripped : stripped.slice(0, colonIdx);

    try {
      if (isTyping) {
        await this.app.client.reactions.add({
          channel: channelId,
          timestamp: messageTs,
          name: 'eyes',
        });
      } else {
        await this.app.client.reactions.remove({
          channel: channelId,
          timestamp: messageTs,
          name: 'eyes',
        });
      }
    } catch (err) {
      logger.debug(
        { err, jid, channelId, messageTs, isTyping },
        'Reaction error',
      );
    }
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        // Parse thread-encoded JID: slack:<channel> or slack:<channel>:<thread_ts>
        const stripped = item.jid.replace(/^slack:/, '');
        const colonIdx = stripped.indexOf(':');
        const channelId =
          colonIdx === -1 ? stripped : stripped.slice(0, colonIdx);
        const threadTs =
          colonIdx === -1 ? undefined : stripped.slice(colonIdx + 1);
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});
