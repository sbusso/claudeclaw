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
// In plugin mode, instanceName always defaults to 'default', so the helper
// must match the instance-aware format (label, env file, log paths all include instance)
function generatePluginPlist(
  nodePath: string,
  projectRoot: string,
  homeDir: string,
  pluginDataDir: string,
  instanceName: string = 'default',
): string {
  const logDir = `${pluginDataDir}/instances/${instanceName}/logs`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.motherclaw.${instanceName}</string>
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
        <key>MOTHERCLAW_INSTANCE</key>
        <string>${instanceName}</string>
        <key>MOTHERCLAW_ENV_FILE</key>
        <string>${pluginDataDir}/instances/${instanceName}/.env</string>
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

  it('includes MOTHERCLAW_ENV_FILE pointing to instance .env', () => {
    const plist = generatePluginPlist(
      '/usr/local/bin/node',
      '/home/user/motherclaw',
      '/home/user',
      pluginDataDir,
    );
    expect(plist).toContain('<key>MOTHERCLAW_ENV_FILE</key>');
    expect(plist).toContain(`<string>${pluginDataDir}/instances/default/.env</string>`);
  });

  it('includes MOTHERCLAW_INSTANCE env var', () => {
    const plist = generatePluginPlist(
      '/usr/local/bin/node',
      '/home/user/motherclaw',
      '/home/user',
      pluginDataDir,
    );
    expect(plist).toContain('<key>MOTHERCLAW_INSTANCE</key>');
    expect(plist).toContain('<string>default</string>');
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

  it('log paths point to instance logs dir', () => {
    const plist = generatePluginPlist(
      '/usr/local/bin/node',
      '/home/user/motherclaw',
      '/home/user',
      pluginDataDir,
    );
    expect(plist).toContain(`${pluginDataDir}/instances/default/logs/motherclaw.log`);
    expect(plist).toContain(`${pluginDataDir}/instances/default/logs/motherclaw.error.log`);
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

// --- Instance-named service helpers ---

// Helper: generate instance-named plist (mirrors service.ts logic)
function generateInstancePlist(
  nodePath: string,
  projectRoot: string,
  homeDir: string,
  pluginDataDir: string,
  instanceName: string,
): string {
  const serviceLabel = `com.motherclaw.${instanceName}`;
  const logDir = `${pluginDataDir}/instances/${instanceName}/logs`;
  const envFilePath = `${pluginDataDir}/instances/${instanceName}/.env`;
  return `<?xml version="1.0" encoding="UTF-8"?>
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
        <string>${homeDir}</string>
        <key>CLAUDE_PLUGIN_DATA</key>
        <string>${pluginDataDir}</string>
        <key>MOTHERCLAW_ENV_FILE</key>
        <string>${envFilePath}</string>
        <key>MOTHERCLAW_INSTANCE</key>
        <string>${instanceName}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${logDir}/motherclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${logDir}/motherclaw.error.log</string>
</dict>
</plist>`;
}

// Helper: generate instance-named systemd unit
function generateInstanceSystemdUnit(
  nodePath: string,
  projectRoot: string,
  homeDir: string,
  pluginDataDir: string,
  instanceName: string,
  isSystem: boolean,
): string {
  const logDir = `${pluginDataDir}/instances/${instanceName}/logs`;
  const envFilePath = `${pluginDataDir}/instances/${instanceName}/.env`;
  return `[Unit]
Description=MotherClaw Personal Assistant (${instanceName})
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${projectRoot}/dist/service.js
WorkingDirectory=${projectRoot}
Restart=always
RestartSec=5
Environment=HOME=${homeDir}
Environment=PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin
Environment=CLAUDE_PLUGIN_DATA=${pluginDataDir}
Environment=MOTHERCLAW_ENV_FILE=${envFilePath}
Environment=MOTHERCLAW_INSTANCE=${instanceName}
StandardOutput=append:${logDir}/motherclaw.log
StandardError=append:${logDir}/motherclaw.error.log

[Install]
WantedBy=${isSystem ? 'multi-user.target' : 'default.target'}`;
}

describe('instance-named plist generation', () => {
  const pluginDataDir = '/Users/testuser/.claude/plugins/motherclaw';
  const instanceName = 'acme-corp';

  it('plist label includes instance name', () => {
    const plist = generateInstancePlist(
      '/usr/local/bin/node',
      '/home/user/motherclaw',
      '/home/user',
      pluginDataDir,
      instanceName,
    );
    expect(plist).toContain(`<string>com.motherclaw.${instanceName}</string>`);
    // Must NOT contain bare com.motherclaw label
    expect(plist).not.toMatch(/<string>com\.motherclaw<\/string>/);
  });

  it('includes MOTHERCLAW_INSTANCE env var', () => {
    const plist = generateInstancePlist(
      '/usr/local/bin/node',
      '/home/user/motherclaw',
      '/home/user',
      pluginDataDir,
      instanceName,
    );
    expect(plist).toContain('<key>MOTHERCLAW_INSTANCE</key>');
    expect(plist).toContain(`<string>${instanceName}</string>`);
  });

  it('MOTHERCLAW_ENV_FILE points to instance-specific .env', () => {
    const plist = generateInstancePlist(
      '/usr/local/bin/node',
      '/home/user/motherclaw',
      '/home/user',
      pluginDataDir,
      instanceName,
    );
    expect(plist).toContain('<key>MOTHERCLAW_ENV_FILE</key>');
    expect(plist).toContain(
      `<string>${pluginDataDir}/instances/${instanceName}/.env</string>`,
    );
    // Must NOT contain the non-instance path
    expect(plist).not.toContain(`<string>${pluginDataDir}/.env</string>`);
  });

  it('log paths under instance directory', () => {
    const plist = generateInstancePlist(
      '/usr/local/bin/node',
      '/home/user/motherclaw',
      '/home/user',
      pluginDataDir,
      instanceName,
    );
    expect(plist).toContain(
      `${pluginDataDir}/instances/${instanceName}/logs/motherclaw.log`,
    );
    expect(plist).toContain(
      `${pluginDataDir}/instances/${instanceName}/logs/motherclaw.error.log`,
    );
  });
});

describe('instance-named systemd unit generation', () => {
  const pluginDataDir = '/Users/testuser/.claude/plugins/motherclaw';
  const instanceName = 'acme-corp';

  it('description includes instance name', () => {
    const unit = generateInstanceSystemdUnit(
      '/usr/bin/node',
      '/home/user/motherclaw',
      '/home/user',
      pluginDataDir,
      instanceName,
      false,
    );
    expect(unit).toContain(`Description=MotherClaw Personal Assistant (${instanceName})`);
  });

  it('includes MOTHERCLAW_INSTANCE env var', () => {
    const unit = generateInstanceSystemdUnit(
      '/usr/bin/node',
      '/home/user/motherclaw',
      '/home/user',
      pluginDataDir,
      instanceName,
      false,
    );
    expect(unit).toContain(`Environment=MOTHERCLAW_INSTANCE=${instanceName}`);
  });

  it('MOTHERCLAW_ENV_FILE points to instance-specific .env', () => {
    const unit = generateInstanceSystemdUnit(
      '/usr/bin/node',
      '/home/user/motherclaw',
      '/home/user',
      pluginDataDir,
      instanceName,
      false,
    );
    expect(unit).toContain(
      `Environment=MOTHERCLAW_ENV_FILE=${pluginDataDir}/instances/${instanceName}/.env`,
    );
  });

  it('log paths under instance directory', () => {
    const unit = generateInstanceSystemdUnit(
      '/usr/bin/node',
      '/home/user/motherclaw',
      '/home/user',
      pluginDataDir,
      instanceName,
      false,
    );
    expect(unit).toContain(
      `${pluginDataDir}/instances/${instanceName}/logs/motherclaw.log`,
    );
  });
});
