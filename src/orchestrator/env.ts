/**
 * Read environment variables from .env file.
 * Secrets stay in .env, never in process.env.
 */
import fs from 'fs';
import path from 'path';

export function readEnvFile(keys: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const envPath = path.join(process.cwd(), '.env');

  if (!fs.existsSync(envPath)) return result;

  const content = fs.readFileSync(envPath, 'utf-8');
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (keys.includes(key)) {
      result[key] = value;
    }
  }

  return result;
}
