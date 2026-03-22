import { createServer, IncomingMessage, ServerResponse } from 'http';
import crypto from 'crypto';
import { logger } from '../orchestrator/logger.js';
import type { MessageIngestion } from '../orchestrator/types.js';

export interface WebhookDeps {
  ingestion: MessageIngestion;
  findGroupByFolder: (folder: string) => { jid: string; name: string } | undefined;
}

// Rate limiting: per-group request counter
const requestCounts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10; // requests per minute
const RATE_WINDOW = 60_000;

function checkRateLimit(groupFolder: string): boolean {
  const now = Date.now();
  const entry = requestCounts.get(groupFolder);
  if (!entry || now > entry.resetAt) {
    requestCounts.set(groupFolder, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

export function verifySignature(secret: string, payload: string, signature: string): boolean {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex'),
    );
  } catch {
    return false;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: string) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function startWebhookServer(
  port: number,
  secret: string,
  deps: WebhookDeps,
): ReturnType<typeof createServer> {
  const server = createServer(async (req, res) => {
    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    // Only accept POST /webhook/:groupFolder
    if (req.method !== 'POST' || !req.url?.startsWith('/webhook/')) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    const groupFolder = req.url.slice('/webhook/'.length).split('?')[0];
    if (!groupFolder) {
      sendJson(res, 400, { error: 'Missing group folder' });
      return;
    }

    // Rate limit
    if (!checkRateLimit(groupFolder)) {
      sendJson(res, 429, { error: 'Rate limit exceeded' });
      return;
    }

    // Read body
    const body = await readBody(req);

    // Verify HMAC signature
    const signature = req.headers['x-signature'] as string;
    if (!signature || !verifySignature(secret, body, signature)) {
      sendJson(res, 401, { error: 'Invalid signature' });
      return;
    }

    // Lookup group
    const group = deps.findGroupByFolder(groupFolder);
    if (!group) {
      sendJson(res, 404, { error: 'Group not found' });
      return;
    }

    // Parse payload
    let payload: { prompt?: string; [key: string]: unknown };
    try {
      payload = JSON.parse(body);
    } catch {
      payload = { prompt: body };
    }

    const prompt = payload.prompt || JSON.stringify(payload);

    // Ingest via the routing service
    const accepted = await deps.ingestion.ingest({
      groupFolder,
      chatJid: group.jid,
      sender: 'webhook',
      senderName: 'Webhook',
      triggerType: 'webhook',
      prompt,
      bypassTrigger: true,
    });

    if (accepted) {
      logger.info({ groupFolder, jid: group.jid }, 'Webhook triggered');
      sendJson(res, 200, { status: 'accepted', group: group.name });
    } else {
      sendJson(res, 200, { status: 'dropped', group: group.name });
    }
  });

  server.listen(port, () => {
    logger.info({ port }, 'Webhook server listening');
  });

  return server;
}
