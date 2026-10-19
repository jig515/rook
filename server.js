import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ROOT, CONFIG_PATH, load as loadConfig, get as getConfig, save as saveConfig, catalogue } from './src/config.js';
import { listAdapters, getAdapter } from './src/adapters/index.js';
import { runChat, targetFor, wantsPassthrough, HttpError, pickLevel } from './src/engine.js';
import * as log from './src/log.js';
import { LEVELS, normalizeLevel } from './src/thinking.js';
import { refreshProxyEnv, proxyStatus } from './src/net.js';

const PUBLIC = path.join(ROOT, 'public');
const VERSION = '0.1.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

/* ------------------------------------------------------------------ utils */

function sendJson(res, status, obj, extraHeaders = {}) {
  if (res.writableEnded || res.destroyed) return;
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    ...extraHeaders
  });
  res.end(body);
}

function fail(res, e, extraHeaders) {
  let status = e instanceof HttpError ? e.status : 502;
  if (!(e instanceof HttpError)) {
    // Bad-params and rate limits are things the client can act on, so pass them
    // through. Auth/404 from upstream are our configuration problem: 502.
    const up = Number(e.status);
    if ([400, 409, 422, 429].includes(up) || (up >= 500 && up <= 599)) status = up;
  }
  const code = e.code || 'upstream_error';
  const payload = { error: { message: e.message || 'unknown error', type: code, code } };

  // The 200 may already be on the wire — then the only honest thing left is an
  // SSE error event followed by [DONE], so the client shows the reason instead
  // of hanging on a silent stream.
  if (res.headersSent) {
    if (!res.writableEnded && !res.destroyed) {
      res.write('data: ' + JSON.stringify(payload) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }
    return;
  }
  sendJson(res, status, payload, extraHeaders);
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'request body too large', 'payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new HttpError(400, 'invalid JSON body: ' + e.message, 'invalid_json');
  }
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function clientKey(req) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return req.headers['x-api-key'] || '';
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * A browser page may only call /v1 when it is served from loopback (SillyTavern
 * on 127.0.0.1:8000 qualifies). Requests with no Origin header come from CLI
 * clients and are allowed. This keeps a random web page from spending your
 * quota through the browser when no API key is set.
 */
function isLoopbackOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * Admin calls must come from the console's own origin. A browser cannot fake
 * Origin, so this blocks cross-site requests and DNS-rebinding tricks on top
 * of the admin key.
 */
function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function sseHeaders(extra = {}) {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...extra
  };
}

const v1Cors = (origin) => ({
  'access-control-allow-origin': origin || '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': '*',
  'access-control-max-age': '86400'
});

/* --------------------------------------------------------------- static */

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const relPath = path.normalize(rel).replace(/^[\\/]+/, '');
  const target = path.join(PUBLIC, relPath);
  if (target !== PUBLIC && !target.startsWith(PUBLIC + path.sep)) {
    return sendJson(res, 403, { error: { message: 'forbidden' } });
  }
  try {
    const stat = await fsp.stat(target);
    if (stat.isDirectory()) return sendJson(res, 404, { error: { message: 'not found' } });
    const body = await fsp.readFile(target);
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-store' : 'no-cache',
      'content-length': body.length
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: { message: 'not found' } });
  }
}

/* ------------------------------------------------------------ OpenAI API */

function cataloguePayload() {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: catalogue().map((m) => ({
      id: m.name,
      object: 'model',
      created,
      owned_by: m.providerId,
      name: m.name,
      upstream: m.upstreamId,
      thinking_level: m.thinkingLevel
    }))
  };
}

async function handleChat(req, res, body) {
  const list = catalogue();
  if (!body.model) {
    if (!list.length) throw new HttpError(400, 'no model has been configured yet — open the Web UI', 'no_model');
    body.model = list[0].name;
  }
  const { provider, model, adapter, hit } = targetFor(body.model);
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });

  if (wantsPassthrough(provider, adapter)) {
    const t0 = Date.now();
    let up;
    try {
      up = await adapter.passthrough({
        provider,
        model,
        subPath: provider.chatPath || '/chat/completions',
        method: 'POST',
        body,
        signal: ac.signal
      });
    } catch (e) {
      log.error(`${provider.id} ⇄ passthrough ${hit.name}`, {
        kind: 'request',
        state: 'error',
        ms: Date.now() - t0,
        detail: e.message,
        meta: { adapter: provider.type, model: hit.name }
      });
      throw e;
    }
    const headers = { 'content-type': up.headers.get('content-type') || 'application/json' };
    if (up.headers.get('cache-control')) headers['cache-control'] = up.headers.get('cache-control');
    res.writeHead(up.status, headers);
    if (!up.body) return res.end();
    try {
      await pipeline(Readable.fromWeb(up.body), res);
    } catch {
      /* client hung up */
    }
    log.info(`${provider.id} ⇄ passthrough ${hit.name} → ${up.status}`, {
      kind: 'request',
      state: up.ok ? 'ok' : 'error',
      ms: Date.now() - t0,
      meta: { adapter: provider.type, model: hit.name }
    });
    return;
  }

  const stream = body.stream !== false;
  const id = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
  const created = Math.floor(Date.now() / 1000);
  // Tell the client the stream is live as soon as the upstream answers, not
  // when its first token arrives — otherwise a slow first token looks like a
  // dead connection and the client's own timeout kills it.
  let headSent = false;
  let beat = null;
  const ensureHead = () => {
    if (headSent || res.writableEnded || res.destroyed) return;
    headSent = true;
    res.writeHead(200, sseHeaders(v1Cors(req.headers.origin)));
    // writeHead only records the headers; flushHeaders actually puts them on the
    // wire, which is the whole point here — the client must see 200 immediately.
    res.flushHeaders?.();
    // Start keep-alives right away. An upstream can legitimately think for a
    // minute before its first token, and a client that sees a silent socket for
    // that long will give up — even though data is coming.
    beat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': keep-alive\n\n');
    }, 5000);
  };

  const iterator = runChat({ body, signal: ac.signal, onHead: stream ? ensureHead : undefined })[Symbol.asyncIterator]();

  // Still wait for the first event when nothing can be sent yet: an upstream
  // that fails before producing anything gets a clean JSON error.
  let first;
  try {
    first = await iterator.next();
  } catch (e) {
    return fail(res, e);
  }

  const level = pickLevel(body, hit);
  if (!stream) {
    let text = '';
    let reasoning = '';
    let usage = null;
    let finish = 'stop';
    const toolAcc = [];
    const extraAcc = {};
    let rawOut = '';
    try {
      for (let step = first; !step.done; step = await iterator.next()) {
        const ev = step.value;
        if (ev.raw) {
          rawOut += ev.raw;
          continue;
        }
        if (ev.delta) text += ev.delta;
        if (ev.reasoning) reasoning += ev.reasoning;
        if (ev.toolCalls) mergeToolCalls(toolAcc, ev.toolCalls);
        if (ev.extra) Object.assign(extraAcc, ev.extra);
        if (ev.usage) usage = normalizeUsage(ev.usage);
        if (ev.finish) finish = mapFinish(ev.finish);
      }
    } catch (e) {
      return fail(res, e);
    }
    const msg = { role: 'assistant', content: text };
    if (reasoning) msg.reasoning_content = reasoning;
    if (toolAcc.length) {
      msg.tool_calls = toolAcc.filter(Boolean);
      if (finish === 'stop') finish = 'tool_calls';
    }
    if (rawOut) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(rawOut);
    }
    return sendJson(res, 200, {
      ...extraAcc,
      id,
      object: 'chat.completion',
      created,
      model: hit.name,
      ...(extraAcc.system_fingerprint ? { system_fingerprint: extraAcc.system_fingerprint } : {}),
      choices: [{ index: 0, message: msg, finish_reason: finish }],
      ...(usage ? { usage } : {}),
      rook: { provider: provider.id, adapter: provider.type, thinking: level }
    });
  }

  ensureHead();

  const writeChunk = (delta, finishReason = null, extra = {}) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(
      'data: ' +
        JSON.stringify({
          ...extra,
          id,
          object: 'chat.completion.chunk',
          created,
          model: hit.name,
          ...(extra.system_fingerprint ? { system_fingerprint: extra.system_fingerprint } : {}),
          choices: [{ index: 0, delta, finish_reason: finishReason }]
        }) +
        '\n\n'
    );
  };

  let finishReason = 'stop';
  let usage = null;
  try {
    writeChunk({ role: 'assistant', content: '' });
    for (let step = first; !step.done; step = await iterator.next()) {
      const ev = step.value;
      if (ev.raw) {
        if (!res.writableEnded && !res.destroyed) res.write(ev.raw);
        continue;
      }
      if (ev.reasoning || ev.delta) {
        const d = {};
        if (ev.reasoning) d.reasoning_content = ev.reasoning;
        if (ev.delta) d.content = ev.delta;
        writeChunk(d);
      }
      if (ev.toolCalls) writeChunk({ tool_calls: ev.toolCalls });
      if (ev.deltaExtra) writeChunk(ev.deltaExtra);
      if (ev.extra) writeChunk({}, null, ev.extra);
      if (ev.usage) usage = normalizeUsage(ev.usage);
      if (ev.finish) finishReason = mapFinish(ev.finish);
    }
    if (usage) {
      res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model: hit.name, choices: [], usage }) + '\n\n');
    }
    writeChunk({}, finishReason);
    res.write('data: [DONE]\n\n');
  } catch (e) {
    if (!res.writableEnded) {
      res.write('data: ' + JSON.stringify({ error: { message: e.message, type: e.code || 'upstream_error' } }) + '\n\n');
      res.write('data: [DONE]\n\n');
    }
  } finally {
    clearInterval(beat);
    if (!res.writableEnded && !res.destroyed) res.end();
    // make sure an abandoned generator still runs its cleanup (child process etc.)
    try {
      await iterator.return?.();
    } catch {
      /* already finished */
    }
  }
}

function normalizeUsage(u) {
  if (!u) return u;
  if (typeof u.prompt_tokens === 'number') return u;
  if (typeof u.prompt_chars === 'number') {
    const p = Math.ceil(u.prompt_chars / 3.5);
    const c = Math.ceil((u.completion_chars || 0) / 3.5);
    return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c, estimated: true };
  }
  if (typeof u.input_tokens === 'number') {
    const p = u.input_tokens;
    const c = u.output_tokens ?? 0;
    return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c };
  }
  return u;
}

/** Tool-call deltas arrive in fragments keyed by index; stitch them back. */
function mergeToolCalls(acc, deltas) {
  for (const d of deltas) {
    const i = typeof d.index === 'number' ? d.index : acc.length;
    if (!acc[i]) acc[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
    const t = acc[i];
    if (d.id) t.id = d.id;
    if (d.type) t.type = d.type;
    if (d.function?.name) t.function.name += d.function.name;
    if (d.function?.arguments) t.function.arguments += d.function.arguments;
  }
}

function mapFinish(reason) {
  const r = String(reason || '').toLowerCase();
  if (['length', 'max_tokens', 'max_output_tokens'].includes(r)) return 'length';
  if (['tool_calls', 'tool_use', 'function_call'].includes(r)) return 'tool_calls';
  if (['content_filter', 'refusal'].includes(r)) return 'content_filter';
  return 'stop';
}


async function handleLegacyCompletion(req, res, body) {
  const prompt = typeof body.prompt === 'string' ? body.prompt : (body.prompt || []).join('\n');
  const messages = [{ role: 'user', content: prompt }];
  const list = catalogue();
  const model = body.model || list[0]?.name;
  let text = '';
  try {
    for await (const ev of runChat({ body: { ...body, messages, model, stream: false } })) {
      if (ev.delta) text += ev.delta;
    }
  } catch (e) {
    return fail(res, e);
  }
  sendJson(res, 200, {
    id: 'cmpl-' + crypto.randomBytes(10).toString('hex'),
    object: 'text_completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, text, finish_reason: 'stop' }]
  });
}

/* -------------------------------------------------------------- admin API */

function requireAdmin(req, res) {
  if (!isSameOrigin(req)) {
    sendJson(res, 403, { error: { message: 'cross-origin admin request rejected', type: 'forbidden' } });
    return false;
  }
  const cfg = getConfig();
  if (safeEqual(req.headers['x-admin-key'], cfg.adminKey)) return true;
  sendJson(res, 401, { error: { message: 'invalid admin key', type: 'unauthorized' } });
  return false;
}

async function handleAdmin(req, res, url, body) {
  const p = url.pathname;

  if (p === '/admin/api/ping') return sendJson(res, 200, { ok: true, version: VERSION });

  if (p === '/admin/api/state') {
    return sendJson(res, 200, {
      version: VERSION,
      configPath: CONFIG_PATH,
      config: getConfig(),
      adapters: listAdapters(),
      levels: LEVELS,
      models: catalogue(),
      baseUrl: `http://${getConfig().host === '0.0.0.0' ? '127.0.0.1' : getConfig().host}:${actualPort}`
    });
  }

  if (p === '/admin/api/config' && req.method === 'PUT') {
    const patch = body || {};
    if ('providers' in patch && !Array.isArray(patch.providers)) {
      return sendJson(res, 400, { error: { message: 'providers must be an array' } });
    }
    for (const pr of patch.providers || []) {
      if (!pr || typeof pr !== 'object' || !pr.id || !pr.type) {
        return sendJson(res, 400, { error: { message: 'every provider needs an id and a type' } });
      }
    }
    const before = getConfig();
    const next = saveConfig(patch);
    refreshProxyEnv();
    log.info('config saved', { kind: 'config' });
    const restart = next.port !== before.port || next.host !== before.host;
    return sendJson(res, 200, { ok: true, restartRequired: restart, config: next });
  }

  if (p === '/admin/api/config/reload') {
    loadConfig();
    return sendJson(res, 200, { ok: true, config: getConfig() });
  }

  if (p === '/admin/api/keys') {
    const cfg = getConfig();
    const patch = {};
    if (body?.apiKey) patch.apiKey = body.apiKey === 'generate' ? 'sk-rook-' + crypto.randomBytes(20).toString('base64url') : body.apiKey;
    if (body?.adminKey) patch.adminKey = body.adminKey === 'generate' ? crypto.randomBytes(16).toString('base64url') : body.adminKey;
    saveConfig(patch);
    return sendJson(res, 200, { ok: true, apiKey: getConfig().apiKey, adminKey: getConfig().adminKey });
  }

  if (p === '/admin/api/logs') {
    return sendJson(res, 200, { logs: log.recent(Number(url.searchParams.get('limit')) || 200) });
  }

  if (p === '/admin/api/logs/stream') {
    res.writeHead(200, sseHeaders());
    res.write(': connected\n\n');
    const unsub = log.subscribe((entry) => {
      if (!res.writableEnded) res.write('data: ' + JSON.stringify(entry) + '\n\n');
    });
    const beat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
    }, 20000);
    req.on('close', () => {
      clearInterval(beat);
      unsub();
    });
    return;
  }

  if (p === '/admin/api/discover') {
    const cfg = getConfig();
    // Prefer the provider as drawn in the editor (it may not be saved yet).
    const provider = body?.provider?.type
      ? body.provider
      : cfg.providers.find((x) => x.id === body?.providerId);
    if (!provider) return sendJson(res, 404, { error: { message: 'provider not found' } });
    const adapter = getAdapter(provider.type);
    if (!adapter?.listModels) return sendJson(res, 400, { error: { message: 'adapter cannot list models' } });
    try {
      const px = provider.useProxy ? String(cfg.proxy || '').trim() || null : null;
      const models = await adapter.listModels(provider, { proxy: px });
      return sendJson(res, 200, { ok: true, models });
    } catch (e) {
      return sendJson(res, 502, { error: { message: e.message } });
    }
  }

  if (p === '/admin/api/test') {
    const cfg = getConfig();
    const provider = cfg.providers.find((x) => x.id === body?.providerId);
    if (!provider) return sendJson(res, 404, { error: { message: 'provider not found' } });
    const modelName = body.model || (provider.models || [])[0]?.alias || (provider.models || [])[0]?.id;
    if (!modelName) return sendJson(res, 400, { error: { message: 'provider has no models' } });
    const t0 = Date.now();
    let text = '';
    let reasoning = '';
    try {
      for await (const ev of runChat({
        body: {
          model: modelName,
          messages: [{ role: 'user', content: body.prompt || 'Say "rook ok" and nothing else.' }],
          stream: false,
          max_tokens: body.maxTokens || 64,
          temperature: 0.2
        },
        level: body.level || normalizeLevel((provider.models || []).find((m) => (m.alias || m.id) === modelName)?.thinkingLevel)
      })) {
        if (ev.delta) text += ev.delta;
        if (ev.reasoning) reasoning += ev.reasoning;
      }
      return sendJson(res, 200, { ok: true, text, reasoning, ms: Date.now() - t0 });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message, ms: Date.now() - t0 });
    }
  }

  return sendJson(res, 404, { error: { message: 'unknown admin route' } });
}

/* ---------------------------------------------------------------- server */

let actualPort = 0;

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const isV1 = p.startsWith('/v1');
  const cors = isV1 ? v1Cors(req.headers.origin) : {};

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }

  if (isV1 && p !== '/v1' && !p.startsWith('/v1/')) {
    return sendJson(res, 404, { error: { message: 'not found' } }, cors);
  }

  if (isV1) {
    const cfg = getConfig();
    if (cfg.apiKey) {
      if (!safeEqual(clientKey(req), cfg.apiKey)) {
        return sendJson(
          res,
          401,
          { error: { message: 'invalid api key (send Authorization: Bearer <key>)', type: 'unauthorized' } },
          cors
        );
      }
    } else if (!isLoopbackOrigin(req)) {
      return sendJson(
        res,
        403,
        {
          error: {
            message: 'no api key is configured, so only pages served from loopback may call this gateway',
            type: 'forbidden'
          }
        },
        cors
      );
    }
  }

  try {
    if (p === '/health' || p === '/v1/health') {
      return sendJson(res, 200, { status: 'ok', version: VERSION, models: catalogue().length }, cors);
    }

    if (isV1 && p === '/v1/models' && req.method === 'GET') {
      return sendJson(res, 200, cataloguePayload(), cors);
    }

    if (isV1 && p.startsWith('/v1/models/') && req.method === 'GET') {
      const name = decodeURIComponent(p.slice('/v1/models/'.length));
      const hit = catalogue().find((m) => m.name === name);
      if (!hit) return sendJson(res, 404, { error: { message: 'model not found' } }, cors);
      return sendJson(res, 200, { id: hit.name, object: 'model', owned_by: hit.providerId, thinking_level: hit.thinkingLevel }, cors);
    }

    if (isV1 && p === '/v1/chat/completions' && req.method === 'POST') {
      const body = await readJson(req);
      return await handleChat(req, res, body);
    }

    if (isV1 && p === '/v1/completions' && req.method === 'POST') {
      const body = await readJson(req);
      return await handleLegacyCompletion(req, res, body);
    }

    if (p.startsWith('/admin/api')) {
      if (!requireAdmin(req, res)) return;
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJson(req);
      return await handleAdmin(req, res, url, body);
    }

    if (req.method === 'GET') return await serveStatic(req, res, p);

    sendJson(res, 404, { error: { message: 'not found' } });
  } catch (e) {
    if (e instanceof HttpError) return fail(res, e, cors);
    log.error('unhandled: ' + e.message, { detail: e.stack });
    fail(res, e, cors);
  }
}

const server = http.createServer((req, res) => {
  // A client that walks away mid-stream must not turn into an uncaught 'error'.
  res.on('error', (e) => log.debug('response stream error: ' + e.message));
  route(req, res).catch((e) => {
    log.error('route crashed: ' + e.message, { detail: e.stack });
    if (!res.headersSent) sendJson(res, 500, { error: { message: e.message } });
    else res.end();
  });
});

function start() {
  const cfg = getConfig();
  const port = Number(process.env.PORT || cfg.port || 8765);
  const host = process.env.HOST || cfg.host || '127.0.0.1';

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\n[rook] port ${port} is already in use. Change "port" in ${CONFIG_PATH}\n`);
      process.exit(1);
    }
    throw e;
  });

  server.listen(port, host, () => {
    actualPort = server.address().port;
    const shown = host === '0.0.0.0' ? '127.0.0.1' : host;
    console.log('');
    console.log('  rook  ' + VERSION + '  —  local model gateway');
    console.log('  ' + '─'.repeat(46));
    console.log(`  Web UI      http://${shown}:${actualPort}/`);
    console.log(`  Base URL    http://${shown}:${actualPort}/v1`);
    console.log(`  API Key     ${cfg.apiKey || '(none — open access)'}`);
    console.log(`  Admin Key   ${cfg.adminKey}`);
    const px = proxyStatus();
    console.log(`  Proxy       ${px.enabled ? px.proxy : '(direct)'}`);
    console.log(`  Config      ${CONFIG_PATH}`);
    console.log('  ' + '─'.repeat(46));
    console.log('');
    if (!catalogue().length) log.warn('no enabled models yet — configure one in the Web UI');
    else log.info(`${catalogue().length} model(s) online`);
  });
}

loadConfig();
refreshProxyEnv();
start();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n[rook] shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}
