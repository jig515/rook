/**
 * Adapter registry. Every `*.js` file in this folder (except `_`-prefixed
 * helpers and this file) is auto-loaded and registered by its exported `type`.
 *
 * To add a new upstream family (another relay, a websocket bridge, a local
 * runtime), drop a file here exporting:
 *
 *   export const type = 'mything';
 *   export const label = 'My upstream';
 *   export const fields = [...];          // drives the UI form
 *   export async function listModels(provider) -> [{id}]
 *   export async function* chat(ctx) -> yields {delta|reasoning|usage|finish}
 *   export async function passthrough(ctx) -> Response   // optional
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const registry = new Map();

for (const file of fs.readdirSync(DIR)) {
  if (!file.endsWith('.js') || file.startsWith('_') || file === 'index.js') continue;
  try {
    const mod = await import(pathToFileURL(path.join(DIR, file)).href);
    if (!mod.type) continue;
    registry.set(mod.type, mod);
  } catch (e) {
    console.error(`[rook] failed to load adapter ${file}:`, e.message);
  }
}

export function getAdapter(type) {
  return registry.get(type) || null;
}

export function listAdapters() {
  return [...registry.values()].map((m) => ({
    type: m.type,
    label: m.label || m.type,
    fields: m.fields || [],
    passthrough: !!m.passthrough
  }));
}
