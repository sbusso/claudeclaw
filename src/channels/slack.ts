/**
 * Slack channel for MotherClaw.
 * Socket Mode connection, thread-encoded JIDs, reaction-based typing indicator.
 */
import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../orchestrator/config.js';
import { readEnvFile } from '../orchestrator/env.js';
import { logger } from '../orchestrator/logger.js';
import { registerChannel } from '../orchestrator/channel-registry.js';
import type { ChannelOpts } from '../orchestrator/channel-registry.js';
import type {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../orchestrator/types.js';

const MAX_MESSAGE_LENGTH = 4000;

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
  private lastMessageTs = new Map<string, string>();

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

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
      if (subtype === 'list_record_comment') return;
      if (subtype && subtype !== 'bot_message') return;

      const msg = event as HandledMessageEvent;
      if (!msg.text) return;

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Thread-encoded JID routing
      const threadTs = (msg as any).thread_ts as string | undefined;
      const threadJid = threadTs ? `slack:${msg.channel}:${threadTs}` : null;
      const groups = this.opts.registeredGroups();
      const effectiveJid = threadJid && groups[threadJid] ? threadJid : jid;

      const isDM = msg.channel_type === 'im';
      if (!isDM && !groups[effectiveJid]) return;

      // Auto-register DMs
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
        logger.info({ jid: effectiveJid, folder: folderName }, 'Auto-registered Slack DM');
      }

      // Only our bot is "from me"
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

      // Translate <@UBOTID> mentions to trigger format
      let content = msg.text;
      if (this.botUserId && !isBotMessage) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (content.includes(mentionPattern) && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

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
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      this.botId = auth.bot_id as string | undefined;
      logger.info({ botUserId: this.botUserId, botId: this.botId }, 'Connected to Slack');
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }
    this.connected = true;
    await this.flushOutgoingQueue();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const stripped = jid.replace(/^slack:/, '');
    const colonIdx = stripped.indexOf(':');
    const channelId = colonIdx === -1 ? stripped : stripped.slice(0, colonIdx);
    const threadTs = colonIdx === -1 ? undefined : stripped.slice(colonIdx + 1);

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      return;
    }

    try {
      const baseOpts = { channel: channelId, ...(threadTs ? { thread_ts: threadTs } : {}) };
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.app.client.chat.postMessage({ ...baseOpts, text });
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({
            ...baseOpts,
            text: text.slice(i, i + MAX_MESSAGE_LENGTH),
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn({ jid, err }, 'Failed to send Slack message, queued');
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

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const messageTs = this.lastMessageTs.get(jid);
    if (!messageTs) return;

    const stripped = jid.replace(/^slack:/, '');
    const colonIdx = stripped.indexOf(':');
    const channelId = colonIdx === -1 ? stripped : stripped.slice(0, colonIdx);

    try {
      if (isTyping) {
        await this.app.client.reactions.add({ channel: channelId, timestamp: messageTs, name: 'eyes' });
      } else {
        await this.app.client.reactions.remove({ channel: channelId, timestamp: messageTs, name: 'eyes' });
      }
    } catch (err) {
      logger.debug({ err, jid, isTyping }, 'Reaction error');
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
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const stripped = item.jid.replace(/^slack:/, '');
        const colonIdx = stripped.indexOf(':');
        const channelId = colonIdx === -1 ? stripped : stripped.slice(0, colonIdx);
        const threadTs = colonIdx === -1 ? undefined : stripped.slice(colonIdx + 1);
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        });
      }
    } finally {
      this.flushing = false;
    }
  }
}

// Self-register
registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});
