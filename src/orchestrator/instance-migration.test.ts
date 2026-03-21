import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('migrateToInstances', () => {
  const tmpDir = path.join(process.env.TMPDIR || '/tmp', 'test-migration');

  beforeEach(() => {
    vi.resetModules();
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('moves existing state into instances/default/', async () => {
    fs.mkdirSync(path.join(tmpDir, 'store'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'store', 'messages.db'), 'test-db');
    fs.mkdirSync(path.join(tmpDir, 'groups', 'main'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'groups', 'main', 'CLAUDE.md'), 'memory');
    fs.writeFileSync(path.join(tmpDir, '.env'), 'TEST=1');

    const { migrateToInstances } = await import('./instance-migration.js');
    migrateToInstances(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, 'instances', 'default', 'store', 'messages.db'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'instances', 'default', 'groups', 'main', 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'instances', 'default', '.env'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'store'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'groups'))).toBe(false);

    const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'instances.json'), 'utf-8'));
    expect(config.default).toBe('default');
    expect(config.instances.default).toBeDefined();
  });

  it('does nothing if instances/ already exists', async () => {
    fs.mkdirSync(path.join(tmpDir, 'instances', 'work'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'instances.json'), '{"default":"work","instances":{}}');

    const { migrateToInstances } = await import('./instance-migration.js');
    migrateToInstances(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, 'instances', 'work'))).toBe(true);
  });

  it('does nothing if no legacy state exists', async () => {
    const { migrateToInstances } = await import('./instance-migration.js');
    migrateToInstances(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, 'instances'))).toBe(false);
  });
});
