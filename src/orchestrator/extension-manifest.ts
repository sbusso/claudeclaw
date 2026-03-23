/**
 * Extension manifest schema for installable ClaudeClaw extensions.
 * Each extension has a manifest.json in its root directory.
 */

export interface ExtensionManifest {
  name: string;
  version: string;
  type: 'channel' | 'extension';
  entry: string;
  dependencies?: Record<string, string>;
  provides?: {
    channel?: string;
    dbSchema?: boolean;
    envKeys?: string[];
    containerEnvKeys?: string[];
    allowedDomains?: string[];   // Network domains this extension needs (merged into sandbox settings)
  };
  skills?: string[];
  agents?: string[];
  agentSkills?: string[];
  commands?: string[];
  hooks?: {
    postInstall?: string;
    postUninstall?: string;
  };
  requires?: string[];
}

export interface LoadResult {
  name: string;
  status: 'loaded' | 'failed';
  error?: string;
}

export function validateManifest(data: unknown): { valid: boolean; error?: string; manifest?: ExtensionManifest } {
  if (!data || typeof data !== 'object') return { valid: false, error: 'Manifest is not an object' };
  const d = data as Record<string, unknown>;
  if (typeof d.name !== 'string' || !d.name) return { valid: false, error: 'Missing or invalid "name"' };
  if (typeof d.version !== 'string') return { valid: false, error: 'Missing or invalid "version"' };
  if (d.type !== 'channel' && d.type !== 'extension') return { valid: false, error: '"type" must be "channel" or "extension"' };
  if (typeof d.entry !== 'string' || !d.entry) return { valid: false, error: 'Missing or invalid "entry"' };
  return { valid: true, manifest: data as ExtensionManifest };
}
