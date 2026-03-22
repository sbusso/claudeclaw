import { describe, it, expect, vi } from 'vitest';

// Mock db.ts before importing ingestion
vi.mock('./db.js', () => ({
  storeMessage: vi.fn(),
}));

import { createMessageIngestion, IngestionDeps } from './ingestion.js';
import type { IngestionEnvelope } from './types.js';

function mockDeps(overrides?: Partial<IngestionDeps>): IngestionDeps {
  return {
    checkTrigger: vi.fn(() => ({ needsTrigger: false, hasTrigger: true })),
    enqueueMessageCheck: vi.fn(),
    sendToActive: vi.fn(() => false),
    ...overrides,
  };
}

function webhookEnvelope(overrides?: Partial<IngestionEnvelope>): IngestionEnvelope {
  return {
    groupFolder: 'test-group',
    chatJid: 'test-jid@g.us',
    sender: 'webhook',
    senderName: 'Webhook',
    triggerType: 'webhook',
    prompt: 'run report',
    bypassTrigger: true,
    ...overrides,
  };
}

describe('MessageIngestion', () => {
  it('ingests webhook and enqueues', async () => {
    const deps = mockDeps();
    const ingestion = createMessageIngestion(deps);

    const result = await ingestion.ingest(webhookEnvelope());

    expect(result).toBe(true);
    expect(deps.enqueueMessageCheck).toHaveBeenCalledWith('test-jid@g.us');
  });

  it('bypassTrigger skips trigger check', async () => {
    const deps = mockDeps({
      checkTrigger: vi.fn(() => ({ needsTrigger: true, hasTrigger: false })),
    });
    const ingestion = createMessageIngestion(deps);

    const result = await ingestion.ingest(webhookEnvelope({ bypassTrigger: true }));

    expect(result).toBe(true);
    expect(deps.checkTrigger).not.toHaveBeenCalled();
  });

  it('respects trigger check when bypassTrigger is false', async () => {
    const deps = mockDeps({
      checkTrigger: vi.fn(() => ({ needsTrigger: true, hasTrigger: false })),
    });
    const ingestion = createMessageIngestion(deps);

    const result = await ingestion.ingest(
      webhookEnvelope({ bypassTrigger: false, triggerType: 'channel' }),
    );

    expect(result).toBe(false);
    expect(deps.enqueueMessageCheck).not.toHaveBeenCalled();
  });

  it('pre-hook can drop message', async () => {
    const deps = mockDeps();
    const ingestion = createMessageIngestion(deps);

    ingestion.addPreHook(async () => ({ action: 'drop' as const, reason: 'blocked' }));

    const result = await ingestion.ingest(webhookEnvelope());

    expect(result).toBe(false);
    expect(deps.enqueueMessageCheck).not.toHaveBeenCalled();
  });

  it('pre-hook can modify envelope', async () => {
    const deps = mockDeps();
    const ingestion = createMessageIngestion(deps);

    ingestion.addPreHook(async (env) => ({
      action: 'modify' as const,
      envelope: { ...env, prompt: 'modified prompt' },
    }));

    const result = await ingestion.ingest(webhookEnvelope());

    expect(result).toBe(true);
    expect(deps.enqueueMessageCheck).toHaveBeenCalled();
  });

  it('post-hook fires after successful ingestion', async () => {
    const deps = mockDeps();
    const ingestion = createMessageIngestion(deps);
    const postHook = vi.fn();

    ingestion.addPostHook(postHook);

    await ingestion.ingest(webhookEnvelope());

    expect(postHook).toHaveBeenCalledWith(
      expect.objectContaining({ triggerType: 'webhook' }),
    );
  });

  it('post-hook does NOT fire when dropped by pre-hook', async () => {
    const deps = mockDeps();
    const ingestion = createMessageIngestion(deps);
    const postHook = vi.fn();

    ingestion.addPreHook(async () => ({ action: 'drop' as const }));
    ingestion.addPostHook(postHook);

    await ingestion.ingest(webhookEnvelope());

    expect(postHook).not.toHaveBeenCalled();
  });

  it('pre-hooks run in order, later hooks see modified envelope', async () => {
    const deps = mockDeps();
    const ingestion = createMessageIngestion(deps);
    const seen: string[] = [];

    ingestion.addPreHook(async (env) => {
      seen.push(env.prompt);
      return {
        action: 'modify' as const,
        envelope: { ...env, prompt: 'first-modified' },
      };
    });

    ingestion.addPreHook(async (env) => {
      seen.push(env.prompt);
      return { action: 'continue' as const };
    });

    await ingestion.ingest(webhookEnvelope({ prompt: 'original' }));

    expect(seen).toEqual(['original', 'first-modified']);
  });
});
