/**
 * Outbound proxy.
 *
 * Node's built-in fetch honours HTTP(S)_PROXY only when NODE_USE_ENV_PROXY is
 * set (undici re-reads the env on each request, so this can be switched at
 * runtime). Upstreams marked `useProxy: false` are added to NO_PROXY, which
 * keeps per-provider switching safe even when requests overlap.
 */
import { get as getConfig } from './config.js';

export function refreshProxyEnv() {
  const cfg = getConfig();
  const proxy = String(cfg.proxy || '').trim();

  if (!proxy) {
    delete process.env.NODE_USE_ENV_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.NO_PROXY;
    return null;
  }

  process.env.NODE_USE_ENV_PROXY = '1';
  process.env.HTTPS_PROXY = proxy;
  process.env.HTTP_PROXY = proxy;

  const direct = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  for (const p of cfg.providers || []) {
    if (p.useProxy) continue;
    try {
      direct.add(new URL(p.baseUrl).hostname);
    } catch {
      /* cli providers have no baseUrl */
    }
  }
  process.env.NO_PROXY = [...direct].join(',');
  return proxy;
}

export function proxyStatus() {
  const proxy = String(getConfig().proxy || '').trim();
  if (!proxy) return { enabled: false, proxy: null };
  return { enabled: true, proxy, bypass: process.env.NO_PROXY || '' };
}
