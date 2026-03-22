import { describe, it, expect } from 'vitest';
import path from 'path';

/**
 * Tests for service configuration generation.
 *
 * New model: directory IS the instance. Service label derived from directory name.
 * codeRoot = where dist/service.js lives. dataDir = working directory (state).
 * In developer mode both are the same. In plugin mode they differ.
 */

// Helper: generate a plist string (developer mode: codeRoot == dataDir)
function generatePlist(
  nodePath: string,
  codeRoot: string,
  dataDir: string,
  homeDir: string,
): string {
  const dirName = path.basename(dataDir).replace(/[^a-zA-Z0-9_-]/g, '-');
  const serviceLabel = `com.motherclaw.${dirName}`;
  const logDir = `${dataDir}/logs`;
  return `<?xml version="1.0" encoding="UTF-8"?>
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
}

function generateSystemdUnit(
  nodePath: string,
  codeRoot: string,
  dataDir: string,
  homeDir: string,
  isSystem: boolean,
): string {
  const dirName = path.basename(dataDir).replace(/[^a-zA-Z0-9_-]/g, '-');
  const logDir = `${dataDir}/logs`;
  return `[Unit]
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
WantedBy=${isSystem ? 'multi-user.target' : 'default.target'}`;
}

describe('plist generation', () => {
  it('label derived from directory name', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/motherclaw',
      '/home/user/motherclaw',
      '/home/user',
    );
    expect(plist).toContain('<string>com.motherclaw.motherclaw</string>');
  });

  it('uses the correct node path', () => {
    const plist = generatePlist(
      '/opt/node/bin/node',
      '/home/user/motherclaw',
      '/home/user/motherclaw',
      '/home/user',
    );
    expect(plist).toContain('<string>/opt/node/bin/node</string>');
  });

  it('points to dist/service.js from codeRoot', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/motherclaw',
      '/home/user/motherclaw',
      '/home/user',
    );
    expect(plist).toContain('/home/user/motherclaw/dist/service.js');
  });

  it('WorkingDirectory is dataDir', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/opt/code/motherclaw',
      '/home/user/my-assistant',
      '/home/user',
    );
    expect(plist).toContain('<string>/home/user/my-assistant</string>');
  });

  it('log paths in dataDir', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/motherclaw',
      '/home/user/motherclaw',
      '/home/user',
    );
    expect(plist).toContain('motherclaw.log');
    expect(plist).toContain('motherclaw.error.log');
  });

  it('PATH includes /opt/homebrew/bin', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/motherclaw',
      '/home/user/motherclaw',
      '/home/user',
    );
    expect(plist).toContain('/opt/homebrew/bin');
  });
});

describe('plugin mode plist (codeRoot != dataDir)', () => {
  it('ExecStart uses codeRoot, WorkingDirectory uses dataDir', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/opt/plugins/motherclaw',
      '/home/user/my-assistant',
      '/home/user',
    );
    expect(plist).toContain('/opt/plugins/motherclaw/dist/service.js');
    expect(plist).toContain('<string>/home/user/my-assistant</string>');
  });

  it('label derived from dataDir, not codeRoot', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/opt/plugins/motherclaw',
      '/home/user/personal-ai',
      '/home/user',
    );
    expect(plist).toContain('com.motherclaw.personal-ai');
  });

  it('logs are in dataDir, not codeRoot', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/opt/plugins/motherclaw',
      '/home/user/my-assistant',
      '/home/user',
    );
    expect(plist).toContain('/home/user/my-assistant/logs/motherclaw.log');
    expect(plist).not.toContain('/opt/plugins/motherclaw/logs/');
  });

  it('no CLAUDE_PLUGIN_DATA or MOTHERCLAW_INSTANCE env vars', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/opt/plugins/motherclaw',
      '/home/user/my-assistant',
      '/home/user',
    );
    expect(plist).not.toContain('CLAUDE_PLUGIN_DATA');
    expect(plist).not.toContain('MOTHERCLAW_INSTANCE');
  });
});

describe('systemd unit generation', () => {
  it('user unit uses default.target', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/motherclaw',
      '/home/user/motherclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain('WantedBy=default.target');
  });

  it('system unit uses multi-user.target', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/motherclaw',
      '/home/user/motherclaw',
      '/home/user',
      true,
    );
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('contains restart policy', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/motherclaw',
      '/home/user/motherclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartSec=5');
  });

  it('description includes directory name', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/opt/code/motherclaw',
      '/home/user/personal-ai',
      '/home/user',
      false,
    );
    expect(unit).toContain('Description=MotherClaw Personal Assistant (personal-ai)');
  });
});

describe('WSL nohup fallback', () => {
  it('generates a valid wrapper script', () => {
    const dataDir = '/home/user/motherclaw';
    const codeRoot = '/home/user/motherclaw';
    const nodePath = '/usr/bin/node';
    const pidFile = path.join(dataDir, 'motherclaw.pid');

    const wrapper = `#!/bin/bash
set -euo pipefail
cd ${JSON.stringify(dataDir)}
nohup ${JSON.stringify(nodePath)} ${JSON.stringify(codeRoot)}/dist/service.js >> ${JSON.stringify(dataDir)}/logs/motherclaw.log 2>> ${JSON.stringify(dataDir)}/logs/motherclaw.error.log &
echo $! > ${JSON.stringify(pidFile)}`;

    expect(wrapper).toContain('#!/bin/bash');
    expect(wrapper).toContain('nohup');
    expect(wrapper).toContain(nodePath);
    expect(wrapper).toContain('motherclaw.pid');
  });
});
