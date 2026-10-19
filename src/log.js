import { get } from './config.js';

const ring = [];
const subs = new Set();
let seq = 0;

/**
 * Anything that looks like a credential gets shortened before it lands in the
 * ring buffer. Providers sometimes carry their key in argv or a URL, and the
 * console shows those lines verbatim.
 */
const SECRET_RE =
  /\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|Bearer\s+[A-Za-z0-9._-]{12,})/g;

function mask(value) {
  if (typeof value !== 'string') return value;
  return value.replace(SECRET_RE, (m) => m.slice(0, 7) + '…' + m.slice(-2));
}

function broadcast(entry) {
  for (const fn of subs) {
    try {
      fn(entry);
    } catch {
      /* subscriber gone */
    }
  }
}

export function push(level, msg, extra = {}) {
  const entry = { seq: ++seq, ts: Date.now(), level, msg: mask(msg), ...extra };
  if (typeof entry.detail === 'string') entry.detail = mask(entry.detail);
  ring.push(entry);
  const limit = Math.max(20, get().logLimit || 300);
  while (ring.length > limit) ring.shift();
  broadcast(entry);
  const tag = level === 'error' ? 'ERR ' : level === 'warn' ? 'WRN ' : extra.kind === 'stage' ? ' →  ' : '    ';
  if (level !== 'debug' || process.env.ROOK_DEBUG) {
    // print the masked copy, not the raw arguments — same reason as the ring
    console.log(`[rook] ${tag}${entry.msg}${entry.detail ? ' — ' + String(entry.detail).slice(0, 400) : ''}`);
  }
  return entry;
}

export const info = (m, e) => push('info', m, e);
export const warn = (m, e) => push('warn', m, e);
export const error = (m, e) => push('error', m, e);
export const debug = (m, e) => push('debug', m, e);

/** In-flight progress of a streaming request: goes to the console and the ring. */
export const progress = (m, e) => push('info', m, { kind: 'progress', ...e });

export function recent(limit = 200) {
  return ring.slice(-limit);
}

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

/** A single request lifecycle record, so the UI can show timing and token usage. */
export function startRequest(meta) {
  const t0 = Date.now();
  const details = [];
  push('info', `${meta.adapter} ← ${meta.model}`, { kind: 'request', state: 'running', meta });
  let closed = false;
  return {
    note(msg) {
      if (msg) details.push(String(msg));
    },
    /** One line per lifecycle milestone: received → connecting → status → … */
    stage(msg) {
      if (!msg) return;
      push('info', msg, { kind: 'stage', meta });
    },
    finish(state, extra = {}) {
      if (closed) return;
      closed = true;
      push(
        state === 'ok' ? 'info' : 'error',
        `${meta.adapter} ← ${meta.model}${extra.summary ? ' · ' + extra.summary : ''}`,
        {
          kind: 'request',
          state,
          ms: Date.now() - t0,
          meta,
          detail: details.length ? details.join(' · ') : null,
          ...extra
        }
      );
    },
    get ms() {
      return Date.now() - t0;
    }
  };
}
