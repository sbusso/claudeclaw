/**
 * Extension system for MotherClaw.
 * Extensions register IPC handlers, startup hooks, DB schema,
 * and container env vars without modifying core files.
 */

export interface IpcHandler {
  (
    data: any,
    sourceGroup: string,
    isMain: boolean,
    deps: { sendMessage: (jid: string, text: string) => Promise<void> },
  ): Promise<void>;
}

export interface ExtensionStartupDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  findChannel: (jid: string) => any;
  logger: any;
}

export interface MotherClawExtension {
  name: string;
  ipcHandlers?: Record<string, IpcHandler>;
  onStartup?: (deps: ExtensionStartupDeps) => void;
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
