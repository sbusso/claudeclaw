import { describe, it, expect, vi } from 'vitest';
import { createMessageRouter } from './outbound-router.js';
import type { Channel, OutboundEnvelope } from './types.js';

function mockChannel(name: string, jidPrefix: string): Channel {
  return {
    name,
    connect: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    isConnected: () => true,
    ownsJid: (jid: string) => jid.startsWith(jidPrefix),
    disconnect: vi.fn(),
  };
}

describe('MessageRouter', () => {
  it('routes message to correct channel', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);

    await router.route({
      chatJid: 'C123',
      text: 'hello',
      triggerType: 'agent-response',
    });

    expect(slack.sendMessage).toHaveBeenCalledWith('C123', 'hello');
  });

  it('strips internal tags from text', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);

    await router.route({
      chatJid: 'C123',
      text: 'visible <internal>hidden</internal> text',
      triggerType: 'agent-response',
    });

    expect(slack.sendMessage).toHaveBeenCalledWith('C123', 'visible  text');
  });

  it('does not deliver empty text after formatting', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);

    await router.route({
      chatJid: 'C123',
      text: '<internal>only internal</internal>',
      triggerType: 'agent-response',
    });

    expect(slack.sendMessage).not.toHaveBeenCalled();
  });

  it('send() convenience method works', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);

    await router.send('C123', 'hello');

    expect(slack.sendMessage).toHaveBeenCalledWith('C123', 'hello');
  });

  it('pre-hook can drop message', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);

    router.addPreHook(async () => ({ action: 'drop' as const, reason: 'blocked' }));

    await router.route({
      chatJid: 'C123',
      text: 'hello',
      triggerType: 'agent-response',
    });

    expect(slack.sendMessage).not.toHaveBeenCalled();
  });

  it('pre-hook can modify envelope', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);

    router.addPreHook(async (envelope) => ({
      action: 'modify' as const,
      envelope: { ...envelope, text: envelope.text + ' [modified]' },
    }));

    await router.route({
      chatJid: 'C123',
      text: 'hello',
      triggerType: 'agent-response',
    });

    expect(slack.sendMessage).toHaveBeenCalledWith('C123', 'hello [modified]');
  });

  it('post-hook receives envelope after delivery', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);
    const postHook = vi.fn();

    router.addPostHook(postHook);

    await router.route({
      chatJid: 'C123',
      text: 'hello',
      triggerType: 'agent-response',
    });

    expect(postHook).toHaveBeenCalledWith(
      expect.objectContaining({ chatJid: 'C123', text: 'hello' }),
    );
  });

  it('warns when no channel owns the JID', async () => {
    const slack = mockChannel('slack', 'C');
    const router = createMessageRouter([slack]);

    // Should not throw, just warn
    await router.route({
      chatJid: 'unknown-jid',
      text: 'hello',
      triggerType: 'agent-response',
    });

    expect(slack.sendMessage).not.toHaveBeenCalled();
  });
});
