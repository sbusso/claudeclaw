/**
 * Message loop — the heart of MotherClaw.
 *
 * Polls for new messages, checks triggers, manages threads,
 * and dispatches to Claude Code agents.
 */
import fs from 'fs';
import path from 'path';
import { getDb } from './db.js';
import {
  ASSISTANT_NAME,
  POLL_INTERVAL,
  IDLE_TIMEOUT,
  TRIGGER_PATTERN,
  GROUPS_DIR,
} from './config.js';
import { logger } from './logger.js';
import { GroupQueue } from './group-queue.js';
import type { Channel, NewMessage, RegisteredGroup } from './types.js';

// --- State ---

let lastTimestamp = '';
let lastAgentTimestamp: Record<string, string> = {};
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let messageLoopRunning = false;

let channelsRef: Channel[] = [];
const queue = new GroupQueue();

// --- DB helpers ---

function storeMessage(msg: NewMessage): void {
  getDb()
    .prepare(
      `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      msg.id,
      msg.chat_jid,
      msg.sender,
      msg.sender_name,
      msg.content,
      msg.timestamp,
      msg.is_from_me ? 1 : 0,
      msg.is_bot_message ? 1 : 0,
    );
}

function storeChatMetadata(
  jid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  getDb()
    .prepare(
      `INSERT INTO chats (jid, last_message_time, name, channel, is_group)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET
         last_message_time = MAX(last_message_time, excluded.last_message_time),
         name = COALESCE(excluded.name, name),
         channel = COALESCE(excluded.channel, channel),
         is_group = COALESCE(excluded.is_group, is_group)`,
    )
    .run(jid, timestamp, name || null, channel || null, isGroup ? 1 : 0);
}

function getNewMessages(
  jids: string[],
  sinceTimestamp: string,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: sinceTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  const rows = getDb()
    .prepare(
      `SELECT * FROM messages
       WHERE chat_jid IN (${placeholders})
         AND timestamp > ?
         AND is_bot_message = 0
       ORDER BY timestamp ASC`,
    )
    .all(...jids, sinceTimestamp) as any[];

  if (rows.length === 0) return { messages: [], newTimestamp: sinceTimestamp };

  const messages: NewMessage[] = rows.map((r) => ({
    id: r.id,
    chat_jid: r.chat_jid,
    sender: r.sender,
    sender_name: r.sender_name || r.sender,
    content: r.content,
    timestamp: r.timestamp,
    is_from_me: r.is_from_me === 1,
    is_bot_message: r.is_bot_message === 1,
  }));

  return {
    messages,
    newTimestamp: messages[messages.length - 1].timestamp,
  };
}

function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
): NewMessage[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM messages
       WHERE chat_jid = ?
         AND timestamp > ?
         AND is_bot_message = 0
       ORDER BY timestamp ASC`,
    )
    .all(chatJid, sinceTimestamp) as any[];

  return rows.map((r) => ({
    id: r.id,
    chat_jid: r.chat_jid,
    sender: r.sender,
    sender_name: r.sender_name || r.sender,
    content: r.content,
    timestamp: r.timestamp,
    is_from_me: r.is_from_me === 1,
    is_bot_message: r.is_bot_message === 1,
  }));
}

function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = getDb()
    .prepare('SELECT * FROM registered_groups')
    .all() as any[];
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger: row.requires_trigger === 1,
      isMain: row.is_main === 1 || undefined,
    };
  }
  return result;
}

function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO registered_groups
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      jid,
      group.name,
      group.folder,
      group.trigger,
      group.added_at,
      group.containerConfig ? JSON.stringify(group.containerConfig) : null,
      group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
      group.isMain ? 1 : 0,
    );
}

function getRouterState(key: string): string | undefined {
  const row = getDb()
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as any;
  return row?.value;
}

function setRouterState(key: string, value: string): void {
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
    )
    .run(key, value);
}

function getAllSessions(): Record<string, string> {
  const rows = getDb().prepare('SELECT * FROM sessions').all() as any[];
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Channel helper ---

function findChannel(jid: string): Channel | undefined {
  return channelsRef.find((ch) => ch.ownsJid(jid));
}

// --- Group registration ---

export function registerGroup(jid: string, group: RegisteredGroup): void {
  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md from parent group for thread groups
  const parentFolder = group.folder
    .replace(/_thread_.*$/, '')
    .replace(/_trigger$/, '');
  if (parentFolder !== group.folder) {
    const parentClaudeMd = path.join(GROUPS_DIR, parentFolder, 'CLAUDE.md');
    const targetClaudeMd = path.join(groupDir, 'CLAUDE.md');
    if (fs.existsSync(parentClaudeMd) && !fs.existsSync(targetClaudeMd)) {
      fs.copyFileSync(parentClaudeMd, targetClaudeMd);
    }
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);
  logger.info({ jid, name: group.name, folder: group.folder }, 'Group registered');
}

// --- State management ---

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info({ groupCount: Object.keys(registeredGroups).length }, 'State loaded');
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

// --- Format messages as XML for Claude ---

function formatMessages(messages: NewMessage[]): string {
  return messages
    .map(
      (m) =>
        `<message sender="${m.sender_name}" timestamp="${m.timestamp}">${m.content}</message>`,
    )
    .join('\n');
}

// --- Agent execution (placeholder — will use Claude Code sub-agents) ---

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput: (text: string) => Promise<void>,
): Promise<'success' | 'error'> {
  // TODO: Replace with Claude Code sub-agent invocation
  // For now, this is a placeholder that logs the prompt
  logger.info(
    { group: group.name, chatJid, promptLength: prompt.length },
    'Agent invocation (placeholder)',
  );

  // Placeholder response
  await onOutput(
    `[MotherClaw] Received your message. Agent execution not yet wired.`,
  );
  return 'success';
}

// --- Process messages for a group ---

async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID');
    return true;
  }

  const isMainGroup = group.isMain === true;
  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp);

  if (missedMessages.length === 0) return true;

  // Trigger check for non-main groups
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages);

  // Advance cursor
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Thread auto-creation for trigger-required channels
  const triggerMsg = missedMessages.find((m) =>
    TRIGGER_PATTERN.test(m.content.trim()),
  );
  const isChannelJid = !chatJid.includes(':', chatJid.indexOf(':') + 1);
  let replyJid = chatJid;

  if (isChannelJid && triggerMsg && group.requiresTrigger !== false) {
    const threadJid = `${chatJid}:${triggerMsg.id}`;
    const threadFolder = `${group.folder}_thread_${triggerMsg.id.replace('.', '_')}`;
    if (!registeredGroups[threadJid]) {
      registerGroup(threadJid, {
        name: `${group.name} (thread)`,
        folder: threadFolder,
        trigger: group.trigger,
        added_at: new Date().toISOString(),
        requiresTrigger: false,
        containerConfig: group.containerConfig,
      });
    }
    replyJid = threadJid;
  }

  // Typing indicator
  await channel.setTyping?.(replyJid, true);

  try {
    const result = await runAgent(
      registeredGroups[replyJid] || group,
      prompt,
      replyJid,
      async (text) => {
        await channel.sendMessage(replyJid, text);
      },
    );

    await channel.setTyping?.(replyJid, false);

    if (result === 'error') {
      lastAgentTimestamp[chatJid] = previousCursor;
      saveState();
      return false;
    }
    return true;
  } catch (err) {
    await channel.setTyping?.(replyJid, false);
    logger.error({ err, group: group.name }, 'Agent error');
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    return false;
  }
}

// --- The message loop ---

async function messageLoop(): Promise<void> {
  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(jids, lastTimestamp);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) existing.push(msg);
          else messagesByGroup.set(msg.chat_jid, [msg]);
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(chatJid);
          if (!channel) continue;

          const needsTrigger =
            group.isMain !== true && group.requiresTrigger !== false;

          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Try piping to active container first
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
          );
          const formatted = formatMessages(
            allPending.length > 0 ? allPending : groupMessages,
          );

          if (queue.sendMessage(chatJid, formatted)) {
            lastAgentTimestamp[chatJid] =
              (allPending.length > 0 ? allPending : groupMessages).slice(-1)[0]
                .timestamp;
            saveState();
            channel.setTyping?.(chatJid, true)?.catch(() => {});
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

// --- Public API ---

export interface MessageLoopOpts {
  channels: Channel[];
}

export function getRegisteredGroups(): Record<string, RegisteredGroup> {
  return registeredGroups;
}

export function onMessage(chatJid: string, msg: NewMessage): void {
  storeMessage(msg);
}

export function onChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  storeChatMetadata(chatJid, timestamp, name, channel, isGroup);
}

export function startMessageLoop(opts: MessageLoopOpts): void {
  if (messageLoopRunning) return;
  messageLoopRunning = true;
  channelsRef = opts.channels;

  loadState();

  // Wire the queue to process messages through our handler
  queue.setProcessMessagesFn(processGroupMessages);

  logger.info(`MotherClaw running (trigger: @${ASSISTANT_NAME})`);
  messageLoop();
}
