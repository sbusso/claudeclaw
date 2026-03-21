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

  it('reads from CLAUDE_PLUGIN_DATA/instances/default/.env when set', async () => {
    const tmpDir = path.join(process.env.TMPDIR || '/tmp', 'test-plugin-data-env');
    const instanceDir = path.join(tmpDir, 'instances', 'default');
    fs.mkdirSync(instanceDir, { recursive: true });
    fs.writeFileSync(path.join(instanceDir, '.env'), 'TEST_KEY=from_plugin_data\n');
    process.env.CLAUDE_PLUGIN_DATA = tmpDir;
    delete process.env.MOTHERCLAW_INSTANCE;

    const { readEnvFile } = await import('./env.js');
    const result = readEnvFile(['TEST_KEY']);
    expect(result.TEST_KEY).toBe('from_plugin_data');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('reads from instances.json default when MOTHERCLAW_INSTANCE not set', async () => {
    const tmpDir = path.join(process.env.TMPDIR || '/tmp', 'test-plugin-data-json');
    fs.mkdirSync(path.join(tmpDir, 'instances', 'personal'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'instances', 'personal', '.env'), 'TEST_KEY=from_personal\n');
    fs.writeFileSync(path.join(tmpDir, 'instances.json'), JSON.stringify({ default: 'personal', instances: {} }));
    process.env.CLAUDE_PLUGIN_DATA = tmpDir;
    delete process.env.MOTHERCLAW_INSTANCE;

    const { readEnvFile } = await import('./env.js');
    const result = readEnvFile(['TEST_KEY']);
    expect(result.TEST_KEY).toBe('from_personal');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('reads from named instance .env when MOTHERCLAW_INSTANCE set', async () => {
    const tmpDir = path.join(process.env.TMPDIR || '/tmp', 'test-plugin-data-inst');
    const instanceDir = path.join(tmpDir, 'instances', 'work');
    fs.mkdirSync(instanceDir, { recursive: true });
    fs.writeFileSync(path.join(instanceDir, '.env'), 'TEST_KEY=from_work_instance\n');
    process.env.CLAUDE_PLUGIN_DATA = tmpDir;
    process.env.MOTHERCLAW_INSTANCE = 'work';

    const { readEnvFile } = await import('./env.js');
    const result = readEnvFile(['TEST_KEY']);
    expect(result.TEST_KEY).toBe('from_work_instance');

    fs.rmSync(tmpDir, { recursive: true });
  });
});
