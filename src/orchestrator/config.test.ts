import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('config path resolution', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses CLAUDE_PLUGIN_DATA for STORE_DIR when set', async () => {
    process.env.CLAUDE_PLUGIN_DATA = '/tmp/test-plugin-data';
    const config = await import('./config.js');
    expect(config.STORE_DIR).toBe('/tmp/test-plugin-data/instances/default/store');
  });

  it('uses CLAUDE_PLUGIN_DATA for GROUPS_DIR when set', async () => {
    process.env.CLAUDE_PLUGIN_DATA = '/tmp/test-plugin-data';
    const config = await import('./config.js');
    expect(config.GROUPS_DIR).toBe('/tmp/test-plugin-data/instances/default/groups');
  });

  it('uses CLAUDE_PLUGIN_DATA for LOG_DIR when set', async () => {
    process.env.CLAUDE_PLUGIN_DATA = '/tmp/test-plugin-data';
    const config = await import('./config.js');
    expect(config.LOG_DIR).toBe('/tmp/test-plugin-data/instances/default/logs');
  });

  it('falls back to PROJECT_ROOT when CLAUDE_PLUGIN_DATA not set', async () => {
    delete process.env.CLAUDE_PLUGIN_DATA;
    const config = await import('./config.js');
    expect(config.GROUPS_DIR).toContain('groups');
    expect(config.STORE_DIR).toContain('store');
  });

  it('exports STATE_ROOT with instances/default path', async () => {
    process.env.CLAUDE_PLUGIN_DATA = '/tmp/test-plugin-data';
    const config = await import('./config.js');
    expect(config.STATE_ROOT).toBe('/tmp/test-plugin-data/instances/default');
  });

  it('uses MOTHERCLAW_INSTANCE env var for instance name', async () => {
    process.env.CLAUDE_PLUGIN_DATA = '/tmp/test-plugin-data';
    process.env.MOTHERCLAW_INSTANCE = 'work';
    const config = await import('./config.js');
    expect(config.STATE_ROOT).toBe('/tmp/test-plugin-data/instances/work');
  });

  it('reads default instance from instances.json', async () => {
    const pluginData = '/tmp/test-plugin-data';
    process.env.CLAUDE_PLUGIN_DATA = pluginData;
    delete process.env.MOTHERCLAW_INSTANCE;

    // Write a temporary instances.json
    const configPath = path.join(pluginData, 'instances.json');
    fs.mkdirSync(pluginData, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ default: 'personal' }));

    try {
      const config = await import('./config.js');
      expect(config.STATE_ROOT).toBe('/tmp/test-plugin-data/instances/personal');
    } finally {
      fs.unlinkSync(configPath);
    }
  });

  it('falls back to instances/default when no instances.json exists', async () => {
    process.env.CLAUDE_PLUGIN_DATA = '/tmp/test-plugin-data-no-json';
    delete process.env.MOTHERCLAW_INSTANCE;
    const config = await import('./config.js');
    expect(config.STATE_ROOT).toBe('/tmp/test-plugin-data-no-json/instances/default');
  });

  it('uses cwd as STATE_ROOT in developer mode (no CLAUDE_PLUGIN_DATA)', async () => {
    delete process.env.CLAUDE_PLUGIN_DATA;
    delete process.env.MOTHERCLAW_INSTANCE;
    const config = await import('./config.js');
    expect(config.STATE_ROOT).toBe(process.cwd());
  });
});
