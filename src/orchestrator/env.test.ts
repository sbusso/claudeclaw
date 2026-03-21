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

  it('reads from MOTHERCLAW_ENV_FILE when set', async () => {
    const tmpEnv = path.join(process.env.TMPDIR || '/tmp', 'test-motherclaw.env');
    fs.writeFileSync(tmpEnv, 'TEST_KEY=from_env_file\n');
    process.env.MOTHERCLAW_ENV_FILE = tmpEnv;

    const { readEnvFile } = await import('./env.js');
    const result = readEnvFile(['TEST_KEY']);
    expect(result.TEST_KEY).toBe('from_env_file');

    fs.unlinkSync(tmpEnv);
  });

  it('reads from CLAUDE_PLUGIN_DATA/.env when set', async () => {
    const tmpDir = path.join(process.env.TMPDIR || '/tmp', 'test-plugin-data');
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.env'), 'TEST_KEY=from_plugin_data\n');
    process.env.CLAUDE_PLUGIN_DATA = tmpDir;

    const { readEnvFile } = await import('./env.js');
    const result = readEnvFile(['TEST_KEY']);
    expect(result.TEST_KEY).toBe('from_plugin_data');

    fs.rmSync(tmpDir, { recursive: true });
  });
});
