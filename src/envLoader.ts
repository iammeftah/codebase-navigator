/**
 * envLoader.ts
 *
 * Reads the .env file sitting next to the extension's package.json
 * (i.e. the extension's own install directory, NOT the user's workspace).
 *
 * Why the extension dir and not the workspace?
 * The key belongs to the developer (you), not the project being analysed.
 * Putting it next to package.json means one .env for all workspaces you open.
 *
 * Usage:
 *   GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxx
 *
 * The file is parsed once at activation and the result is cached in memory.
 * Lines starting with # are treated as comments and ignored.
 * Surrounding quotes on values are stripped.
 */

import * as fs   from 'fs';
import * as path from 'path';

let _cache: Record<string, string> | null = null;

/**
 * Load and parse the .env file next to the extension root.
 * @param extensionPath  `context.extensionPath` from the activate() call
 */
export function loadEnv(extensionPath: string): Record<string, string> {
  if (_cache) { return _cache; }

  const envPath = path.join(extensionPath, '.env');
  _cache = {};

  if (!fs.existsSync(envPath)) {
    // No .env present — silently return empty object.
    // The extension will still work; Groq just won't have a pre-loaded key.
    return _cache;
  }

  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) { continue; }    // skip blanks + comments

    const eq = line.indexOf('=');
    if (eq < 1) { continue; }                           // skip malformed lines

    const key   = line.slice(0, eq).trim();
    let   value = line.slice(eq + 1).trim();

    // Strip optional surrounding quotes: "value" or 'value'
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    _cache[key] = value;
  }

  return _cache;
}

/** Convenience helper — returns a single value or '' if not found. */
export function getEnv(extensionPath: string, key: string): string {
  return loadEnv(extensionPath)[key] ?? '';
}
