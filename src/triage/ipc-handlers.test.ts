import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./queue-db.js', () => ({
  insertTask: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../env.js', () => ({
  readEnvFile: () => ({ TICKET_DEV_CHANNEL_JID: 'slack:CDEV' }),
}));

import { handleQueueSweTask, handleSetGithubIssue } from './ipc-handlers.js';
import { insertTask } from './queue-db.js';

const mockInsert = vi.mocked(insertTask);

describe('handleQueueSweTask', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts task from slack_ group', async () => {
    await handleQueueSweTask(
      {
        recordId: 'Rec123',
        listId: '',
        threadJid: 'slack:C1:t1',
        taskType: 'fix',
        description: 'Fix the bug',
      },
      'slack_nanodev_thread_123',
      false,
    );
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ record_id: 'Rec123', task_type: 'fix' }),
    );
  });

  it('rejects from unauthorized group', async () => {
    await handleQueueSweTask(
      {
        recordId: 'Rec123',
        threadJid: 'slack:C1:t1',
        taskType: 'fix',
        description: 'Fix',
      },
      'some_other_group',
      false,
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('allows from main group', async () => {
    await handleQueueSweTask(
      {
        recordId: 'Rec456',
        threadJid: 'slack:C1:t2',
        taskType: 'feature',
        description: 'Add thing',
      },
      'main',
      true,
    );
    expect(mockInsert).toHaveBeenCalled();
  });

  it('rejects with missing fields', async () => {
    await handleQueueSweTask(
      { recordId: 'Rec123' },
      'slack_nanodev_thread_123',
      false,
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe('handleSetGithubIssue', () => {
  beforeEach(() => vi.clearAllMocks());

  it('posts to dev channel', async () => {
    const deps = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    await handleSetGithubIssue(
      {
        githubIssueUrl: 'https://github.com/org/repo/issues/1',
        title: 'Bug: broken login',
        label: 'bug',
      },
      deps,
    );
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'slack:CDEV',
      expect.stringContaining('Bug: broken login'),
    );
  });

  it('rejects without URL', async () => {
    const deps = { sendMessage: vi.fn() };
    await handleSetGithubIssue({ title: 'no url' }, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });
});
