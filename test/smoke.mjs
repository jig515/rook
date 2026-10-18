/**
 * End-to-end smoke test. Assumes the gateway is running.
 *   node test/smoke.mjs [http://127.0.0.1:8790] [adminKey]
 *
 * Boots a mock upstream in-process and points throwaway "smoke-*" providers at
 * it, so every adapter gets exercised against real HTTP without touching the
 * user's own config.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock, state as mockState } from './mock-upstream.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.argv[2] || 'http://127.0.0.1:8790').replace(/\/+$/, '');
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'config.json'), 'utf8'));
const ADMIN = process.argv[3] || cfg.adminKey;
const API = cfg.apiKey;

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✕ ' + name + (extra ? '  → ' + extra : ''));
  }
}

const admin = (p, init = {}) =>
  fetch(BASE + p, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN, ...(init.headers || {}) }
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

const chat = (body, headers = {}) =>
  fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + API, ...headers },
    body: JSON.stringify(body)
  });

async function streamText(res) {
  const raw = await res.text();
  let text = '';
  let reasoning = '';
  let toolCalls = 0;
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const p = line.slice(6).trim();
    if (p === '[DONE]') continue;
    let o;
    try {
      o = JSON.parse(p);
    } catch {
      continue;
    }
    const d = o.choices?.[0]?.delta;
    if (d?.content) text += d.content;
    if (d?.reasoning_content) reasoning += d.reasoning_content;
    if (Array.isArray(d?.tool_calls)) toolCalls += d.tool_calls.length;
  }
  return { text, reasoning, toolCalls, raw };
}

const mock = await startMock(0);
const MOCK_V1 = `http://127.0.0.1:${mock.port}/v1`;
const SLOW_FLAG = path.join(HERE, '.slow-cli.flag');

/* ------------------------------------------------------------- providers */

function userMsgs(content = 'hi') {
  return [{ role: 'user', content }];
}

const SMOKE_PROVIDERS = [
  {
    id: 'smoke-cli',
    name: 'Smoke echo CLI',
    type: 'cli',
    enabled: true,
    command: process.execPath,
    args: [path.join(HERE, 'echo-cli.mjs'), '{{model}}'],
    inputFormat: 'transcript',
    parser: 'claude-stream',
    thinking: { style: 'none' },
    models: [
      { id: 'claude', alias: 'echo', thinkingLevel: 'off', parser: 'claude-stream' },
      { id: 'raw', alias: 'echo-raw', thinkingLevel: 'off', parser: 'raw' },
      { id: 'json-lines', alias: 'echo-jsonl', thinkingLevel: 'off', parser: 'json-lines' },
      { id: 'json-object', alias: 'echo-jsono', thinkingLevel: 'off', parser: 'json-object' }
    ]
  },
  {
    id: 'smoke-openai',
    name: 'Smoke OpenAI relay',
    type: 'openai',
    enabled: true,
    baseUrl: MOCK_V1,
    apiKey: 'up-key',
    thinking: { style: 'reasoning_effort' },
    models: [
      { id: 'mock-a', alias: 'mock-a', thinkingLevel: 'medium' },
      { id: 'tools', alias: 'mock-tools', thinkingLevel: 'off' },
      { id: 'boom', alias: 'mock-boom', thinkingLevel: 'off' },
      { id: 'ratelimit', alias: 'mock-429', thinkingLevel: 'off' },
      { id: 'badrequest', alias: 'mock-400', thinkingLevel: 'off' }
    ]
  },
  {
    id: 'smoke-gemini',
    name: 'Smoke gemini-named model',
    type: 'openai',
    enabled: true,
    baseUrl: MOCK_V1,
    apiKey: 'up-key',
    thinking: { style: 'none' },
    models: [{ id: 'google/gemini-3.8-flash', alias: 'gemini-test', thinkingLevel: 'off' }]
  },
  {
    id: 'smoke-slow',
    name: 'Smoke slow upstream',
    type: 'openai',
    enabled: true,
    baseUrl: MOCK_V1,
    apiKey: 'up-key',
    timeoutMs: 600,
    thinking: { style: 'none' },
    models: [{ id: 'slow', alias: 'mock-slow', thinkingLevel: 'off' }]
  },
  {
    id: 'smoke-proxy',
    name: 'Smoke proxy',
    type: 'proxy',
    enabled: true,
    baseUrl: MOCK_V1,
    apiKey: 'up-key',
    authStyle: 'bearer',
    models: [{ id: 'raw', alias: 'mock-passthrough', thinkingLevel: 'off' }]
  },
  {
    id: 'smoke-slowcli',
    name: 'Smoke slow CLI',
    type: 'cli',
    enabled: true,
    command: process.execPath,
    args: [path.join(HERE, 'slow-cli.mjs'), SLOW_FLAG],
    parser: 'claude-stream',
    models: [{ id: 'slow-cli', alias: 'slow-cli', thinkingLevel: 'off' }]
  },
  {
    id: 'smoke-broken',
    name: 'Smoke broken upstream',
    type: 'openai',
    enabled: true,
    // no baseUrl on purpose: the gateway must fail cleanly, not crash
    models: [{ id: 'x', alias: 'broken', thinkingLevel: 'off' }]
  },
  {
    id: 'smoke-dup',
    name: 'Smoke duplicate alias',
    type: 'cli',
    enabled: true,
    command: process.execPath,
    args: [path.join(HERE, 'echo-cli.mjs'), '{{model}}'],
    parser: 'claude-stream',
    models: [{ id: 'claude', alias: 'echo', thinkingLevel: 'off' }]
  }
];

const originalProviders = (await admin('/admin/api/state')).json.config.providers;
const nonSmoke = originalProviders.filter((p) => !p.id.startsWith('smoke-'));
const setProviders = (list) =>
  admin('/admin/api/config', { method: 'PUT', body: JSON.stringify({ providers: list }) });
await setProviders([...nonSmoke, ...SMOKE_PROVIDERS]);

console.log(`\nrook smoke @ ${BASE}\n  mock upstream @ ${MOCK_V1}\n`);

/* ---------------------------------------------------------------- basics */

const health = await fetch(BASE + '/health').then((r) => r.json());
ok('health', health.status === 'ok', JSON.stringify(health));

const stateRes = await admin('/admin/api/state');
ok('admin state', stateRes.status === 200 && !!stateRes.json.config, String(stateRes.status));

const badAuth = await fetch(BASE + '/admin/api/state', { headers: { 'x-admin-key': 'nope' } });
ok('admin rejects bad key', badAuth.status === 401, String(badAuth.status));

const badApiKey = await fetch(BASE + '/v1/models', { headers: { authorization: 'Bearer wrong' } });
ok('v1 rejects bad api key', badApiKey.status === 401, String(badApiKey.status));

const models = await fetch(BASE + '/v1/models', { headers: { authorization: 'Bearer ' + API } }).then((r) => r.json());
ok('catalogue lists smoke models', models.data?.some((m) => m.id === 'mock-a'));
ok('catalogue shape', models.object === 'list' && models.data[0].object === 'model');

const oneModel = await fetch(BASE + '/v1/models/mock-a', { headers: { authorization: 'Bearer ' + API } }).then((r) => r.json());
ok('model lookup by id', oneModel.id === 'mock-a', JSON.stringify(oneModel));

/* ------------------------------------------------------------------- cli */

{
  const r = await chat({ model: 'echo', messages: userMsgs('hi there'), stream: false });
  const j = await r.json();
  ok('cli non-stream 200', r.status === 200, JSON.stringify(j).slice(0, 200));
  ok('cli content', j.choices?.[0]?.message?.content?.startsWith('rook ok'), JSON.stringify(j.choices?.[0]?.message));
  ok('cli usage normalized', typeof j.usage?.total_tokens === 'number');

  const r2 = await chat({ model: 'echo', messages: userMsgs('stream me'), stream: true });
  ok('cli stream content-type', (r2.headers.get('content-type') || '').includes('text/event-stream'));
  const s = await streamText(r2);
  ok('cli stream assembled', s.text.startsWith('rook ok') && !s.text.includes('rook okrook ok'), JSON.stringify(s.text));
  ok('cli stream [DONE]', s.raw.includes('data: [DONE]'));
  ok('cli stream role chunk', s.raw.includes('"role":"assistant"'));
}

// every stdout dialect the cli adapter knows how to read
for (const [alias, label] of [
  ['echo-raw', 'raw'],
  ['echo-jsonl', 'json-lines'],
  ['echo-jsono', 'json-object']
]) {
  const r = await chat({ model: alias, messages: userMsgs('parser check'), stream: false });
  const j = await r.json();
  ok(`cli parser ${label}`, r.status === 200 && j.choices?.[0]?.message?.content?.startsWith('rook ok'), JSON.stringify(j).slice(0, 180));
}

{
  const big = 'x'.repeat(120000);
  const r = await chat({ model: 'echo', messages: [{ role: 'user', content: big }], stream: false });
  const j = await r.json();
  const txt = j.choices?.[0]?.message?.content || '';
  ok('cli handles a 120k-char prompt', r.status === 200 && /1200\d\d chars/.test(txt), txt.slice(0, 80));

  const statuses = await Promise.all(
    [1, 2, 3, 4, 5].map((i) =>
      chat({ model: 'echo', messages: userMsgs('c' + i), stream: false }).then((x) => x.status)
    )
  );
  ok('5 concurrent cli requests', statuses.every((x) => x === 200), JSON.stringify(statuses));
}

/* --------------------------------------------------- openai relay (mock) */

{
  const r = await chat({ model: 'mock-a', messages: userMsgs(), stream: false });
  const j = await r.json();
  ok('openai non-stream 200', r.status === 200, JSON.stringify(j).slice(0, 200));
  ok('openai content', j.choices?.[0]?.message?.content === 'mock answer', JSON.stringify(j.choices?.[0]?.message));
  ok('openai usage passthrough', j.usage?.total_tokens === 13, JSON.stringify(j.usage));
  ok('openai provider echo', j.rook?.provider === 'smoke-openai', JSON.stringify(j.rook));
  ok('relay extras forwarded (non-stream)', j.modelVersion === 'mock-v1.2.3', JSON.stringify(j.modelVersion));

  const s = await streamText(await chat({ model: 'mock-a', messages: userMsgs(), stream: true }));
  ok('openai stream text', s.text === 'mock answer', JSON.stringify(s.text));
  ok('relay extras forwarded (stream)', s.raw.includes('mock-v1.2.3'), 'modelVersion was dropped');
  ok('relay fingerprint kept', s.raw.includes('fp_mock'), 'system_fingerprint was overwritten');
}

{
  const r = await chat({ model: 'mock-a', messages: userMsgs(), stream: false, reasoning_effort: 'high' });
  await r.json();
  ok('thinking → reasoning_effort', mockState.last.body?.reasoning_effort === 'high', JSON.stringify(mockState.last.body));

  const r2 = await chat({ model: 'mock-a', messages: userMsgs(), stream: false, thinking_level: 'off' });
  await r2.json();
  ok('thinking off drops param', !('reasoning_effort' in (mockState.last.body || {})), JSON.stringify(mockState.last.body));

  const r3 = await chat({ model: 'mock-a', messages: userMsgs(), stream: false, stream_options: { include_usage: true } });
  await r3.json();
  ok('sampler params forwarded', mockState.last.body?.stream === true);
}

{
  const r = await chat({ model: 'mock-boom', messages: userMsgs(), stream: false });
  ok('upstream 401 → 502 (our config problem)', r.status === 502, String(r.status));
  const j = await r.json();
  ok('upstream error message kept', /upstream 401/.test(j.error?.message || ''), JSON.stringify(j.error));

  const r2 = await chat({ model: 'mock-429', messages: userMsgs(), stream: false });
  ok('upstream 429 passes through', r2.status === 429, String(r2.status));
  await r2.text();

  const t0 = Date.now();
  const r3 = await chat({ model: 'mock-slow', messages: userMsgs(), stream: false });
  const ms = Date.now() - t0;
  ok('hung upstream → 504', r3.status === 504, String(r3.status));
  ok('timeout fires near provider.timeoutMs', ms < 3000, ms + 'ms');
  await r3.text();
}

{
  const r = await chat({ model: 'mock-tools', messages: userMsgs(), stream: false });
  const j = await r.json();
  const tc = j.choices?.[0]?.message?.tool_calls?.[0];
  ok('tool_calls non-stream stitched', tc?.function?.name === 'get_weather', JSON.stringify(tc));
  ok('tool_calls arguments stitched', tc?.function?.arguments === '{"city":"SH"}', JSON.stringify(tc));
  ok('finish_reason tool_calls', j.choices?.[0]?.finish_reason === 'tool_calls', j.choices?.[0]?.finish_reason);

  const s = await streamText(await chat({ model: 'mock-tools', messages: userMsgs(), stream: true }));
  ok('tool_calls streamed', s.toolCalls === 3, String(s.toolCalls));
}

/* ------------------------------------------------------ pass-through */

{
  // The gateway is a courier: values reach the upstream exactly as the client
  // sent them, even ones an upstream might reject.
  const r3 = await chat({ model: 'mock-a', messages: userMsgs(), temperature: 1.7, seed: 4242, min_p: 0.03, stream: false });
  await r3.text();
  ok('temperature forwarded unchanged', mockState.last.body?.temperature === 1.7, String(mockState.last.body?.temperature));
  ok('unknown sampler fields forwarded', mockState.last.body?.seed === 4242 && mockState.last.body?.min_p === 0.03, JSON.stringify({ seed: mockState.last.body?.seed, min_p: mockState.last.body?.min_p }));
  ok('routing keys stripped', !('thinking_level' in (mockState.last.body || {})));

  const r4 = await chat({ model: 'gemini-test', messages: userMsgs(), temperature: 1.6, stream: false });
  await r4.text();
  ok('gemini model is not second-guessed', mockState.last.body?.temperature === 1.6, String(mockState.last.body?.temperature));

  const r5 = await chat({ model: 'mock-400', messages: userMsgs(), stream: false });
  await r5.text();
  ok('upstream 400 passes through', r5.status === 400, String(r5.status));
}

/* -------------------------------------------------------------- proxy */

{
  const r = await chat({ model: 'mock-passthrough', messages: userMsgs(), stream: false, temperature: 0.7 });
  const j = await r.json();
  ok('proxy passthrough 200', r.status === 200, JSON.stringify(j).slice(0, 200));
  ok('proxy returned upstream body untouched', j.proxied === true, JSON.stringify(j));
  ok('proxy rewrote model to upstream id', j.received?.model === 'raw', JSON.stringify(j.received?.model));
  ok('proxy passed sampler params', j.received?.temperature === 0.7, JSON.stringify(j.received));
  ok('proxy auth header', String(mockState.last.headers.authorization || '').includes('up-key'), String(mockState.last.headers.authorization));
}

/* --------------------------------------------------- legacy completions */

{
  const r = await fetch(BASE + '/v1/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + API },
    body: JSON.stringify({ model: 'echo', prompt: 'legacy call', max_tokens: 32 })
  });
  const j = await r.json();
  ok('legacy /v1/completions', r.status === 200 && j.choices?.[0]?.text?.startsWith('rook ok'), `${r.status} ${JSON.stringify(j).slice(0, 160)}`);
  ok('legacy completions object shape', j.object === 'text_completion', j.object);
}

/* -------------------------------------------------------- resilience */

{
  const names = (await fetch(BASE + '/v1/models', { headers: { authorization: 'Bearer ' + API } }).then((r) => r.json())).data.map((m) => m.id);
  ok('duplicate alias appears once', names.filter((n) => n === 'echo').length === 1, JSON.stringify(names));

  const r = await chat({ model: 'broken', messages: userMsgs(), stream: false });
  ok('misconfigured upstream → 5xx json', r.status >= 500 && r.status < 600, String(r.status));
  const j = await r.json().catch(() => null);
  ok('misconfigured upstream error shape', !!j?.error?.message, JSON.stringify(j));
  const alive = await fetch(BASE + '/health').then((x) => x.status);
  ok('gateway alive after upstream error', alive === 200, String(alive));

  if (fs.existsSync(SLOW_FLAG)) fs.unlinkSync(SLOW_FLAG);
  const ac = new AbortController();
  try {
    const res = await fetch(BASE + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + API },
      body: JSON.stringify({ model: 'slow-cli', messages: userMsgs(), stream: true }),
      signal: ac.signal
    });
    const reader = res.body.getReader();
    await reader.read(); // first chunk proves the child process is running
    ac.abort();
    await reader.read().catch(() => {});
  } catch {
    /* the abort surfaces here */
  }
  await new Promise((r) => setTimeout(r, 4000));
  ok('abort kills the child process', !fs.existsSync(SLOW_FLAG), 'sentinel written: process survived the abort');
  if (fs.existsSync(SLOW_FLAG)) fs.unlinkSync(SLOW_FLAG);
  ok('gateway alive after client abort', (await fetch(BASE + '/health').then((x) => x.status)) === 200);
}

/* ----------------------------------------------------------- security */

{
  const crossAdmin = await fetch(BASE + '/admin/api/state', {
    headers: { 'x-admin-key': ADMIN, origin: 'http://evil.example' }
  });
  ok('admin rejects cross-origin', crossAdmin.status === 403, String(crossAdmin.status));

  const trav = await Promise.all([
    fetch(BASE + '/..%2F..%2Fconfig.json'),
    fetch(BASE + '/..%5C..%5Cconfig.json'),
    fetch(BASE + '/%2e%2e/%2e%2e/config.json')
  ]);
  ok('path traversal blocked', trav.every((r) => [400, 403, 404].includes(r.status)), trav.map((r) => r.status).join('/'));

  const savedKey = (await admin('/admin/api/state')).json.config.apiKey;
  try {
    await admin('/admin/api/config', { method: 'PUT', body: JSON.stringify({ apiKey: '' }) });
    const evil = await fetch(BASE + '/v1/models', { headers: { origin: 'http://evil.example' } });
    const loop = await fetch(BASE + '/v1/models', { headers: { origin: 'http://127.0.0.1:8000' } });
    const cli = await fetch(BASE + '/v1/models');
    ok('no key + foreign origin → 403', evil.status === 403, String(evil.status));
    ok('no key + loopback origin → 200', loop.status === 200, String(loop.status));
    ok('no key + no origin (cli) → 200', cli.status === 200, String(cli.status));
  } finally {
    await admin('/admin/api/config', { method: 'PUT', body: JSON.stringify({ apiKey: savedKey }) });
  }
  ok('api key restored', (await admin('/admin/api/state')).json.config.apiKey === savedKey);
}

/* ------------------------------------------------------------ cleanup */

// empty configuration is a legitimate state (fresh install)
await setProviders([]);
{
  const empty = await fetch(BASE + '/v1/models', { headers: { authorization: 'Bearer ' + API } }).then((r) => r.json());
  ok('empty catalogue is a valid list', Array.isArray(empty.data) && empty.data.length === 0, JSON.stringify(empty));
  const noModel = await chat({ messages: userMsgs(), stream: false });
  const j = await noModel.json();
  ok('no model configured → 400', noModel.status === 400 && j.error?.code === 'no_model', `${noModel.status} ${JSON.stringify(j)}`);
}

await setProviders(nonSmoke);
ok('cleanup', !(await admin('/admin/api/state')).json.config.providers.some((p) => p.id.startsWith('smoke-')));

mock.server.close();

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
