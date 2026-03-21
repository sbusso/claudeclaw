import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger before any imports that use it
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process
const mockExecFileSync = vi.fn();
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
    spawn: vi.fn(),
  };
});

// Mock group-folder
vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) => `/tmp/test-groups/${folder}`,
  resolveGroupIpcPath: (folder: string) => `/tmp/test-ipc/${folder}`,
}));

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn().mockReturnValue([]),
}));

import {
  buildSandboxArgs,
  buildSandboxSettings,
  ensureSandboxRuntimeAvailable,
  cleanupSandboxOrphans,
} from './sandbox-runner.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ensureSandboxRuntimeAvailable', () => {
  it('verifies sandbox-runtime is installed', () => {
    mockExecFileSync.mockReturnValueOnce('1.0.0');
    ensureSandboxRuntimeAvailable();
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'npx',
      ['@anthropic-ai/sandbox-runtime', '--version'],
      expect.any(Object),
    );
  });

  it('throws if sandbox-runtime not found', () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('not found');
    });
    expect(() => ensureSandboxRuntimeAvailable()).toThrow(
      'sandbox-runtime is required but not installed',
    );
  });
});

describe('buildSandboxSettings', () => {
  it('puts readonly mounts in allowRead and denyWrite', () => {
    const settings = buildSandboxSettings([
      {
        hostPath: '/host/project',
        containerPath: '/workspace/project',
        readonly: true,
      },
    ]);
    expect(settings.filesystem.allowRead).toContain('/host/project');
    expect(settings.filesystem.allowWrite).not.toContain('/host/project');
    expect(settings.filesystem.denyWrite).toContain('/host/project');
  });

  it('puts writable mounts in allowWrite', () => {
    const settings = buildSandboxSettings([
      {
        hostPath: '/host/group',
        containerPath: '/workspace/group',
        readonly: false,
      },
    ]);
    expect(settings.filesystem.allowWrite).toContain('/host/group');
  });

  it('puts deny mounts in both denyRead and denyWrite', () => {
    const settings = buildSandboxSettings([
      {
        hostPath: '/host/project/.env',
        containerPath: '/workspace/project/.env',
        readonly: true,
        deny: true,
      },
    ]);
    expect(settings.filesystem.denyRead).toContain('/host/project/.env');
    expect(settings.filesystem.denyWrite).toContain('/host/project/.env');
  });

  it('allows Anthropic API and localhost for IPC', () => {
    const settings = buildSandboxSettings([]);
    expect(settings.network.allowedDomains).toContain('api.anthropic.com');
    expect(settings.network.allowedDomains).toContain('*.anthropic.com');
    expect(settings.network.allowedDomains).toContain('localhost');
    expect(settings.network.allowedDomains).toContain('127.0.0.1');
    expect(settings.network.allowLocalBinding).toBe(true);
  });

  it('has required deniedDomains field (even if empty)', () => {
    const settings = buildSandboxSettings([]);
    expect(settings.network.deniedDomains).toEqual([]);
  });

  it('includes allowRead in filesystem (required by srt schema, even if empty)', () => {
    const settings = buildSandboxSettings([]);
    expect(settings.filesystem).toHaveProperty('allowRead');
    expect(settings.filesystem.allowRead).toEqual([]);
  });

  it('includes all required filesystem fields', () => {
    const settings = buildSandboxSettings([]);
    expect(settings.filesystem).toHaveProperty('denyRead');
    expect(settings.filesystem).toHaveProperty('allowRead');
    expect(settings.filesystem).toHaveProperty('allowWrite');
    expect(settings.filesystem).toHaveProperty('denyWrite');
  });

  it('handles multiple mounts of different types', () => {
    const settings = buildSandboxSettings([
      {
        hostPath: '/host/project',
        containerPath: '/workspace/project',
        readonly: true,
      },
      {
        hostPath: '/host/project/.env',
        containerPath: '/workspace/project/.env',
        readonly: true,
        deny: true,
      },
      {
        hostPath: '/host/group',
        containerPath: '/workspace/group',
        readonly: false,
      },
    ]);
    expect(settings.filesystem.allowRead).toContain('/host/project');
    expect(settings.filesystem.denyRead).toContain('/host/project/.env');
    expect(settings.filesystem.denyWrite).toContain('/host/project/.env');
    expect(settings.filesystem.allowWrite).toContain('/host/group');
  });
});

describe('buildSandboxArgs', () => {
  it('includes settings path and agent-runner path', () => {
    const args = buildSandboxArgs('/tmp/settings.json');
    expect(args[0]).toBe('npx');
    expect(args[1]).toBe('@anthropic-ai/sandbox-runtime');
    expect(args).toContain('--settings');
    expect(args).toContain('/tmp/settings.json');
    expect(args).toContain('--');
    expect(args).toContain('node');
    expect(args[args.length - 1]).toMatch(
      /agent\/runner\/dist\/index\.js$/,
    );
  });
});
