/**
 * Outbound HTTP with an optional HTTP CONNECT proxy.
 *
 * Node's `fetch` cannot take a proxy without the (unbundled) undici package, and
 * `NODE_USE_ENV_PROXY` only works if the dispatcher happens to be built after
 * the env is set — which it demonstrably is not. So requests go through
 * node:http(s) directly, and when a proxy is configured we open a CONNECT tunnel
 * and run TLS over that socket.
 */
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

function openTunnel(proxyUrl, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const pu = new URL(proxyUrl);
    let settled = false;
    const done = (err, res) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve(res);
    };

    const req = http.request({
      host: pu.hostname,
      port: Number(pu.port) || 80,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { host: `${host}:${port}`, 'proxy-connection': 'keep-alive' },
      timeout: timeoutMs
    });

    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        done(new Error(`proxy refused CONNECT ${host}:${port} → ${res.statusCode}`));
        return;
      }
      // Hand back the raw tunnel socket: https.request does the TLS handshake
      // itself (with the right servername). Wrapping it here would double-TLS.
      done(null, socket);
    });
    req.once('timeout', () => {
      req.destroy();
      done(new Error(`proxy connect timeout after ${timeoutMs}ms`));
    });
    req.once('error', (e) => done(e));
    req.end();
  });
}

/**
 * @returns {Promise<{status:number, ok:boolean, headers:object, body:import('node:stream').Readable, text:()=>Promise<string>}>}
 */
export async function request(urlStr, opts = {}) {
  const { method = 'GET', headers = {}, body, signal, proxy, timeoutMs = 30000 } = opts;
  const u = new URL(urlStr);
  const isHttps = u.protocol === 'https:';
  const port = Number(u.port) || (isHttps ? 443 : 80);

  let socket = null;
  if (proxy && isHttps) {
    socket = await openTunnel(proxy, u.hostname, port, timeoutMs);
  }

  const payload = body == null ? null : Buffer.from(body);
  const lib = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: u.hostname,
        port,
        path: u.pathname + u.search,
        method,
        headers: {
          ...headers,
          ...(payload ? { 'content-length': payload.length } : {})
        },
        agent: false,
        ...(socket ? { createConnection: () => socket } : {})
      },
      (res) => {
        const chunks = [];
        let consumed = false;
        const text = () =>
          new Promise((res2, rej2) => {
            if (consumed) return rej2(new Error('body already streamed'));
            consumed = true;
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => res2(Buffer.concat(chunks).toString('utf8')));
            res.on('error', rej2);
          });
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          headers: res.headers,
          body: res,
          text
        });
      }
    );

    req.on('error', reject);
    if (signal) {
      const onAbort = () => req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (signal.aborted) {
        req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    if (payload) req.write(payload);
    req.end();
  });
}

/** Uniform async iterator over a Node stream body. */
export async function* bodyChunks(body) {
  if (!body) return;
  body.setEncoding?.('utf8');
  for await (const chunk of body) {
    yield typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  }
}
