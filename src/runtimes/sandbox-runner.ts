/**
 * Sandbox runtime for ClaudeClaw.
 *
 * Uses OS-level sandboxing (Seatbelt on macOS, bubblewrap on Linux) via
 * @anthropic-ai/sandbox-runtime for near-zero-overhead agent execution.
 *
 * Key differences from container-runner.ts:
 * - No container daemon dependency — spawns a sandboxed node process directly
 * - Near-zero overhead (<10ms cold start vs seconds for containers)
 * - Real credentials passed directly + network restricted to allowedDomains
 * - Orphan cleanup via PID files in data/sandbox-pids/
 * - Agent runner pre-compiled on host at agent/runner/dist/index.js
 */
import { ChildProcess, execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../orchestrator/env.js';
import {
  CODE_ROOT,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from '../orchestrator/config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from '../orchestrator/group-folder.js';
import { logger } from '../orchestrator/logger.js';
import { validateAdditionalMounts } from '../orchestrator/mount-security.js';
import { RegisteredGroup } from '../orchestrator/types.js';
import type { ContainerInput, ContainerOutput } from './container-runner.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---CLAUDECLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---CLAUDECLAW_OUTPUT_END---';

const SANDBOX_PID_DIR = path.join(DATA_DIR, 'sandbox-pids');

// ---------------------------------------------------------------------------
// Settings types
// ---------------------------------------------------------------------------

export interface SandboxSettings {
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    allowLocalBinding: boolean;
  };
  filesystem: {
    denyRead: string[];
    allowRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
}

interface SandboxMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
  deny?: boolean;
}

// ---------------------------------------------------------------------------
// Health check & cleanup
// ---------------------------------------------------------------------------

/**
 * Verify that sandbox-runtime is available.
 */
export function ensureSandboxRuntimeAvailable(): void {
  try {
    execFileSync('npx', ['@anthropic-ai/sandbox-runtime', '--version'], {
      stdio: 'pipe',
      timeout: 30000,
    });
    logger.debug('sandbox-runtime is available');
  } catch (err) {
    logger.error({ err }, 'sandbox-runtime not found');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: sandbox-runtime not found                              ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Install: npm install @anthropic-ai/sandbox-runtime            ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('sandbox-runtime is required but not installed');
  }
}

/**
 * Kill orphaned sandbox processes from a previous run using PID files.
 */
export function cleanupSandboxOrphans(): void {
  if (!fs.existsSync(SANDBOX_PID_DIR)) return;

  const pidFiles = fs
    .readdirSync(SANDBOX_PID_DIR)
    .filter((f) => f.endsWith('.pid'));
  const killed: string[] = [];

  for (const file of pidFiles) {
    const pidPath = path.join(SANDBOX_PID_DIR, file);
    try {
      const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
      if (isNaN(pid)) {
        fs.unlinkSync(pidPath);
        continue;
      }
      try {
        process.kill(pid, 0); // existence check
        process.kill(pid, 'SIGTERM');
        killed.push(file.replace('.pid', ''));
      } catch {
        // Process already dead
      }
      fs.unlinkSync(pidPath);
    } catch {
      try {
        fs.unlinkSync(pidPath);
      } catch {
        /* ignore */
      }
    }
  }

  if (killed.length > 0) {
    logger.info(
      { count: killed.length, names: killed },
      'Stopped orphaned sandbox processes',
    );
  }
}

// ---------------------------------------------------------------------------
// Mount building (mirrors container-runner.ts buildVolumeMounts)
// ---------------------------------------------------------------------------

function buildSandboxMounts(
  group: RegisteredGroup,
  isMain: boolean,
): SandboxMount[] {
  const mounts: SandboxMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets project root read-only
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env — deny read/write access to secrets
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: envFile,
        containerPath: '/workspace/project/.env',
        readonly: true,
        deny: true,
      });
    }

    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group IPC namespace
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Per-group Claude sessions directory
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  // Ensure settings.json exists
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from agent/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'agent', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  // Sandbox needs Claude home dir to be accessible
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Additional mounts validated against external allowlist
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    for (const vm of validatedMounts) {
      mounts.push({
        hostPath: vm.hostPath,
        containerPath: vm.containerPath,
        readonly: vm.readonly,
      });
    }
  }

  return mounts;
}

// ---------------------------------------------------------------------------
// Settings & args builders
// ---------------------------------------------------------------------------

/**
 * Build sandbox settings from mounts and optional extra allowed domains.
 *
 * Network domains are layered:
 *   1. Base (always): api.anthropic.com, *.anthropic.com, localhost, 127.0.0.1
 *   2. Extra: from agentConfig.allowedDomains (per-group) and extension manifests
 *
 * Duplicates are removed automatically.
 */
export function buildSandboxSettings(
  mounts: SandboxMount[],
  extraAllowedDomains: string[] = [],
): SandboxSettings {
  const denyRead: string[] = [];
  const allowRead: string[] = [];
  const allowWrite: string[] = [];
  const denyWrite: string[] = [];

  for (const mount of mounts) {
    if (mount.deny) {
      denyRead.push(mount.hostPath);
      denyWrite.push(mount.hostPath);
    } else if (mount.readonly) {
      allowRead.push(mount.hostPath);
      denyWrite.push(mount.hostPath); // enforce read-only at srt level
    } else {
      // read-write
      allowWrite.push(mount.hostPath);
    }
  }

  // Merge base + extra domains, deduplicate
  const baseDomains = [
    'api.anthropic.com',
    '*.anthropic.com',
    'localhost',
    '127.0.0.1',
  ];
  const allDomains = [...new Set([...baseDomains, ...extraAllowedDomains])];

  return {
    network: {
      allowedDomains: allDomains,
      deniedDomains: [],
      allowLocalBinding: true,
    },
    filesystem: {
      denyRead,
      allowRead,
      allowWrite,
      denyWrite,
    },
  };
}

export function buildSandboxArgs(settingsPath: string): string[] {
  // Sandbox runs the pre-compiled agent-runner directly on the host.
  // Build with: cd agent/runner && npx tsc
  // Agent runner lives in the CODE root, not the data/state root.
  const agentRunnerPath = path.join(
    CODE_ROOT,
    'agent',
    'runner',
    'dist',
    'index.js',
  );

  return [
    'npx',
    '@anthropic-ai/sandbox-runtime',
    '--settings',
    settingsPath,
    '--',
    'node',
    agentRunnerPath,
  ];
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

export async function runSandboxAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, processName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const groupDir = resolveGroupFolderPath(input.groupFolder);
  fs.mkdirSync(groupDir, { recursive: true });

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processName = `claudeclaw-sandbox-${safeName}-${Date.now()}`;

  // Build mounts and srt settings
  const mounts = buildSandboxMounts(group, input.isMain);
  const settingsDir = path.join(DATA_DIR, 'sandbox-settings');
  fs.mkdirSync(settingsDir, { recursive: true });
  const settingsPath = path.join(settingsDir, `${processName}.json`);
  const extraDomains = group.agentConfig?.allowedDomains ?? [];
  const settings = buildSandboxSettings(mounts, extraDomains);
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  const sandboxArgs = buildSandboxArgs(settingsPath);

  logger.info(
    {
      group: group.name,
      processName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning sandbox agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    // Map container paths to host paths via env vars
    const pathEnv: Record<string, string> = {};
    for (const mount of mounts) {
      if (mount.containerPath === '/workspace/group')
        pathEnv.CLAUDECLAW_GROUP_DIR = mount.hostPath;
      else if (mount.containerPath === '/workspace/ipc')
        pathEnv.CLAUDECLAW_IPC_DIR = mount.hostPath;
      else if (mount.containerPath === '/workspace/project' && !mount.deny)
        pathEnv.CLAUDECLAW_PROJECT_DIR = mount.hostPath;
      else if (mount.containerPath === '/workspace/global')
        pathEnv.CLAUDECLAW_GLOBAL_DIR = mount.hostPath;
      else if (mount.containerPath?.startsWith('/workspace/extra'))
        pathEnv.CLAUDECLAW_EXTRA_DIR = mount.hostPath;
    }

    // Sandbox: real credentials + restricted network (no proxy needed)
    const secrets = readEnvFile([
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_AUTH_TOKEN',
    ]);

    const child = spawn(sandboxArgs[0], sandboxArgs.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TZ: TIMEZONE,
        ...(secrets.ANTHROPIC_API_KEY
          ? { ANTHROPIC_API_KEY: secrets.ANTHROPIC_API_KEY }
          : {
              CLAUDE_CODE_OAUTH_TOKEN:
                secrets.CLAUDE_CODE_OAUTH_TOKEN ||
                secrets.ANTHROPIC_AUTH_TOKEN ||
                '',
            }),
        ...pathEnv,
      },
    });

    // Write PID file for orphan cleanup
    fs.mkdirSync(SANDBOX_PID_DIR, { recursive: true });
    const pidFile = path.join(SANDBOX_PID_DIR, `${processName}.pid`);
    if (child.pid) {
      fs.writeFileSync(pidFile, String(child.pid));
    }

    onProcess(child, processName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let hadStreamingOutput = false;
    let newSessionId: string | undefined;

    child.stdin!.write(JSON.stringify(input));
    child.stdin!.end();

    // Timeout handling — declared before event handlers so closures can reference them
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, processName },
        'Sandbox timeout, killing',
      );
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 5000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    // Streaming output parsing
    let parseBuffer = '';
    let outputChain = Promise.resolve();

    child.stdout!.on('data', (data) => {
      const chunk = data.toString();

      // Accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Sandbox stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while (
          (startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1
        ) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            resetTimeout();
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse sandbox output chunk',
            );
          }
        }
      }
    });

    child.stderr!.on('data', (data) => {
      const chunk = data.toString();
      for (const line of chunk.trim().split('\n')) {
        if (line) logger.debug({ sandbox: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Sandbox stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      // Clean up PID and settings files
      try {
        fs.unlinkSync(pidFile);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(settingsPath);
      } catch {
        /* ignore */
      }

      const duration = Date.now() - startTime;

      if (timedOut) {
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, processName, duration, code },
            'Sandbox timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }
        logger.error(
          { group: group.name, processName, duration, code },
          'Sandbox timed out with no output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Sandbox timed out after ${configTimeout}ms`,
        });
        return;
      }

      if (code !== 0) {
        logger.error(
          { group: group.name, code, duration, stderr },
          'Sandbox exited with error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Sandbox exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Sandbox completed (streaming mode)',
          );
          resolve({ status: 'success', result: null, newSessionId });
        });
        return;
      }

      // Legacy mode: parse last output marker pair
      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }
        resolve(JSON.parse(jsonLine));
      } catch (err) {
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse sandbox output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      try {
        fs.unlinkSync(pidFile);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(settingsPath);
      } catch {
        /* ignore */
      }
      resolve({
        status: 'error',
        result: null,
        error: `Sandbox spawn error: ${err.message}`,
      });
    });
  });
}
