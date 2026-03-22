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

  it('uses cwd as STATE_ROOT', async () => {
    const config = await import('./config.js');
    expect(config.STATE_ROOT).toBe(process.cwd());
  });

  it('derives STORE_DIR from STATE_ROOT', async () => {
    const config = await import('./config.js');
    expect(config.STORE_DIR).toContain('store');
  });

  it('derives GROUPS_DIR from STATE_ROOT', async () => {
    const config = await import('./config.js');
    expect(config.GROUPS_DIR).toContain('groups');
  });

  it('derives LOG_DIR from STATE_ROOT', async () => {
    const config = await import('./config.js');
    expect(config.LOG_DIR).toContain('logs');
  });

  it('derives DATA_DIR from STATE_ROOT', async () => {
    const config = await import('./config.js');
    expect(config.DATA_DIR).toContain('data');
    expect(config.DATA_DIR).toBe(require('path').resolve(process.cwd(), 'data'));
  });
});
