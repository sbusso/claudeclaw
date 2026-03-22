/**
 * MessageIngestion — single inbound entry point for all trigger sources.
 * Channels, webhooks, cron, and extensions all use ingest() to trigger agent runs.
 * Supports pre/post hooks for extensions.
 *
 * Note: Channel messages still flow through the polling loop for cursor management,
 * but the trigger-check + enqueue logic delegates to this service.
 * Webhooks and extensions call ingest() directly.
 */
import {
  IngestionEnvelope,
  IngestionPreHook,
  MessageIngestion,
  NewMessage,
} from './types.js';
import { storeMessage } from './db.js';
import { logger } from './logger.js';

export interface IngestionDeps {
  /** Check if a group requires trigger and whether the message has one */
  checkTrigger: (
    chatJid: string,
    sender: string,
  ) => { needsTrigger: boolean; hasTrigger: boolean };
  /** Enqueue a group for agent processing */
  enqueueMessageCheck: (chatJid: string) => void;
  /** Try to pipe formatted message to active container */
  sendToActive: (chatJid: string, formatted: string) => boolean;
}

export function createMessageIngestion(
  deps: IngestionDeps,
): MessageIngestion {
  const preHooks: IngestionPreHook[] = [];
  const postHooks: ((envelope: IngestionEnvelope) => void)[] = [];

  return {
    addPreHook(hook: IngestionPreHook): void {
      preHooks.push(hook);
    },

    addPostHook(hook: (envelope: IngestionEnvelope) => void): void {
      postHooks.push(hook);
    },

    async ingest(envelope: IngestionEnvelope): Promise<boolean> {
      let current = envelope;

      // Run pre-hooks sequentially
      for (const hook of preHooks) {
        try {
          const result = await hook(current);
          if (result.action === 'drop') {
            logger.debug(
              { groupFolder: current.groupFolder, reason: result.reason },
              'Ingestion dropped by pre-hook',
            );
            return false;
          }
          if (result.action === 'modify') {
            current = result.envelope;
          }
        } catch (err) {
          logger.error({ err }, 'Ingestion pre-hook error (continuing)');
        }
      }

      // Trigger check (skip for webhook, cron, or explicitly bypassed)
      if (!current.bypassTrigger) {
        const { needsTrigger, hasTrigger } = deps.checkTrigger(
          current.chatJid,
          current.sender,
        );
        if (needsTrigger && !hasTrigger) {
          logger.debug(
            { chatJid: current.chatJid },
            'No trigger found, message accumulated',
          );
          return false;
        }
      }

      // For non-channel triggers (webhook, extension), store the message
      if (current.triggerType !== 'channel') {
        const msgId = `${current.triggerType}-${Date.now()}`;
        storeMessage({
          id: msgId,
          chat_jid: current.chatJid,
          sender: current.sender,
          sender_name: current.senderName,
          content: current.prompt,
          timestamp: new Date().toISOString(),
        });
      }

      // Enqueue for agent processing
      deps.enqueueMessageCheck(current.chatJid);

      // Fire post-hooks (observe only)
      for (const hook of postHooks) {
        try {
          hook(current);
        } catch (err) {
          logger.error({ err }, 'Ingestion post-hook error');
        }
      }

      logger.info(
        {
          groupFolder: current.groupFolder,
          triggerType: current.triggerType,
          sender: current.sender,
        },
        'Message ingested',
      );
      return true;
    },
  };
}
