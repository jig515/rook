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
import { startRequest, progress } from './log.js';

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

export async function* runChat({ body, signal, level, onHead }) {
  const { provider, model, adapter, hit } = targetFor(body.model);
  const lvl = level || pickLevel(body, hit);
  const msgCount = (body.messages || []).length;
  const bodyKb = (JSON.stringify(body).length / 1024).toFixed(1);
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
  const idleTimeout = Number(provider.idleTimeoutMs || cfg.idleTimeoutMs || 0) || 60000;

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
    onHead,
    model,
    proxy,
    messages: body.messages || [],
    params: body,
    level: lvl,
    signal: sig,
    log: {
      note: (msg) => trace.note(msg),
      stage: (msg) => trace.stage(msg)
    }
  };

  trace.stage(`received · ${msgCount} msg · ${bodyKb} KB · level=${lvl}`);

  let chars = 0;
  let reasoningChars = 0;
  let rawBytes = 0;
  let finishReason = null;
  let ttfb = null;
  let firstBody = null;

  const summary = () =>
    `content=${chars} reasoning=${reasoningChars} finish=${finishReason || '-'} · first token ${ttfb ?? '—'}ms` +
    ` · first body ${firstBody ?? '—'}ms · total ${trace.ms}ms`;

  // A ticker, not a per-chunk check: when an upstream goes silent before the
  // first byte the loop body never runs, and that is exactly when the log
  // matters most.
  const ticker = setInterval(() => {
    if (trace.ms < 2500) return;
    const secs = (trace.ms / 1000).toFixed(1);
    const phase = !started ? 'waiting first byte' : firstBody === null ? 'thinking' : 'streaming';
    const rate = Math.round((chars + reasoningChars) / Math.max(trace.ms / 1000, 0.001));
    progress(
      `${hit.name} · ${secs}s · ${phase} · content ${chars} / reasoning ${reasoningChars}` +
        (firstBody !== null ? ` · ${rate} c/s` : '')
    );
  }, 2500);

  try {
    for await (const ev of adapter.chat(ctx)) {
      if (!started) {
        started = true;
        ttfb = trace.ms;
        trace.stage(`first byte · ${trace.ms}ms`);
        if (!adapter.managesTimeout) arm(idleTimeout, 'idle-timeout');
      } else if (!adapter.managesTimeout) {
        arm(idleTimeout, 'idle-timeout');
      }
      if (ev.delta) {
        chars += ev.delta.length;
        if (firstBody === null) {
          firstBody = trace.ms;
          trace.stage(`first body · ${trace.ms}ms`);
        }
      }
      if (ev.raw) rawBytes += ev.raw.length;
      if (ev.reasoning) reasoningChars += ev.reasoning.length;
      if (ev.finish) finishReason = ev.finish;
      if (ev.finish) trace.finish('ok', { summary: summary() });
      yield ev;
    }
    trace.finish('ok', { summary: summary() });
  } catch (e) {
    let err = e;
    // Trust our own abort reasons over the error object: node rewrites the
    // message of a destroyed request to a bare "aborted", losing the cause.
    const why = ac.signal.reason;

    if (e?.message === 'fetch failed' && e.cause) {
      // undici hides the real reason in `cause`; surface it or we are blind.
      const c = e.cause;
      const detail = [c.code, c.syscall, c.hostname, c.message].filter(Boolean).join(' · ');
      err = new HttpError(502, `upstream fetch failed: ${detail || 'unknown network error'}`, 'upstream_unreachable');
      err.cause = c;
    } else if (signal.aborted) {
      err = new HttpError(499, 'client closed the request', 'client_closed');
    } else if (why === 'idle-timeout') {
      err = new HttpError(504, `upstream went quiet for ${idleTimeout}ms mid-stream`, 'upstream_idle');
    } else if (why === 'start-timeout') {
      err = new HttpError(504, `upstream did not send anything within ${startTimeout}ms`, 'upstream_timeout');
    } else if (e?.name === 'TimeoutError') {
      err = new HttpError(504, `upstream timed out`, 'upstream_timeout');
    } else if (!(err instanceof HttpError) && /aborted/i.test(String(err?.message))) {
      err = new HttpError(499, 'request aborted', 'client_closed');
    }
    if (err.code === 'upstream_idle') trace.stage(`no response · ${trace.ms}ms · stream went silent`);
    else if (err.code === 'upstream_timeout') trace.stage(`no response · ${trace.ms}ms · nothing came back`);
    else if (err.code === 'client_closed') trace.stage(`client hung up · ${trace.ms}ms`);
    else trace.stage(`failed · ${trace.ms}ms · ${String(err.message).slice(0, 90)}`);
    trace.finish('error', { detail: err.message, summary: err.message.slice(0, 120) });
    throw err;
  } finally {
    clearInterval(ticker);
    clearTimeout(timer);
  }
}
