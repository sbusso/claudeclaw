/**
 * Triage-specific IPC handlers.
 * Called from the main IPC processor for triage-related message types.
 */
import { logger } from '../orchestrator/logger.js';

export interface TriageIpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
}

/**
 * Handle queue_swe_task IPC message.
 * Queues a coding task for the SWE agent.
 */
export async function handleQueueSweTask(
  data: any,
  sourceGroup: string,
  isMain: boolean,
): Promise<void> {
  if (!sourceGroup.startsWith('slack_') && !isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized queue_swe_task');
    return;
  }

  const { recordId, listId, threadJid, taskType, description } = data;
  if (!recordId || !threadJid || !taskType || !description) {
    logger.warn({ data }, 'queue_swe_task missing required fields');
    return;
  }

  const { insertTask } = await import('./queue-db.js');
  const taskId = `swe-${recordId}-${Date.now()}`;
  insertTask({
    id: taskId,
    record_id: recordId,
    list_id: listId || '',
    thread_jid: threadJid,
    task_type: taskType,
    description,
  });

  logger.info({ taskId, recordId, taskType }, 'SWE task queued via IPC');
}

/**
 * Handle set_github_issue IPC message.
 * Posts the GitHub issue link to the dev channel.
 */
export async function handleSetGithubIssue(
  data: any,
  deps: TriageIpcDeps,
): Promise<void> {
  const { githubIssueUrl, title, label } = data;
  if (!githubIssueUrl) {
    logger.warn({ data }, 'set_github_issue missing githubIssueUrl');
    return;
  }

  const { readEnvFile } = await import('../orchestrator/env.js');
  const TICKET_DEV_CHANNEL_JID =
    readEnvFile(['TICKET_DEV_CHANNEL_JID']).TICKET_DEV_CHANNEL_JID || '';
  if (TICKET_DEV_CHANNEL_JID) {
    const labelEmoji = label === 'bug' ? '🐛' : '✨';
    await deps.sendMessage(
      TICKET_DEV_CHANNEL_JID,
      `${labelEmoji} *${title || 'New issue'}*\n${githubIssueUrl}`,
    );
  }

  logger.info(
    { githubIssueUrl },
    'GitHub issue created, posted to dev channel',
  );
}
