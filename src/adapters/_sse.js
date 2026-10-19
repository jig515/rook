/** Shared helpers for adapters. Files starting with `_` are not adapters. */

export class UpstreamError extends Error {
  constructor(message, status = 502, detail) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.detail = detail;
  }
}

export const trimSlash = (u) => String(u || '').replace(/\/+$/, '');

export async function readError(res) {
  let text = '';
  try {
    text = await res.text();
  } catch {
    /* ignore */
  }
  let msg = text;
  try {
    const j = JSON.parse(text);
    msg = j.error?.message || j.error || j.message || text;
  } catch {
    /* plain text */
  }
  return new UpstreamError(
    `upstream ${res.status}${msg ? ': ' + String(msg).slice(0, 300) : ''}`,
    res.status,
    text.slice(0, 2000)
  );
}

/** Line-oriented SSE reader. Understands both web and node stream bodies. */
export async function* sseLines(res) {
  if (!res.body) return;
  let buffer = '';

  // Node IncomingMessage (from src/http.js) or a web ReadableStream (fetch).
  if (typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        yield line;
      }
    }
  } else {
    res.body.setEncoding?.('utf8');
    for await (const chunk of res.body) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        yield line;
      }
    }
  }

  if (buffer.trim()) yield buffer;
}

/** Turn an SSE byte stream into JSON payloads (skips comments / [DONE]). */
export async function* sseJson(res) {
  for await (const line of sseLines(res)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      yield JSON.parse(data);
    } catch {
      /* keep-alive or garbage line */
    }
  }
}

/**
 * Accumulates text for one channel (body or reasoning) regardless of how the
 * upstream streams it.
 *
 * Some upstreams send increments (`delta.content`), some send a growing snapshot
 * of the whole text (Gemini parts behind a shim), some send both. Both feeds go
 * into the same accumulator: increments append, snapshots replace when longer.
 * `take()` then hands out only what has not been sent yet, so nothing repeats and
 * nothing goes missing. No per-vendor branching.
 */
export class TextChannel {
  constructor() {
    this.acc = '';
    this.sent = '';
  }

  delta(text) {
    if (text) this.acc += text;
  }

  snapshot(text) {
    if (typeof text === 'string' && text.length > this.acc.length) this.acc = text;
  }

  take() {
    if (this.acc.length <= this.sent.length) return '';
    const out = this.acc.slice(this.sent.length);
    this.sent = this.acc;
    return out;
  }
}

/**
 * Emits only the *new* part of an accumulating text. CLI tools usually print
 * either the full text again on every event or a final blob; both cases work.
 */
export class DeltaDiff {
  constructor() {
    this.sent = '';
  }
  push(text) {
    if (!text) return '';
    if (text.startsWith(this.sent)) {
      const delta = text.slice(this.sent.length);
      this.sent = text;
      return delta;
    }
    if (this.sent.startsWith(text)) return '';
    // Diverged: emit the tail we do not have yet, keep it monotonic.
    this.sent = text;
    return text;
  }
  get full() {
    return this.sent;
  }
}

/** Keep only args an upstream may plausibly understand; drop our own flags. */
export const PASSTHROUGH_KEYS = [
  'temperature', 'top_p', 'top_k', 'max_tokens', 'max_completion_tokens',
  'presence_penalty', 'frequency_penalty', 'repetition_penalty', 'stop', 'seed',
  'logit_bias', 'logprobs', 'top_logprobs', 'n', 'user', 'response_format',
  'tools', 'tool_choice', 'parallel_tool_calls', 'stream_options',
  'min_p', 'top_a', 'typical_p', 'tfs', 'mirostat', 'mirostat_tau', 'mirostat_eta',
  'smoothing_factor', 'dynatemp_range', 'dynatemp_exponent', 'xtc_threshold',
  'xtc_probability', 'dry_multiplier', 'dry_base', 'dry_allowed_length',
  'dry_penalty_last_n', 'sampler_priority', 'chat_template_kwargs', 'json_schema',
  'guided_json', 'guided_regex', 'grammar'
];

export function pickParams(src) {
  const out = {};
  for (const k of PASSTHROUGH_KEYS) if (src[k] !== undefined && src[k] !== null) out[k] = src[k];
  return out;
}

/**
 * Messages go to the upstream exactly as they arrived. No field is dropped, no
 * message is removed, no content is rewritten — the gateway is a courier, and
 * silently dropping a field the client sent is how replies go subtly wrong.
 */
export function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => ({ ...m }));
}

export function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}
