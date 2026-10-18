/**
 * Mock upstream used by the smoke test: speaks OpenAI, Anthropic and a
 * deliberately non-OpenAI shape (for the proxy adapter), plus the failure
 * modes that are easy to get wrong (401 / 429 / hang / tool calls).
 */
import http from 'node:http';

export const state = { last: null, lastAnthropic: null, hits: [] };

const json = (res, obj, status = 200) => {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length });
  res.end(body);
};

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

function openSse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
}

const chunk = (delta, finish = null) => ({
  id: 'chatcmpl-mock',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'mock-a',
  choices: [{ index: 0, delta, finish_reason: finish }]
});

export function startMock(port = 0) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const raw = await readBody(req);
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      /* leave null */
    }
    state.last = { path: url.pathname, body, headers: req.headers, method: req.method };
    state.hits.push(url.pathname);

    if (url.pathname === '/v1/models') {
      return json(res, {
        object: 'list',
        data: [{ id: 'mock-a' }, { id: 'mock-b' }, { id: 'claude-x' }, { id: 'slow' }]
      });
    }

    if (url.pathname === '/v1/chat/completions') {
      if (!String(req.headers.authorization || '').includes('up-key')) {
        return json(res, { error: { message: 'bad upstream key' } }, 401);
      }
      const model = body?.model;
      if (model === 'boom') return json(res, { error: { message: 'upstream refused' } }, 401);
      if (model === 'ratelimit') return json(res, { error: { message: 'rate limited' } }, 429);
      if (model === 'badrequest') return json(res, { error: { message: 'bad params' } }, 400);
      if (model === 'slow') return; // never answers: exercises the gateway timeout
      if (model === 'raw') return json(res, { proxied: true, model, received: body });
      if (model === 'strict' && typeof body.temperature === 'number' && body.temperature > 1) {
        // deliberately mirrors Gemini's complaint
        return json(res, { error: { message: 'Too big: expected number to be <=1 at temperature' } }, 400);
      }

      if (model === 'tools') {
        openSse(res);
        const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        send(chunk({ role: 'assistant', content: '' }));
        send(chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_', arguments: '' } }] }));
        send(chunk({ tool_calls: [{ index: 0, function: { name: 'weather', arguments: '{"city"' } }] }));
        send(chunk({ tool_calls: [{ index: 0, function: { arguments: ':"SH"}' } }] }));
        send(chunk({}, 'tool_calls'));
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      openSse(res);
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send(chunk({ role: 'assistant', content: '' }));
      send(chunk({ content: 'mock ' }));
      send(chunk({ content: 'answer' }));
      // a relay-extras chunk: unknown top-level fields must survive the gateway
      send({ ...chunk({}), modelVersion: 'mock-v1.2.3', system_fingerprint: 'fp_mock' });
      send(chunk({}, 'stop'));
      send({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: 'mock-a', choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    if (url.pathname === '/v1/messages') {
      if (!req.headers['x-api-key']) return json(res, { type: 'error', error: { message: 'no key' } }, 401);
      const msgs = body?.messages || [];
      for (let i = 1; i < msgs.length; i++) {
        if (msgs[i].role === msgs[i - 1].role) {
          return json(res, { type: 'error', error: { message: 'roles must alternate' } }, 400);
        }
      }
      state.lastAnthropic = body;
      openSse(res);
      const ev = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      ev({ type: 'message_start', message: { id: 'm1', usage: { input_tokens: 12 } } });
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pondering' } });
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'anth ' } });
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } });
      ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } });
      ev({ type: 'message_stop' });
      return res.end();
    }

    if (url.pathname === '/v1/echo') {
      return json(res, { path: url.pathname, method: req.method, body, auth: req.headers.authorization || null });
    }

    json(res, { error: { message: 'mock: no route ' + url.pathname } }, 404);
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
