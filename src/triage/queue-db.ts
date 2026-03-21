import { getDb } from '../orchestrator/db.js';

// --- Task Queue ---
// General-purpose sequential task queue backed by SQLite.
// Currently used for SWE (software engineering) tasks.

export interface QueuedTask {
  id: string;
  record_id: string;
  list_id: string;
  thread_jid: string;
  task_type: string;
  description: string;
  status?: string;
  pr_url?: string | null;
  created_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
  timeout_at?: string | null;
}

export function insertTask(task: QueuedTask): void {
  getDb()
    .prepare(
      `INSERT INTO swe_queue
        (id, record_id, list_id, thread_jid, task_type, description, status, pr_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      task.id,
      task.record_id,
      task.list_id,
      task.thread_jid,
      task.task_type,
      task.description,
      task.status ?? 'pending',
      task.pr_url ?? null,
    );
}

export function getNextPendingTask(): QueuedTask | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM swe_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`,
    )
    .get() as QueuedTask | undefined;
}

export function activateTask(id: string, timeoutMinutes = 30): void {
  getDb()
    .prepare(
      `UPDATE swe_queue
       SET status = 'active',
           started_at = datetime('now'),
           timeout_at = datetime('now', '+' || ? || ' minutes')
       WHERE id = ?`,
    )
    .run(timeoutMinutes, id);
}

export function completeTask(id: string, prUrl?: string): void {
  getDb()
    .prepare(
      `UPDATE swe_queue
       SET status = 'done',
           completed_at = datetime('now'),
           pr_url = COALESCE(?, pr_url)
       WHERE id = ?`,
    )
    .run(prUrl ?? null, id);
}

export function failTask(id: string): void {
  getDb()
    .prepare(
      `UPDATE swe_queue
       SET status = 'failed',
           completed_at = datetime('now')
       WHERE id = ?`,
    )
    .run(id);
}

export function getTimedOutTasks(): QueuedTask[] {
  return getDb()
    .prepare(
      `SELECT * FROM swe_queue WHERE status = 'active' AND timeout_at < datetime('now')`,
    )
    .all() as QueuedTask[];
}

export function hasActiveTask(): boolean {
  const row = getDb()
    .prepare(`SELECT COUNT(*) as count FROM swe_queue WHERE status = 'active'`)
    .get() as { count: number };
  return row.count > 0;
}
