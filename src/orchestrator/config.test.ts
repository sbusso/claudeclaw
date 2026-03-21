import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
    expect(config.STORE_DIR).toBe('/tmp/test-plugin-data/store');
  });

  it('uses CLAUDE_PLUGIN_DATA for GROUPS_DIR when set', async () => {
    process.env.CLAUDE_PLUGIN_DATA = '/tmp/test-plugin-data';
    const config = await import('./config.js');
    expect(config.GROUPS_DIR).toBe('/tmp/test-plugin-data/groups');
  });

  it('uses CLAUDE_PLUGIN_DATA for LOG_DIR when set', async () => {
    process.env.CLAUDE_PLUGIN_DATA = '/tmp/test-plugin-data';
    const config = await import('./config.js');
    expect(config.LOG_DIR).toBe('/tmp/test-plugin-data/logs');
  });

  it('falls back to PROJECT_ROOT when CLAUDE_PLUGIN_DATA not set', async () => {
    delete process.env.CLAUDE_PLUGIN_DATA;
    const config = await import('./config.js');
    expect(config.GROUPS_DIR).toContain('groups');
    expect(config.STORE_DIR).toContain('store');
  });

  it('exports STATE_ROOT', async () => {
    process.env.CLAUDE_PLUGIN_DATA = '/tmp/test-plugin-data';
    const config = await import('./config.js');
    expect(config.STATE_ROOT).toBe('/tmp/test-plugin-data');
  });
});
