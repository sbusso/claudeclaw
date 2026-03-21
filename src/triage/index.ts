/**
 * Triage Extension for MotherClaw.
 * Provides: SWE task queue, GitHub issue integration, dev channel notifications.
 */
import { registerExtension } from '../orchestrator/extensions.js';
import { handleQueueSweTask, handleSetGithubIssue } from './ipc-handlers.js';
import { startSweQueueLoop } from './swe-queue.js';

registerExtension({
  name: 'triage',

  ipcHandlers: {
    queue_swe_task: (data, sourceGroup, isMain, _deps) =>
      handleQueueSweTask(data, sourceGroup, isMain),
    set_github_issue: (data, _sourceGroup, _isMain, deps) =>
      handleSetGithubIssue(data, deps),
  },

  onStartup: (deps) => {
    startSweQueueLoop({
      sendMessage: deps.sendMessage,
      runSweAgent: async (task) => {
        deps.logger.info(
          { taskId: task.id },
          'SWE agent placeholder — not yet implemented',
        );
        return {};
      },
    });
  },

  envKeys: ['TICKET_DEV_CHANNEL_JID', 'TICKET_SOURCE_REPO'],

  containerEnvKeys: ['GH_TOKEN'],

  dbSchema: [
    `CREATE TABLE IF NOT EXISTS swe_queue (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL,
      list_id TEXT NOT NULL,
      thread_jid TEXT NOT NULL,
      task_type TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      pr_url TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      timeout_at TEXT
    )`,
  ],
});
