/**
 * ClaudeClaw Plugin — Claude Code plugin entry point.
 * Loaded by Claude Code via --plugin-dir. Must NOT block.
 *
 * The background service (message loop, channels, agents) runs separately
 * via `node dist/service.js`, managed by launchd or systemd.
 * See /setup skill to configure the background service.
 */

export const name = 'claudeclaw';
export const version = '0.1.0';
export const description =
  'Persistent agent orchestrator for Claude Code. Multi-channel message routing, triage, and SWE task management.';
