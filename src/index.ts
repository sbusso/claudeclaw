/**
 * MotherClaw — Persistent agent orchestrator for Claude Code.
 *
 * This is the plugin entrypoint. It starts the message loop,
 * connects channels, and runs extensions.
 */

// Load channels (self-registering on import)
import './channels/slack.js';

// Load extensions (self-registering on import)
import './triage/index.js';

import { logger } from './orchestrator/logger.js';
import { ASSISTANT_NAME } from './orchestrator/config.js';
import { callExtensionStartup } from './orchestrator/extensions.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './orchestrator/channel-registry.js';
import type { Channel, ChannelOpts } from './orchestrator/types.js';

/**
 * Find which channel owns a JID.
 */
function findChannel(channels: Channel[], jid: string): Channel | undefined {
  return channels.find((ch) => ch.ownsJid(jid));
}

/**
 * Main — start the orchestrator.
 */
async function main(): Promise<void> {
  logger.info(`MotherClaw starting (assistant: ${ASSISTANT_NAME})`);

  // Create and connect channels
  const channels: Channel[] = [];
  const channelNames = getRegisteredChannelNames();

  const channelOpts: ChannelOpts = {
    onMessage: (chatJid, msg) => {
      logger.info(
        { chatJid, sender: msg.sender_name, content: msg.content.slice(0, 100) },
        'Message received',
      );
      // TODO: Wire to full message loop (store, trigger check, agent spawn)
    },
    onChatMetadata: (chatJid, timestamp, name, channel, isGroup) => {
      logger.debug({ chatJid, name, channel, isGroup }, 'Chat metadata');
    },
    registeredGroups: () => ({}), // TODO: Wire to DB
    registerGroup: (jid, group) => {
      logger.info({ jid, name: group.name }, 'Group registered');
    },
  };

  for (const name of channelNames) {
    const factory = getChannelFactory(name);
    if (!factory) continue;
    try {
      const channel = factory(channelOpts);
      if (channel) {
        await channel.connect();
        channels.push(channel);
        logger.info({ channel: name }, 'Channel connected');
      }
    } catch (err) {
      logger.error({ err, channel: name }, 'Failed to connect channel');
    }
  }

  // Start extensions
  callExtensionStartup({
    sendMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (channel) await channel.sendMessage(jid, text);
    },
    findChannel: (jid) => findChannel(channels, jid),
    logger,
  });

  logger.info(
    {
      channels: channels.map((ch) => ch.name),
      assistant: ASSISTANT_NAME,
    },
    'MotherClaw running',
  );

  // Keep alive
  process.on('SIGINT', async () => {
    logger.info('Shutting down...');
    for (const ch of channels) {
      await ch.disconnect();
    }
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Shutting down...');
    for (const ch of channels) {
      await ch.disconnect();
    }
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error');
  process.exit(1);
});
