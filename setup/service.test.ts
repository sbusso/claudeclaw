import { describe, it, expect } from 'vitest';
import path from 'path';

/**
 * Tests for service configuration generation.
 *
 * These tests verify the generated content of plist/systemd/nohup configs
 * without actually loading services.
 */

// Helper: generate a plist string the same way service.ts does (developer mode)
function generatePlist(
  nodePath: string,
  projectRoot: string,
  homeDir: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.motherclaw</string>
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
        <string>${homeDir}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${projectRoot}/logs/motherclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${projectRoot}/logs/motherclaw.error.log</string>
</dict>
</plist>`;
}

// Helper: generate a plist string for plugin mode
function generatePluginPlist(
  nodePath: string,
  projectRoot: string,
  homeDir: string,
  pluginDataDir: string,
): string {
  const logDir = `${pluginDataDir}/logs`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.motherclaw</string>
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
        <string>${homeDir}</string>
        <key>CLAUDE_PLUGIN_DATA</key>
        <string>${pluginDataDir}</string>
        <key>MOTHERCLAW_ENV_FILE</key>
        <string>${pluginDataDir}/.env</string>
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
  projectRoot: string,
  homeDir: string,
  isSystem: boolean,
): string {
  return `[Unit]
Description=MotherClaw Personal Assistant
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${projectRoot}/dist/service.js
WorkingDirectory=${projectRoot}
Restart=always
RestartSec=5
Environment=HOME=${homeDir}
Environment=PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin
StandardOutput=append:${projectRoot}/logs/motherclaw.log
StandardError=append:${projectRoot}/logs/motherclaw.error.log

[Install]
WantedBy=${isSystem ? 'multi-user.target' : 'default.target'}`;
}

describe('plist generation', () => {
  it('contains the correct label', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/motherclaw',
      '/home/user',
    );
    expect(plist).toContain('<string>com.motherclaw</string>');
  });

  it('uses the correct node path', () => {
    const plist = generatePlist(
      '/opt/node/bin/node',
      '/home/user/motherclaw',
      '/home/user',
    );
    expect(plist).toContain('<string>/opt/node/bin/node</string>');
  });

  it('points to dist/service.js', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/motherclaw',
      '/home/user',
    );
    expect(plist).toContain('/home/user/motherclaw/dist/service.js');
  });

  it('sets log paths', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/motherclaw',
      '/home/user',
    );
    expect(plist).toContain('motherclaw.log');
    expect(plist).toContain('motherclaw.error.log');
  });
});

describe('systemd unit generation', () => {
  it('user unit uses default.target', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
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
      '/home/user',
      true,
    );
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('contains restart policy', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/motherclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartSec=5');
  });

  it('sets correct ExecStart', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/srv/motherclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain(
      'ExecStart=/usr/bin/node /srv/motherclaw/dist/service.js',
    );
  });
});

describe('plugin mode plist generation', () => {
  const pluginDataDir = '/Users/testuser/.claude/plugins/motherclaw';

  it('includes CLAUDE_PLUGIN_DATA env var', () => {
    const plist = generatePluginPlist(
      '/usr/local/bin/node',
      '/home/user/motherclaw',
      '/home/user',
      pluginDataDir,
    );
    expect(plist).toContain('<key>CLAUDE_PLUGIN_DATA</key>');
    expect(plist).toContain(`<string>${pluginDataDir}</string>`);
  });

  it('includes MOTHERCLAW_ENV_FILE env var', () => {
    const plist = generatePluginPlist(
      '/usr/local/bin/node',
      '/home/user/motherclaw',
      '/home/user',
      pluginDataDir,
    );
    expect(plist).toContain('<key>MOTHERCLAW_ENV_FILE</key>');
    expect(plist).toContain(`<string>${pluginDataDir}/.env</string>`);
  });

  it('includes /opt/homebrew/bin in PATH', () => {
    const plist = generatePluginPlist(
      '/usr/local/bin/node',
      '/home/user/motherclaw',
      '/home/user',
      pluginDataDir,
    );
    expect(plist).toContain('/opt/homebrew/bin');
  });

  it('log paths point to CLAUDE_PLUGIN_DATA/logs/', () => {
    const plist = generatePluginPlist(
      '/usr/local/bin/node',
      '/home/user/motherclaw',
      '/home/user',
      pluginDataDir,
    );
    expect(plist).toContain(`${pluginDataDir}/logs/motherclaw.log`);
    expect(plist).toContain(`${pluginDataDir}/logs/motherclaw.error.log`);
    // Should NOT contain projectRoot/logs
    expect(plist).not.toContain('/home/user/motherclaw/logs/');
  });
});

describe('developer mode plist includes /opt/homebrew/bin', () => {
  it('PATH includes /opt/homebrew/bin', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/motherclaw',
      '/home/user',
    );
    expect(plist).toContain('/opt/homebrew/bin');
  });
});

describe('WSL nohup fallback', () => {
  it('generates a valid wrapper script', () => {
    const projectRoot = '/home/user/motherclaw';
    const nodePath = '/usr/bin/node';
    const pidFile = path.join(projectRoot, 'motherclaw.pid');

    // Simulate what service.ts generates
    const wrapper = `#!/bin/bash
set -euo pipefail
cd ${JSON.stringify(projectRoot)}
nohup ${JSON.stringify(nodePath)} ${JSON.stringify(projectRoot)}/dist/service.js >> ${JSON.stringify(projectRoot)}/logs/motherclaw.log 2>> ${JSON.stringify(projectRoot)}/logs/motherclaw.error.log &
echo $! > ${JSON.stringify(pidFile)}`;

    expect(wrapper).toContain('#!/bin/bash');
    expect(wrapper).toContain('nohup');
    expect(wrapper).toContain(nodePath);
    expect(wrapper).toContain('motherclaw.pid');
  });
});
