/**
 * OpenAI-compatible upstream: official OpenAI, any relay (中转), any reverse
 * proxy that speaks /v1/chat/completions. This is the workhorse adapter.
 */
import { applyThinking, pickReasoning } from '../thinking.js';
import { trimSlash, readError, normalizeMessages } from './_sse.js';
import { request } from '../http.js';

export const type = 'openai';
export const label = 'OpenAI 兼容（中转 / 反代 / 官方）';

export const fields = [
  { key: 'baseUrl', label: 'Base URL', placeholder: 'https://api.example.com/v1', required: true },
  { key: 'apiKey', label: 'API Key', secret: true },
  { key: 'headers', label: '额外请求头（JSON）', json: true },
  { key: 'extraBody', label: '额外请求体（JSON）', json: true }
];

export function headers(provider) {
  const h = { 'content-type': 'application/json', accept: 'text/event-stream' };
  if (provider.apiKey) {
    h.authorization = `Bearer ${provider.apiKey}`;
    // Some relays want both; harmless elsewhere.
    if (provider.alsoApiKeyHeader) h['x-api-key'] = provider.apiKey;
  }
  for (const [k, v] of Object.entries(provider.headers || {})) h[k.toLowerCase()] = String(v);
  return h;
}

export function buildBody(provider, model, request) {
  // Pure relay: every field the client sent goes to the upstream untouched.
  // Only our own routing keys are stripped, plus model/messages which we have
  // to restate. `stream` is echoed rather than forced — a non-stream request
  // goes upstream as a non-stream request.
  const {
    model: _model,
    messages: _messages,
    stream: clientStream,
    thinking_level,
    thinkingLevel,
    rook_thinking,
    ...rest
  } = request.params || {};

  const body = {
    ...rest,
    model: model.id || model.alias,
    messages: normalizeMessages(request.messages),
    stream: clientStream !== false
  };
  const thinking = applyThinking(body, provider, request.level);
  Object.assign(body, provider.extraBody || {});
  if (provider.forceBody) Object.assign(body, provider.forceBody);
  return { body, thinking, isStream: body.stream !== false };
}

export async function listModels(provider, opts = {}) {
  const res = await request(`${trimSlash(provider.baseUrl)}/models`, {
    headers: headers(provider),
    proxy: opts.proxy,
    timeoutMs: 20000
  });
  if (!res.ok) throw await readError(res);
  const json = JSON.parse(await res.text());
  const arr = json.data || json.models || [];
  return arr.map((m) => ({ id: m.id || m.name, raw: m })).filter((m) => m.id);
}


/**
 * Byte-for-byte relay.
 *
 * Whatever the upstream sends is what the client receives: no parsing, no
 * reassembly, no field filtering. Every bug we shipped came from repacking the
 * upstream's chunks into our own shape and getting a field wrong; this path has
 * nothing to get wrong.
 */
export async function* chat(ctx) {
  const { provider, model, signal, log } = ctx;
  const { body, thinking, isStream } = buildBody(provider, model, ctx);
  const noteBase = `temp=${body.temperature ?? '-'} top_p=${body.top_p ?? '-'} max=${body.max_tokens ?? body.max_completion_tokens ?? '-'} · thinking=${thinking.level} · ${body.model}@${provider.baseUrl}`;
  log?.note?.(noteBase);

  const res = await request(`${trimSlash(provider.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: headers(provider),
    body: JSON.stringify(body),
    signal,
    proxy: ctx.proxy,
    timeoutMs: 30000,
    onStage: (msg) => log?.stage?.(msg)
  });
  if (!res.ok) throw await readError(res);
  ctx.onHead?.();
  if (!res.body) throw new Error('upstream returned empty body');

  if (!isStream) {
    yield { raw: await res.text() };
    return;
  }

  res.body.setEncoding('utf8');
  let seenVersion = null;
  for await (const chunk of res.body) {
    if (!chunk) continue;
    // Observe only, never rewrite: modelVersion is useful in the log.
    if (!seenVersion) {
      const m = chunk.match(/"modelVersion"\s*:\s*"([^"]+)"/);
      if (m) {
        seenVersion = m[1];
        log?.note?.(`${noteBase} · modelVersion=${seenVersion}`);
      }
    }
    yield { raw: chunk };
  }
}
