import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const CONFIG_PATH = path.join(ROOT, 'config.json');

const rnd = (n = 24) =>
  crypto.randomBytes(32).toString('base64url').replace(/[-_]/g, '').slice(0, n);

export function defaultConfig() {
  return {
    port: 8765,
    host: '127.0.0.1',
    apiKey: 'sk-rook-' + rnd(28),
    adminKey: rnd(20),
    timeoutMs: 240000,
    idleTimeoutMs: 60000,
    proxy: '',
    allowOrigins: ['*'],
    logLimit: 300,
    providers: [
      {
        id: 'claude-cli',
        name: 'Claude Code CLI',
        type: 'cli',
        enabled: false,
        command: 'claude',
        args: ['-p', '--model', '{{model}}', '--output-format', 'stream-json', '--verbose'],
        inputFormat: 'transcript',
        parser: 'claude-stream',
        cwd: '',
        env: {},
        thinking: { style: 'none' },
        models: [
          { id: 'claude-sonnet-4-5', alias: 'sonnet', thinkingLevel: 'off' },
          { id: 'claude-opus-4-1', alias: 'opus', thinkingLevel: 'off' }
        ]
      },
      {
        id: 'relay',
        name: 'Example relay',
        type: 'openai',
        enabled: false,
        baseUrl: 'https://api.example.com/v1',
        apiKey: '',
        headers: {},
        thinking: { style: 'reasoning_effort' },
        models: [
          { id: 'gpt-5', alias: 'gpt-5', thinkingLevel: 'medium' }
        ]
      }
    ]
  };
}

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch;
  if (patch && typeof patch === 'object' && base && typeof base === 'object' && !Array.isArray(base)) {
    const out = { ...base };
    for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(base[k], v);
    return out;
  }
  return patch === undefined ? base : patch;
}

let current = null;

export function load() {
  if (!fs.existsSync(CONFIG_PATH)) {
    current = defaultConfig();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2), 'utf8');
    console.log(`[rook] created ${CONFIG_PATH}`);
  } else {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      current = deepMerge(defaultConfig(), raw);
    } catch (e) {
      console.error('[rook] config.json is not valid JSON, using defaults:', e.message);
      current = defaultConfig();
    }
  }
  if (!Array.isArray(current.providers)) current.providers = [];
  return current;
}

export function get() {
  if (!current) load();
  return current;
}

export function save(patch) {
  current = deepMerge(get(), patch || {});
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2), 'utf8');
  return current;
}

/** Flatten enabled providers' models into the public catalogue. */
export function catalogue() {
  const cfg = get();
  const out = [];
  const seen = new Set();
  for (const p of cfg.providers) {
    if (!p.enabled) continue;
    for (const m of p.models || []) {
      const name = m.alias || m.id;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push({
        name,
        providerId: p.id,
        providerName: p.name,
        upstreamId: m.id,
        thinkingLevel: m.thinkingLevel || 'off'
      });
    }
  }
  return out;
}

export function resolveModel(modelName) {
  const list = catalogue();
  if (!modelName) return list[0] || null;
  return (
    list.find((m) => m.name === modelName) ||
    list.find((m) => m.upstreamId === modelName) ||
    list.find((m) => m.name.toLowerCase() === String(modelName).toLowerCase()) ||
    null
  );
}

export function providerTarget(providerId, modelName) {
  const p = get().providers.find((x) => x.id === providerId);
  if (!p) return null;
  const m = (p.models || []).find((x) => (x.alias || x.id) === modelName || x.id === modelName);
  return { provider: p, model: m || { id: modelName } };
}
