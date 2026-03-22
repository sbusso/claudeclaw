import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('readEnvFile', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('reads from CLAUDECLAW_ENV_FILE when set', async () => {
    const tmpEnv = path.join(process.env.TMPDIR || '/tmp', 'test-claudeclaw.env');
    fs.writeFileSync(tmpEnv, 'TEST_KEY=from_env_file\n');
    process.env.CLAUDECLAW_ENV_FILE = tmpEnv;

    const { readEnvFile } = await import('./env.js');
    const result = readEnvFile(['TEST_KEY']);
    expect(result.TEST_KEY).toBe('from_env_file');

    fs.unlinkSync(tmpEnv);
  });

  it('reads from cwd/.env by default', async () => {
    delete process.env.CLAUDECLAW_ENV_FILE;

    const { readEnvFile } = await import('./env.js');
    // Should not throw even if .env doesn't exist — returns empty
    const result = readEnvFile(['NONEXISTENT_KEY']);
    expect(result).toEqual({});
  });
});
