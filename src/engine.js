/**
 * Request engine: resolve model alias -> provider -> adapter, then normalise
 * every adapter's output into one event vocabulary.
 *
 *   { delta: "text" }        assistant text
 *   { reasoning: "text" }    thinking / reasoning text
 *   { usage: {...} }         token accounting (best effort)
 *   { finish: "stop" }       terminal finish reason
 */
import { get as getConfig, resolveModel, providerTarget } from './config.js';
import { getAdapter } from './adapters/index.js';
import { normalizeLevel } from './thinking.js';
import { startRequest } from './log.js';

export class HttpError extends Error {
  constructor(status, message, code = 'gateway_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function pickLevel(body, model) {
  const raw =
    body?.thinking_level ??
    body?.thinkingLevel ??
    body?.reasoning_effort ??
    body?.rook_thinking ??
    model?.thinkingLevel;
  return normalizeLevel(raw, 'medium');
}

export function targetFor(modelName) {
  const cfg = getConfig();
  const hit = resolveModel(modelName);
  if (!hit) {
    throw new HttpError(
      404,
      `unknown model "${modelName}". Configured: ${cfg.providers
        .filter((p) => p.enabled)
        .flatMap((p) => (p.models || []).map((m) => m.alias || m.id))
        .join(', ') || '(none)'}`,
      'model_not_found'
    );
  }
  const { provider, model } = providerTarget(hit.providerId, hit.name);
  if (!provider) throw new HttpError(500, `provider "${hit.providerId}" disappeared`, 'provider_missing');
  if (!provider.enabled) throw new HttpError(503, `provider "${provider.name}" is disabled`, 'provider_disabled');
  const adapter = getAdapter(provider.type);
  if (!adapter) throw new HttpError(500, `no adapter for type "${provider.type}"`, 'adapter_missing');
  return { provider, model, adapter, hit, level: pickLevel(null, hit) };
}

/** True when this provider wants its bytes forwarded untouched. */
export function wantsPassthrough(provider, adapter) {
  if (!adapter?.passthrough) return false;
  return provider.mode !== 'rewrite';
}

export async function* runChat({ body, signal, level }) {
  const { provider, model, adapter, hit } = targetFor(body.model);
  const lvl = level || pickLevel(body, hit);
  const trace = startRequest({
    provider: provider.id,
    adapter: provider.type,
    model: hit.name,
    upstream: model.id,
    level: lvl,
    stream: !!body.stream
  });

  // Two clocks, not one deadline: a long answer must not be guillotined just
  // for taking a while. `startTimeout` covers connect + first token; after that
  // only silence (`idleTimeout`) aborts. CLI adapters run their own watchdog.
  const cfg = getConfig();
  const startTimeout = Number(provider.timeoutMs || cfg.timeoutMs || 0) || 120000;
  const idleTimeout = Number(provider.idleTimeoutMs || cfg.idleTimeoutMs || 0) || 120000;

  const ac = new AbortController();
  let timer = null;
  let started = false;
  const arm = (ms, why) => {
    clearTimeout(timer);
    timer = setTimeout(() => ac.abort(why), ms);
  };

  let sig = signal;
  if (!adapter.managesTimeout) {
    sig = AbortSignal.any([signal, ac.signal]);
    arm(startTimeout, 'start-timeout');
  }

  const proxy = provider.useProxy ? String(cfg.proxy || '').trim() || null : null;

  const ctx = {
    provider,
    model,
    proxy,
    messages: body.messages || [],
    params: body,
    level: lvl,
    signal: sig,
    log: {
      note: (msg) => trace.note(msg)
    }
  };

  let chars = 0;
  let reasoningChars = 0;
  let finishReason = null;
  let ttfb = null;
  const summary = () =>
    `content=${chars} reasoning=${reasoningChars} finish=${finishReason || '-'} · first token ${ttfb ?? '—'}ms · total ${trace.ms}ms`;

  try {
    for await (const ev of adapter.chat(ctx)) {
      if (!started) {
        started = true;
        ttfb = trace.ms;
        if (!adapter.managesTimeout) arm(idleTimeout, 'idle-timeout');
      } else if (!adapter.managesTimeout) {
        arm(idleTimeout, 'idle-timeout');
      }
      if (ev.delta) chars += ev.delta.length;
      if (ev.reasoning) reasoningChars += ev.reasoning.length;
      if (ev.finish) finishReason = ev.finish;
      if (ev.finish) trace.finish('ok', { summary: summary() });
      yield ev;
    }
    trace.finish('ok', { summary: summary() });
  } catch (e) {
    let err = e;
    if (e?.message === 'fetch failed' && e.cause) {
      // undici hides the real reason in `cause`; surface it or we are blind.
      const c = e.cause;
      const detail = [c.code, c.syscall, c.hostname, c.message].filter(Boolean).join(' · ');
      err = new HttpError(502, `upstream fetch failed: ${detail || 'unknown network error'}`, 'upstream_unreachable');
      err.cause = c;
    } else if (e?.name === 'AbortError' && signal.aborted) {
      err = new HttpError(499, 'client closed the request', 'client_closed');
    } else if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      const why = ac.signal.reason;
      err =
        why === 'idle-timeout'
          ? new HttpError(504, `upstream went quiet for ${idleTimeout}ms mid-stream`, 'upstream_idle')
          : new HttpError(504, `upstream did not send anything within ${startTimeout}ms`, 'upstream_timeout');
    }
    trace.finish('error', { detail: err.message, summary: err.message.slice(0, 120) });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
