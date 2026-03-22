/**
 * Step: service — Generate and load service manager config.
 *
 * The service's WorkingDirectory is the data directory (cwd during setup).
 * The service executable is dist/service.js from the code directory (codeRoot).
 * In developer mode, both are the same directory.
 * In plugin mode, codeRoot is CLAUDE_PLUGIN_ROOT, data dir is cwd.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from '../src/orchestrator/logger.js';
import {
  getPlatform,
  getNodePath,
  getServiceManager,
  hasSystemd,
  isRoot,
  isWSL,
} from './platform.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  const dataDir = process.cwd();
  // Code root: in plugin mode, CLAUDE_PLUGIN_ROOT points to the plugin code.
  // In developer mode, code is in cwd.
  const codeRoot = process.env.CLAUDE_PLUGIN_ROOT || dataDir;
  const platform = getPlatform();
  const nodePath = getNodePath();
  const homeDir = os.homedir();

  logger.info({ platform, nodePath, codeRoot, dataDir }, 'Setting up service');

  // Build first (from code root)
  logger.info('Building TypeScript');
  try {
    execSync('npm run build', {
      cwd: codeRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    logger.info('Build succeeded');
  } catch {
    logger.error('Build failed');
    emitStatus('SETUP_SERVICE', {
      SERVICE_TYPE: 'unknown',
      NODE_PATH: nodePath,
      PROJECT_PATH: codeRoot,
      STATUS: 'failed',
      ERROR: 'build_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });

  if (platform === 'macos') {
    setupLaunchd(codeRoot, dataDir, nodePath, homeDir);
  } else if (platform === 'linux') {
    setupLinux(codeRoot, dataDir, nodePath, homeDir);
  } else {
    emitStatus('SETUP_SERVICE', {
      SERVICE_TYPE: 'unknown',
      NODE_PATH: nodePath,
      PROJECT_PATH: codeRoot,
      STATUS: 'failed',
      ERROR: 'unsupported_platform',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }
}

function setupLaunchd(
  codeRoot: string,
  dataDir: string,
  nodePath: string,
  homeDir: string,
): void {
  // Service label derived from data directory name for uniqueness
  const dirName = path.basename(dataDir).replace(/[^a-zA-Z0-9_-]/g, '-');
  const serviceLabel = `com.motherclaw.${dirName}`;
  const plistFilename = `${serviceLabel}.plist`;
  const plistPath = path.join(
    homeDir,
    'Library',
    'LaunchAgents',
    plistFilename,
  );
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });

  const logDir = path.join(dataDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${serviceLabel}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${codeRoot}/dist/service.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${dataDir}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin</string>
        <key>HOME</key>
        <string>${homeDir}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${logDir}/motherclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${logDir}/motherclaw.error.log</string>
</dict>
</plist>`;

  fs.writeFileSync(plistPath, plist);
  logger.info({ plistPath }, 'Wrote launchd plist');

  try {
    execSync(`launchctl load ${JSON.stringify(plistPath)}`, {
      stdio: 'ignore',
    });
    logger.info('launchctl load succeeded');
  } catch {
    logger.warn('launchctl load failed (may already be loaded)');
  }

  // Verify
  let serviceLoaded = false;
  try {
    const output = execSync('launchctl list', { encoding: 'utf-8' });
    serviceLoaded = output.includes(serviceLabel);
  } catch {
    // launchctl list failed
  }

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: 'launchd',
    NODE_PATH: nodePath,
    PROJECT_PATH: codeRoot,
    DATA_DIR: dataDir,
    PLIST_PATH: plistPath,
    SERVICE_LOADED: serviceLoaded,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

function setupLinux(
  codeRoot: string,
  dataDir: string,
  nodePath: string,
  homeDir: string,
): void {
  const serviceManager = getServiceManager();

  if (serviceManager === 'systemd') {
    setupSystemd(codeRoot, dataDir, nodePath, homeDir);
  } else {
    setupNohupFallback(codeRoot, dataDir, nodePath, homeDir);
  }
}

/**
 * Kill any orphaned motherclaw node processes left from previous runs.
 * Matches on the data directory to avoid killing other instances.
 */
function killOrphanedProcesses(codeRoot: string): void {
  try {
    execSync(`pkill -f '${codeRoot}/dist/service\\.js' || true`, {
      stdio: 'ignore',
    });
    logger.info('Stopped any orphaned motherclaw processes');
  } catch {
    // pkill not available or no orphans
  }
}

/**
 * Detect stale docker group membership in the user systemd session.
 */
function checkDockerGroupStale(): boolean {
  try {
    execSync('systemd-run --user --pipe --wait docker info', {
      stdio: 'pipe',
      timeout: 10000,
    });
    return false;
  } catch {
    try {
      execSync('docker info', { stdio: 'pipe', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}

function setupSystemd(
  codeRoot: string,
  dataDir: string,
  nodePath: string,
  homeDir: string,
): void {
  const runningAsRoot = isRoot();
  const dirName = path.basename(dataDir).replace(/[^a-zA-Z0-9_-]/g, '-');
  const unitName = `motherclaw-${dirName}`;

  let unitPath: string;
  let systemctlPrefix: string;

  if (runningAsRoot) {
    unitPath = `/etc/systemd/system/${unitName}.service`;
    systemctlPrefix = 'systemctl';
    logger.info('Running as root — installing system-level systemd unit');
  } else {
    try {
      execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    } catch {
      logger.warn('systemd user session not available — falling back to nohup wrapper');
      setupNohupFallback(codeRoot, dataDir, nodePath, homeDir);
      return;
    }
    const unitDir = path.join(homeDir, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    unitPath = path.join(unitDir, `${unitName}.service`);
    systemctlPrefix = 'systemctl --user';
  }

  const logDir = path.join(dataDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  const unit = `[Unit]
Description=MotherClaw Personal Assistant (${dirName})
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${codeRoot}/dist/service.js
WorkingDirectory=${dataDir}
Restart=always
RestartSec=5
Environment=HOME=${homeDir}
Environment=PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin
StandardOutput=append:${logDir}/motherclaw.log
StandardError=append:${logDir}/motherclaw.error.log

[Install]
WantedBy=${runningAsRoot ? 'multi-user.target' : 'default.target'}`;

  fs.writeFileSync(unitPath, unit);
  logger.info({ unitPath }, 'Wrote systemd unit');

  const dockerGroupStale = !runningAsRoot && checkDockerGroupStale();
  if (dockerGroupStale) {
    logger.warn('Docker group not active in systemd session');
  }

  killOrphanedProcesses(codeRoot);

  try { execSync(`${systemctlPrefix} daemon-reload`, { stdio: 'ignore' }); } catch (err) { logger.error({ err }, 'daemon-reload failed'); }
  try { execSync(`${systemctlPrefix} enable ${unitName}`, { stdio: 'ignore' }); } catch (err) { logger.error({ err }, 'enable failed'); }
  try { execSync(`${systemctlPrefix} start ${unitName}`, { stdio: 'ignore' }); } catch (err) { logger.error({ err }, 'start failed'); }

  let serviceLoaded = false;
  try {
    execSync(`${systemctlPrefix} is-active ${unitName}`, { stdio: 'ignore' });
    serviceLoaded = true;
  } catch { /* Not active */ }

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: runningAsRoot ? 'systemd-system' : 'systemd-user',
    NODE_PATH: nodePath,
    PROJECT_PATH: codeRoot,
    DATA_DIR: dataDir,
    UNIT_PATH: unitPath,
    SERVICE_LOADED: serviceLoaded,
    ...(dockerGroupStale ? { DOCKER_GROUP_STALE: true } : {}),
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

function setupNohupFallback(
  codeRoot: string,
  dataDir: string,
  nodePath: string,
  homeDir: string,
): void {
  logger.warn('No systemd detected — generating nohup wrapper script');

  const wrapperPath = path.join(dataDir, 'start-motherclaw.sh');
  const pidFile = path.join(dataDir, 'motherclaw.pid');
  const logDir = path.join(dataDir, 'logs');

  const lines = [
    '#!/bin/bash',
    '# start-motherclaw.sh — Start MotherClaw without systemd',
    `# To stop: kill $(cat ${pidFile})`,
    '',
    'set -euo pipefail',
    '',
    `export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin"`,
    `cd ${JSON.stringify(dataDir)}`,
    '',
    '# Stop existing instance if running',
    `if [ -f ${JSON.stringify(pidFile)} ]; then`,
    `  OLD_PID=$(cat ${JSON.stringify(pidFile)} 2>/dev/null || echo "")`,
    '  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then',
    '    echo "Stopping existing MotherClaw (PID $OLD_PID)..."',
    '    kill "$OLD_PID" 2>/dev/null || true',
    '    sleep 2',
    '  fi',
    'fi',
    '',
    'echo "Starting MotherClaw..."',
    `nohup ${JSON.stringify(nodePath)} ${JSON.stringify(codeRoot + '/dist/service.js')} \\`,
    `  >> ${JSON.stringify(logDir + '/motherclaw.log')} \\`,
    `  2>> ${JSON.stringify(logDir + '/motherclaw.error.log')} &`,
    '',
    `echo $! > ${JSON.stringify(pidFile)}`,
    'echo "MotherClaw started (PID $!)"',
    `echo "Logs: tail -f ${logDir}/motherclaw.log"`,
  ];
  const wrapper = lines.join('\n') + '\n';

  fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
  logger.info({ wrapperPath }, 'Wrote nohup wrapper script');

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: 'nohup',
    NODE_PATH: nodePath,
    PROJECT_PATH: codeRoot,
    DATA_DIR: dataDir,
    WRAPPER_PATH: wrapperPath,
    SERVICE_LOADED: false,
    FALLBACK: 'wsl_no_systemd',
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
