/**
 * Proxy adapter — byte-level reverse proxy for upstreams that do NOT speak
 * OpenAI (or where you want their native response format untouched).
 *
 * The gateway still resolves the model alias, swaps credentials and can inject
 * headers; everything else passes through as-is, including the SSE framing.
 */
import { trimSlash } from './_sse.js';

export const type = 'proxy';
export const label = '反向代理（原样透传）';

export const passthroughCapable = true;

export const fields = [
  { key: 'baseUrl', label: 'Base URL', placeholder: 'https://api.example.com', required: true },
  { key: 'apiKey', label: 'API Key', secret: true },
  { key: 'authStyle', label: '鉴权方式', enum: ['bearer', 'x-api-key', 'none'] },
  { key: 'headers', label: '额外请求头（JSON）', json: true }
];

/** Upstream path mapping: /v1/chat/completions -> baseUrl + <subPath>. */
function upstreamUrl(provider, subPath) {
  const base = trimSlash(provider.baseUrl);
  const prefix = provider.pathPrefix || '';
  const suffix = subPath || '';
  return base + prefix + suffix;
}

export async function passthrough({ provider, model, subPath, method, body, signal }) {
  const url = upstreamUrl(provider, subPath);
  const headers = { 'content-type': 'application/json' };
  for (const [k, v] of Object.entries(provider.headers || {})) headers[k.toLowerCase()] = String(v);
  const style = provider.authStyle || 'bearer';
  if (provider.apiKey && style === 'bearer') headers.authorization = `Bearer ${provider.apiKey}`;
  if (provider.apiKey && style === 'x-api-key') headers['x-api-key'] = provider.apiKey;

  let payload = body;
  if (body && typeof body === 'object') {
    const clone = JSON.parse(JSON.stringify(body));
    if (provider.rewriteModel !== false && model?.id) clone.model = model.id;
    if (provider.forceBody) Object.assign(clone, provider.forceBody);
    delete clone.stream; // never mutate the client's stream intent
    if (body.stream) clone.stream = body.stream;
    payload = JSON.stringify(clone);
  }

  const res = await fetch(url, {
    method: method || 'POST',
    headers,
    body: method === 'GET' ? undefined : payload,
    signal
  });
  return res;
}

/** Fallback when a proxy provider is used through the streaming engine. */
export async function* chat() {
  throw new Error('proxy adapter only supports passthrough mode');
}
