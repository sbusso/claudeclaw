/**
 * MotherClaw — Persistent agent orchestrator for Claude Code.
 */

// Load channels (self-registering on import)
import './channels/slack.js';

// Load extensions (self-registering on import)
import './triage/index.js';

import { logger } from './orchestrator/logger.js';
import { ASSISTANT_NAME } from './orchestrator/config.js';
import { initDatabase } from './orchestrator/db.js';
import { getExtensionDbSchema, callExtensionStartup } from './orchestrator/extensions.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './orchestrator/channel-registry.js';
import {
  startMessageLoop,
  onMessage,
  onChatMetadata,
  getRegisteredGroups,
  registerGroup,
} from './orchestrator/message-loop.js';
import type { Channel } from './orchestrator/types.js';

function findChannel(channels: Channel[], jid: string): Channel | undefined {
  return channels.find((ch) => ch.ownsJid(jid));
}

async function main(): Promise<void> {
  logger.info(`MotherClaw starting (assistant: ${ASSISTANT_NAME})`);

  // Initialize database with extension schemas
  initDatabase(getExtensionDbSchema());
  logger.info('Database initialized');

  // Connect channels
  const channels: Channel[] = [];
  const channelNames = getRegisteredChannelNames();

  for (const name of channelNames) {
    const factory = getChannelFactory(name);
    if (!factory) continue;
    try {
      const channel = factory({
        onMessage,
        onChatMetadata,
        registeredGroups: getRegisteredGroups,
        registerGroup,
      });
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

  // Start the message loop
  startMessageLoop({ channels });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    for (const ch of channels) {
      await ch.disconnect();
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error');
  process.exit(1);
});
