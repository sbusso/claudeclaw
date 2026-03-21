import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import http from 'http';
import { verifySignature, startWebhookServer } from './server.js';

describe('verifySignature', () => {
  const secret = 'test-secret-key';
  const payload = JSON.stringify({ prompt: 'hello' });

  it('accepts valid HMAC signature', () => {
    const signature = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');
    expect(verifySignature(secret, payload, signature)).toBe(true);
  });

  it('rejects invalid HMAC signature', () => {
    const badSignature = crypto
      .createHmac('sha256', 'wrong-secret')
      .update(payload)
      .digest('hex');
    expect(verifySignature(secret, payload, badSignature)).toBe(false);
  });

  it('rejects malformed signature', () => {
    expect(verifySignature(secret, payload, 'not-hex-at-all!!')).toBe(false);
  });

  it('rejects empty signature', () => {
    expect(verifySignature(secret, payload, '')).toBe(false);
  });
});

describe('webhook server HTTP', () => {
  const secret = 'webhook-test-secret';

  function sign(payload: string): string {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
  }

  function makeRequest(
    port: number,
    method: string,
    urlPath: string,
    body?: string,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: urlPath, method, headers },
        (res) => {
          let data = '';
          res.on('data', (chunk: string) => { data += chunk; });
          res.on('end', () => {
            resolve({ status: res.statusCode!, body: JSON.parse(data) });
          });
        },
      );
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  let server: http.Server;
  let port: number;
  const enqueuedWebhooks: Array<{ jid: string; prompt: string }> = [];

  beforeEach(async () => {
    enqueuedWebhooks.length = 0;

    server = startWebhookServer(0, secret, {
      sendMessage: vi.fn(),
      findGroupByFolder: (folder) => {
        if (folder === 'test-group') return { jid: 'test-jid@g.us', name: 'Test Group' };
        return undefined;
      },
      enqueueWebhook: (jid, prompt) => {
        enqueuedWebhooks.push({ jid, prompt });
      },
    });

    // Wait for server to start and get the assigned port
    await new Promise<void>((resolve) => {
      server.on('listening', () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterEach(() => {
    server.close();
  });

  it('responds to health check', async () => {
    const res = await makeRequest(port, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('returns 404 for missing group folder', async () => {
    const body = JSON.stringify({ prompt: 'test' });
    const res = await makeRequest(port, 'POST', '/webhook/nonexistent', body, {
      'x-signature': sign(body),
      'content-type': 'application/json',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Group not found');
  });

  it('returns 401 for invalid signature', async () => {
    const body = JSON.stringify({ prompt: 'test' });
    const res = await makeRequest(port, 'POST', '/webhook/test-group', body, {
      'x-signature': 'badsignature00000000000000000000000000000000000000000000000000000',
      'content-type': 'application/json',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid signature');
  });

  it('accepts valid webhook and enqueues', async () => {
    const body = JSON.stringify({ prompt: 'run report' });
    const res = await makeRequest(port, 'POST', '/webhook/test-group', body, {
      'x-signature': sign(body),
      'content-type': 'application/json',
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');
    expect(res.body.group).toBe('Test Group');
    expect(enqueuedWebhooks).toHaveLength(1);
    expect(enqueuedWebhooks[0].jid).toBe('test-jid@g.us');
    expect(enqueuedWebhooks[0].prompt).toBe('run report');
  });

  it('returns 404 for non-POST non-GET requests', async () => {
    const res = await makeRequest(port, 'PUT', '/webhook/test-group');
    expect(res.status).toBe(404);
  });
});
