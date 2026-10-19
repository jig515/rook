/**
 * OpenAI-compatible upstream: official OpenAI, any relay (中转), any reverse
 * proxy that speaks /v1/chat/completions. This is the workhorse adapter.
 */
import { applyThinking, pickReasoning } from '../thinking.js';
import { trimSlash, readError, sseJson, normalizeMessages, textOf, TextChannel } from './_sse.js';
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
  // Only our own routing keys are stripped, plus model/messages/stream which we
  // have to restate anyway.
  const {
    model: _model,
    messages: _messages,
    stream: _stream,
    thinking_level,
    thinkingLevel,
    rook_thinking,
    ...rest
  } = request.params || {};

  const body = {
    ...rest,
    model: model.id || model.alias,
    messages: normalizeMessages(request.messages),
    stream: true
  };
  if (provider.includeUsage !== false && body.stream_options === undefined) {
    body.stream_options = { include_usage: true };
  }
  const thinking = applyThinking(body, provider, request.level);
  Object.assign(body, provider.extraBody || {});
  if (provider.forceBody) Object.assign(body, provider.forceBody);
  return { body, thinking };
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

export async function* chat(ctx) {
  const { provider, model, signal, log } = ctx;
  const { body, thinking } = buildBody(provider, model, ctx);
  const contentCh = new TextChannel();
  const reasoningCh = new TextChannel();
  const noteBase = `temp=${body.temperature ?? '-'} top_p=${body.top_p ?? '-'} max=${body.max_tokens ?? body.max_completion_tokens ?? '-'} · thinking=${thinking.level} · ${body.model}@${provider.baseUrl}`;
  log?.note?.(noteBase);

  const res = await request(`${trimSlash(provider.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: headers(provider),
    body: JSON.stringify(body),
    signal,
    proxy: ctx.proxy,
    timeoutMs: 30000
  });
  if (!res.ok) throw await readError(res);
  if (!res.body) throw new Error('upstream returned empty body');

  let modelVersion = null;
  let lastFingerprint = null;
  const extraAll = {};
  for await (const chunk of sseJson(res)) {
    if (chunk.error) throw new Error(chunk.error.message || JSON.stringify(chunk.error));

    const {
      choices: _c,
      usage: _u,
      id: _id,
      object: _obj,
      created: _cr,
      model: _mdl,
      system_fingerprint: fp,
      ...extra
    } = chunk;

    // The fingerprint only needs sending when it appears or changes; repeating it
    // on every chunk just multiplies the event count.
    if (fp && fp !== lastFingerprint) {
      lastFingerprint = fp;
      extra.system_fingerprint = fp;
    }
    if (chunk.modelVersion && chunk.modelVersion !== modelVersion) {
      modelVersion = chunk.modelVersion;
      log?.note?.(`${noteBase} · modelVersion=${modelVersion}`);
    }

    const choice = chunk.choices?.[0];
    if (choice) {
      const d = choice.delta || choice.message || {};

      // Feed both possible carriers into per-channel accumulators.
      //   increments: delta.content / delta.reasoning_content (the OpenAI way)
      //   snapshots:  extra_content.google.ordinary_parts (Gemini behind a shim,
      //               cumulative: every chunk repeats the whole text so far)
      // TextChannel decides which is more complete; we never guess per vendor.
      const incText = textOf(d.content);
      const incReason = pickReasoning(d);
      if (incText) contentCh.delta(incText);
      if (incReason) reasoningCh.delta(incReason);

      const parts = d.extra_content?.google?.ordinary_parts;
      if (Array.isArray(parts) && parts.length) {
        let r = '';
        let c = '';
        for (const pt of parts) {
          if (!pt || typeof pt.text !== 'string' || !pt.text) continue;
          if (pt.kind === 'thought') r += pt.text;
          else c += pt.text;
        }
        reasoningCh.snapshot(r);
        contentCh.snapshot(c);
      }

      const outText = contentCh.take();
      const outReason = reasoningCh.take();

      // Keep the upstream's atomicity: if one chunk carries both reasoning and
      // body text, they leave here in one event so the client sees them in the
      // same delta rather than as two separate chunks.
      if (outText || outReason) yield { reasoning: outReason || undefined, delta: outText || undefined };
      if (Array.isArray(d.tool_calls) && d.tool_calls.length) yield { toolCalls: d.tool_calls };

      // Same for unknown keys inside the delta.
      const {
        content: _ct,
        role: _r,
        tool_calls: _tc,
        reasoning_content: _rc,
        reasoning: _rs,
        thinking: _th,
        reasoning_text: _rt,
        ...deltaExtra
      } = d;
      if (Object.keys(deltaExtra).length) yield { deltaExtra };

      if (choice.finish_reason) yield { finish: choice.finish_reason };
    }
    if (Object.keys(extra).length) Object.assign(extraAll, extra);
    if (chunk.usage) yield { usage: chunk.usage };
  }
  // Emit collected relay metadata once, at the end: repeating it per chunk only
  // multiplies the event stream with empty deltas.
  if (Object.keys(extraAll).length) yield { extra: extraAll };
}
