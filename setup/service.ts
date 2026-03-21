/**
 * Step: service — Generate and load service manager config.
 * Replaces 08-setup-service.sh
 *
 * Fixes: Root→system systemd, WSL nohup fallback, no `|| true` swallowing errors.
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
  const projectRoot = process.cwd();
  const platform = getPlatform();
  const nodePath = getNodePath();
  const homeDir = os.homedir();
  const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA || undefined;
  // In plugin mode, always resolve an instance name (default to 'default')
  const instanceName = pluginDataDir
    ? (process.env.MOTHERCLAW_INSTANCE || 'default')
    : undefined;

  logger.info({ platform, nodePath, projectRoot, pluginDataDir, instanceName }, 'Setting up service');

  // Build first
  logger.info('Building TypeScript');
  try {
    execSync('npm run build', {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    logger.info('Build succeeded');
  } catch {
    logger.error('Build failed');
    emitStatus('SETUP_SERVICE', {
      SERVICE_TYPE: 'unknown',
      NODE_PATH: nodePath,
      PROJECT_PATH: projectRoot,
      STATUS: 'failed',
      ERROR: 'build_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true });

  if (platform === 'macos') {
    setupLaunchd(projectRoot, nodePath, homeDir, pluginDataDir, instanceName);
  } else if (platform === 'linux') {
    setupLinux(projectRoot, nodePath, homeDir, pluginDataDir, instanceName);
  } else {
    emitStatus('SETUP_SERVICE', {
      SERVICE_TYPE: 'unknown',
      NODE_PATH: nodePath,
      PROJECT_PATH: projectRoot,
      STATUS: 'failed',
      ERROR: 'unsupported_platform',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }
}

function setupLaunchd(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
  pluginDataDir?: string,
  instanceName?: string,
): void {
  const serviceLabel = instanceName ? `com.motherclaw.${instanceName}` : 'com.motherclaw';
  const plistFilename = `${serviceLabel}.plist`;
  const plistPath = path.join(
    homeDir,
    'Library',
    'LaunchAgents',
    plistFilename,
  );
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });

  const logDir = pluginDataDir
    ? instanceName
      ? path.join(pluginDataDir, 'instances', instanceName, 'logs')
      : path.join(pluginDataDir, 'logs')
    : path.join(projectRoot, 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  const envFilePath = pluginDataDir
    ? instanceName
      ? path.join(pluginDataDir, 'instances', instanceName, '.env')
      : path.join(pluginDataDir, '.env')
    : undefined;

  // Plugin-mode env vars injected into plist EnvironmentVariables dict
  let extraEnvVars = '';
  if (pluginDataDir) {
    extraEnvVars += `
        <key>CLAUDE_PLUGIN_DATA</key>
        <string>${pluginDataDir}</string>
        <key>MOTHERCLAW_ENV_FILE</key>
        <string>${envFilePath}</string>`;
  }
  if (instanceName) {
    extraEnvVars += `
        <key>MOTHERCLAW_INSTANCE</key>
        <string>${instanceName}</string>`;
  }

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${serviceLabel}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${projectRoot}/dist/service.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectRoot}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin</string>
        <key>HOME</key>
        <string>${homeDir}</string>${extraEnvVars}
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
    PROJECT_PATH: projectRoot,
    PLIST_PATH: plistPath,
    SERVICE_LOADED: serviceLoaded,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

function setupLinux(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
  pluginDataDir?: string,
  instanceName?: string,
): void {
  const serviceManager = getServiceManager();

  if (serviceManager === 'systemd') {
    setupSystemd(projectRoot, nodePath, homeDir, pluginDataDir, instanceName);
  } else {
    // WSL without systemd or other Linux without systemd
    setupNohupFallback(projectRoot, nodePath, homeDir, pluginDataDir, instanceName);
  }
}

/**
 * Kill any orphaned motherclaw node processes left from previous runs or debugging.
 * Prevents connection conflicts when two instances connect to the same channel simultaneously.
 *
 * When instanceName is set, only kills processes matching that instance (via MOTHERCLAW_INSTANCE env).
 * When not set, kills all processes matching the projectRoot service script.
 */
function killOrphanedProcesses(projectRoot: string, instanceName?: string): void {
  try {
    const pattern = instanceName
      ? `MOTHERCLAW_INSTANCE=${instanceName}.*${projectRoot}/dist/service\\.js`
      : `${projectRoot}/dist/service\\.js`;
    execSync(`pkill -f '${pattern}' || true`, {
      stdio: 'ignore',
    });
    logger.info({ instanceName }, 'Stopped any orphaned motherclaw processes');
  } catch {
    // pkill not available or no orphans
  }
}

/**
 * Detect stale docker group membership in the user systemd session.
 *
 * When a user is added to the docker group mid-session, the user systemd
 * daemon (user@UID.service) keeps the old group list from login time.
 * Docker works in the terminal but not in the service context.
 *
 * Only relevant on Linux with user-level systemd (not root, not macOS, not WSL nohup).
 */
function checkDockerGroupStale(): boolean {
  try {
    execSync('systemd-run --user --pipe --wait docker info', {
      stdio: 'pipe',
      timeout: 10000,
    });
    return false; // Docker works from systemd session
  } catch {
    // Check if docker works from the current shell (to distinguish stale group vs broken docker)
    try {
      execSync('docker info', { stdio: 'pipe', timeout: 5000 });
      return true; // Works in shell but not systemd session → stale group
    } catch {
      return false; // Docker itself is not working, different issue
    }
  }
}

function setupSystemd(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
  pluginDataDir?: string,
  instanceName?: string,
): void {
  const runningAsRoot = isRoot();
  const unitName = instanceName ? `motherclaw-${instanceName}` : 'motherclaw';

  // Root uses system-level service, non-root uses user-level
  let unitPath: string;
  let systemctlPrefix: string;

  if (runningAsRoot) {
    unitPath = `/etc/systemd/system/${unitName}.service`;
    systemctlPrefix = 'systemctl';
    logger.info('Running as root — installing system-level systemd unit');
  } else {
    // Check if user-level systemd session is available
    try {
      execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    } catch {
      logger.warn(
        'systemd user session not available — falling back to nohup wrapper',
      );
      setupNohupFallback(projectRoot, nodePath, homeDir, pluginDataDir, instanceName);
      return;
    }
    const unitDir = path.join(homeDir, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    unitPath = path.join(unitDir, `${unitName}.service`);
    systemctlPrefix = 'systemctl --user';
  }

  const logDir = pluginDataDir
    ? instanceName
      ? path.join(pluginDataDir, 'instances', instanceName, 'logs')
      : path.join(pluginDataDir, 'logs')
    : path.join(projectRoot, 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  const envFilePath = pluginDataDir
    ? instanceName
      ? path.join(pluginDataDir, 'instances', instanceName, '.env')
      : path.join(pluginDataDir, '.env')
    : undefined;

  let extraEnvLines = '';
  if (pluginDataDir) {
    extraEnvLines += `\nEnvironment=CLAUDE_PLUGIN_DATA=${pluginDataDir}\nEnvironment=MOTHERCLAW_ENV_FILE=${envFilePath}`;
  }
  if (instanceName) {
    extraEnvLines += `\nEnvironment=MOTHERCLAW_INSTANCE=${instanceName}`;
  }

  const unit = `[Unit]
Description=MotherClaw Personal Assistant${instanceName ? ` (${instanceName})` : ''}
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${projectRoot}/dist/service.js
WorkingDirectory=${projectRoot}
Restart=always
RestartSec=5
Environment=HOME=${homeDir}
Environment=PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin${extraEnvLines}
StandardOutput=append:${logDir}/motherclaw.log
StandardError=append:${logDir}/motherclaw.error.log

[Install]
WantedBy=${runningAsRoot ? 'multi-user.target' : 'default.target'}`;

  fs.writeFileSync(unitPath, unit);
  logger.info({ unitPath }, 'Wrote systemd unit');

  // Detect stale docker group before starting (user systemd only)
  const dockerGroupStale = !runningAsRoot && checkDockerGroupStale();
  if (dockerGroupStale) {
    logger.warn(
      'Docker group not active in systemd session — user was likely added to docker group mid-session',
    );
  }

  // Kill orphaned motherclaw processes to avoid channel connection conflicts
  killOrphanedProcesses(projectRoot, instanceName);

  // Enable and start
  try {
    execSync(`${systemctlPrefix} daemon-reload`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl daemon-reload failed');
  }

  try {
    execSync(`${systemctlPrefix} enable ${unitName}`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl enable failed');
  }

  try {
    execSync(`${systemctlPrefix} start ${unitName}`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl start failed');
  }

  // Verify
  let serviceLoaded = false;
  try {
    execSync(`${systemctlPrefix} is-active ${unitName}`, { stdio: 'ignore' });
    serviceLoaded = true;
  } catch {
    // Not active
  }

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: runningAsRoot ? 'systemd-system' : 'systemd-user',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    UNIT_PATH: unitPath,
    SERVICE_LOADED: serviceLoaded,
    ...(dockerGroupStale ? { DOCKER_GROUP_STALE: true } : {}),
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

function setupNohupFallback(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
  pluginDataDir?: string,
  instanceName?: string,
): void {
  logger.warn('No systemd detected — generating nohup wrapper script');

  const scriptName = instanceName ? `start-motherclaw-${instanceName}.sh` : 'start-motherclaw.sh';
  const pidName = instanceName ? `motherclaw-${instanceName}.pid` : 'motherclaw.pid';
  const wrapperPath = path.join(projectRoot, scriptName);
  const pidFile = path.join(projectRoot, pidName);

  const logDir = pluginDataDir
    ? instanceName
      ? path.join(pluginDataDir, 'instances', instanceName, 'logs')
      : path.join(pluginDataDir, 'logs')
    : path.join(projectRoot, 'logs');

  const envFilePath = pluginDataDir
    ? instanceName
      ? path.join(pluginDataDir, 'instances', instanceName, '.env')
      : path.join(pluginDataDir, '.env')
    : undefined;

  const extraExports: string[] = [];
  if (pluginDataDir) {
    extraExports.push(
      `export CLAUDE_PLUGIN_DATA=${JSON.stringify(pluginDataDir)}`,
      `export MOTHERCLAW_ENV_FILE=${JSON.stringify(envFilePath)}`,
    );
  }
  if (instanceName) {
    extraExports.push(`export MOTHERCLAW_INSTANCE=${JSON.stringify(instanceName)}`);
  }
  if (extraExports.length > 0) {
    extraExports.push('');
  }

  const lines = [
    '#!/bin/bash',
    `# ${scriptName} — Start MotherClaw without systemd`,
    `# To stop: kill \\$(cat ${pidFile})`,
    '',
    'set -euo pipefail',
    '',
    `export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin"`,
    ...extraExports,
    `cd ${JSON.stringify(projectRoot)}`,
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
    `nohup ${JSON.stringify(nodePath)} ${JSON.stringify(projectRoot + '/dist/service.js')} \\`,
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
    PROJECT_PATH: projectRoot,
    WRAPPER_PATH: wrapperPath,
    SERVICE_LOADED: false,
    FALLBACK: 'wsl_no_systemd',
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
