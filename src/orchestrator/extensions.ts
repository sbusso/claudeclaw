/**
 * Extension system for MotherClaw.
 * Extensions register IPC handlers, startup hooks, DB schema,
 * container env vars, and routing hooks without modifying core files.
 */

import type {
  IngestionPreHook,
  IngestionEnvelope,
  OutboundPreHook,
  OutboundEnvelope,
  MessageIngestion,
  MessageRouter,
} from './types.js';

export interface IpcHandler {
  (
    data: any,
    sourceGroup: string,
    isMain: boolean,
    deps: { sendMessage: (jid: string, text: string) => Promise<void> },
  ): Promise<void>;
}

export interface ExtensionStartupDeps {
  ingestion: MessageIngestion;
  router: MessageRouter;
  logger: any;
  /** @deprecated Use router.send() instead */
  sendMessage: (jid: string, text: string) => Promise<void>;
  /** @deprecated Use router directly */
  findChannel: (jid: string) => any;
}

export interface ExtensionHooks {
  preIngest?: IngestionPreHook;
  postIngest?: (envelope: IngestionEnvelope) => void;
  preRoute?: OutboundPreHook;
  postRoute?: (envelope: OutboundEnvelope) => void;
}

export interface MotherClawExtension {
  name: string;
  ipcHandlers?: Record<string, IpcHandler>;
  onStartup?: (deps: ExtensionStartupDeps) => void;
  hooks?: ExtensionHooks;
  dbSchema?: string[];
  dbMigrations?: string[];
  envKeys?: string[];
  containerEnvKeys?: string[];
}

const extensions: MotherClawExtension[] = [];

export function registerExtension(ext: MotherClawExtension): void {
  extensions.push(ext);
}

export function getExtensions(): readonly MotherClawExtension[] {
  return extensions;
}

export function getExtensionIpcHandlers(): Record<string, IpcHandler> {
  const handlers: Record<string, IpcHandler> = {};
  for (const ext of extensions) {
    if (ext.ipcHandlers) {
      Object.assign(handlers, ext.ipcHandlers);
    }
  }
  return handlers;
}

export function getExtensionEnvKeys(): string[] {
  return extensions.flatMap((e) => e.envKeys || []);
}

export function getExtensionContainerEnvKeys(): string[] {
  return extensions.flatMap((e) => e.containerEnvKeys || []);
}

export function getExtensionDbSchema(): string[] {
  return extensions.flatMap((e) => e.dbSchema || []);
}

export function getExtensionDbMigrations(): string[] {
  return extensions.flatMap((e) => e.dbMigrations || []);
}

export function callExtensionStartup(deps: ExtensionStartupDeps): void {
  for (const ext of extensions) {
    if (ext.onStartup) {
      ext.onStartup(deps);
    }
  }
}

/**
 * Wire extension hooks into the ingestion and router services.
 * Called after services are created but before the message loop starts.
 */
export function wireExtensionHooks(
  ingestion: MessageIngestion,
  router: MessageRouter,
): void {
  for (const ext of extensions) {
    if (!ext.hooks) continue;
    if (ext.hooks.preIngest) ingestion.addPreHook(ext.hooks.preIngest);
    if (ext.hooks.postIngest) ingestion.addPostHook(ext.hooks.postIngest);
    if (ext.hooks.preRoute) router.addPreHook(ext.hooks.preRoute);
    if (ext.hooks.postRoute) router.addPostHook(ext.hooks.postRoute);
  }
}
