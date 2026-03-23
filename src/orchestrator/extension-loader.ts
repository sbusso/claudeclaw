/**
 * Extension loader for ClaudeClaw.
 * Scans extensions/claudeclaw-* for manifest.json files,
 * validates them, and dynamically imports their entry points.
 * Extensions self-register via registerChannel() or registerExtension() on import.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { logger } from './logger.js';
import { validateManifest, type ExtensionManifest, type LoadResult } from './extension-manifest.js';

// CODE_ROOT is where the ClaudeClaw code lives (for finding extensions/)
// In dev mode: process.cwd()
// In plugin mode: resolved from import.meta.url (the dist/ directory's parent)
function getCodeRoot(): string {
  // import.meta.url points to dist/orchestrator/extension-loader.js
  // Code root is two levels up from dist/orchestrator/
  const distDir = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(distDir, '..', '..');
}

export async function loadExtensions(): Promise<LoadResult[]> {
  const codeRoot = getCodeRoot();
  const extensionsDir = path.join(codeRoot, 'extensions');
  const results: LoadResult[] = [];

  if (!fs.existsSync(extensionsDir)) {
    logger.debug('No extensions directory found');
    return results;
  }

  const entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
  const extensionDirs = entries
    .filter(e => e.isDirectory() && e.name.startsWith('claudeclaw-'))
    .map(e => e.name)
    .sort();

  for (const dirName of extensionDirs) {
    const manifestPath = path.join(extensionsDir, dirName, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
      results.push({ name: dirName, status: 'failed', error: 'No manifest.json found' });
      continue;
    }

    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const { valid, error, manifest } = validateManifest(raw);

      if (!valid || !manifest) {
        results.push({ name: dirName, status: 'failed', error: `Invalid manifest: ${error}` });
        continue;
      }

      const entryPath = path.join(extensionsDir, dirName, manifest.entry);
      if (!fs.existsSync(entryPath)) {
        results.push({ name: dirName, status: 'failed', error: `Entry file not found: ${manifest.entry}` });
        continue;
      }

      // Dynamic import — extension self-registers on load
      await import(pathToFileURL(entryPath).href);

      results.push({ name: manifest.name, status: 'loaded' });
      logger.info({ extension: manifest.name, type: manifest.type, version: manifest.version }, 'Extension loaded');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ name: dirName, status: 'failed', error: message });
      logger.error({ extension: dirName, error: message }, 'Failed to load extension');
    }
  }

  const loaded = results.filter(r => r.status === 'loaded').length;
  const failed = results.filter(r => r.status === 'failed').length;
  if (loaded > 0 || failed > 0) {
    logger.info({ loaded, failed }, 'Extension loading complete');
  }

  return results;
}

/**
 * Collect allowedDomains from all installed extension manifests.
 * Returns deduplicated list of domains that extensions need for network access.
 */
export function getExtensionAllowedDomains(): string[] {
  const codeRoot = getCodeRoot();
  const extensionsDir = path.join(codeRoot, 'extensions');
  const domains: string[] = [];

  if (!fs.existsSync(extensionsDir)) return domains;

  const entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('claudeclaw-')) continue;
    const manifestPath = path.join(extensionsDir, entry.name, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const { valid, manifest } = validateManifest(raw);
      if (valid && manifest?.provides?.allowedDomains) {
        domains.push(...manifest.provides.allowedDomains);
      }
    } catch {
      // Skip invalid manifests
    }
  }

  return [...new Set(domains)];
}
