import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./queue-db.js', () => ({
  getNextPendingTask: vi.fn(),
  activateTask: vi.fn(),
  completeTask: vi.fn(),
  failTask: vi.fn(),
  getTimedOutTasks: vi.fn(),
  hasActiveTask: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { processSweQueue } from './swe-queue.js';
import type { SweDeps } from './swe-queue.js';
import {
  getNextPendingTask,
  activateTask,
  completeTask,
  failTask,
  getTimedOutTasks,
  hasActiveTask,
} from './queue-db.js';
import type { QueuedTask } from './queue-db.js';

const mockGetNext = vi.mocked(getNextPendingTask);
const mockActivate = vi.mocked(activateTask);
const mockComplete = vi.mocked(completeTask);
const mockFail = vi.mocked(failTask);
const mockTimedOut = vi.mocked(getTimedOutTasks);
const mockHasActive = vi.mocked(hasActiveTask);

const pendingTask: QueuedTask = {
  id: 'task-001',
  record_id: 'rec_abc',
  list_id: 'lst_123',
  thread_jid: 'C1234@slack',
  task_type: 'fix',
  description: 'Fix the login bug',
  status: 'pending',
};

function makeDeps(overrides: Partial<SweDeps> = {}): SweDeps {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    runSweAgent: vi
      .fn()
      .mockResolvedValue({ prUrl: 'https://github.com/org/repo/pull/42' }),
    ...overrides,
  };
}

describe('processSweQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTimedOut.mockReturnValue([]);
    mockHasActive.mockReturnValue(false);
    mockGetNext.mockReturnValue(undefined);
  });

  it('picks up a pending task and activates it', async () => {
    mockGetNext.mockReturnValue(pendingTask);
    const deps = makeDeps();
    await processSweQueue(deps);

    expect(mockActivate).toHaveBeenCalledWith('task-001', 30);
    expect(deps.runSweAgent).toHaveBeenCalled();
  });

  it('skips if an active task exists', async () => {
    mockHasActive.mockReturnValue(true);
    const deps = makeDeps();
    await processSweQueue(deps);

    expect(mockGetNext).not.toHaveBeenCalled();
  });

  it('fails timed-out tasks first', async () => {
    mockTimedOut.mockReturnValue([
      { ...pendingTask, id: 'expired', status: 'active' },
    ]);
    mockGetNext.mockReturnValue(pendingTask);
    const deps = makeDeps();
    await processSweQueue(deps);

    expect(mockFail).toHaveBeenCalledWith('expired');
    expect(mockActivate).toHaveBeenCalledWith('task-001', 30);
  });

  it('completes task on success', async () => {
    mockGetNext.mockReturnValue(pendingTask);
    const deps = makeDeps();
    await processSweQueue(deps);

    expect(mockComplete).toHaveBeenCalledWith(
      'task-001',
      'https://github.com/org/repo/pull/42',
    );
  });

  it('fails task on agent error', async () => {
    mockGetNext.mockReturnValue(pendingTask);
    const deps = makeDeps({
      runSweAgent: vi.fn().mockRejectedValue(new Error('crashed')),
    });
    await processSweQueue(deps);

    expect(mockFail).toHaveBeenCalledWith('task-001');
  });
});
