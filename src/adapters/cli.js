/**
 * CLI adapter — "command 接入".
 *
 * Runs an arbitrary local command (claude, gemini, codex, llm, ollama, a shell
 * script, whatever), feeds it the conversation on stdin, and parses its stdout
 * back into a token stream. Args/env accept placeholders:
 *
 *   {{model}}   upstream model id
 *   {{level}}   off|low|medium|high|max
 *   {{budget}}  thinking token budget for that level
 *   {{on}}      true|false
 *   {{cwd}}     provider.cwd
 *
 * An arg that resolves to an empty string is dropped, so you can write
 * ["--effort", "{{level}}"] and have it vanish when thinking is off.
 */
import { spawn } from 'node:child_process';
import { DeltaDiff, textOf } from './_sse.js';
import { normalizeLevel, budgetsOf } from '../thinking.js';

export const type = 'cli';
export const managesTimeout = true;
export const label = '本地命令（CLI 子进程）';

export const fields = [
  { key: 'command', label: 'Command（可执行文件）', placeholder: 'claude', required: true },
  { key: 'args', label: '参数（每行一个）', list: true },
  { key: 'inputFormat', label: '输入拼接方式', enum: ['transcript', 'last', 'json', 'template'] },
  { key: 'promptTemplate', label: 'Prompt 模板（inputFormat=template）', textarea: true },
  { key: 'parser', label: '输出解析器', enum: ['raw', 'claude-stream', 'json-lines', 'json-object'] },
  { key: 'cwd', label: '工作目录' },
  { key: 'env', label: '额外环境变量（JSON）', json: true },
  { key: 'timeoutMs', label: '超时（毫秒）', number: true }
];

function fill(str, vars) {
  return String(str).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] === undefined ? '' : String(vars[k])));
}

function quoteWin(s) {
  const t = String(s);
  if (!t) return '""';
  if (!/[\s"&|<>^()]/.test(t)) return t;
  return '"' + t.replace(/"/g, '""') + '"';
}

function spawnRaw({ command, args, env, cwd }) {
  const childEnv = { ...process.env, ...env };
  if (process.platform === 'win32') {
    // .cmd shims (npm-installed CLIs) can only run through cmd.exe.
    const line = [command, ...args].map(quoteWin).join(' ');
    return spawn(line, { shell: true, env: childEnv, cwd: cwd || undefined, windowsHide: true });
  }
  return spawn(command, args, { env: childEnv, cwd: cwd || undefined });
}

function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    /* already gone */
  }
}

function buildPrompt(provider, messages, vars) {
  const fmt = provider.inputFormat || 'transcript';
  const sys = (messages || []).filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n\n');
  const turns = (messages || []).filter((m) => m.role !== 'system');
  const lastUser = [...turns].reverse().find((m) => m.role === 'user');
  const last = textOf(lastUser?.content);

  if (fmt === 'last') return last;
  if (fmt === 'json') return JSON.stringify({ system: sys || undefined, messages: turns }, null, 0);
  if (fmt === 'template') {
    return fill(provider.promptTemplate || '{{prompt}}', { ...vars, system: sys, prompt: last });
  }
  const header = sys ? `<system>\n${sys}\n</system>\n\n` : '';
  const body = turns
    .map((m) => `${m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'System' : 'User'}: ${textOf(m.content)}`)
    .join('\n\n');
  return header + body;
}

function parseJsonLine(obj) {
  // claude --output-format stream-json
  if (obj.type === 'stream_event' && obj.event) return { streamEvent: obj.event };
  if (obj.type === 'assistant' || obj.type === 'user') {
    const content = obj.message?.content;
    const text = Array.isArray(content)
      ? content.filter((c) => c.type === 'text').map((c) => c.text).join('')
      : textOf(content);
    return { assistant: text, id: obj.message?.id || obj.uuid || 'a' };
  }
  if (obj.type === 'result') {
    return { result: typeof obj.result === 'string' ? obj.result : textOf(obj.result), isError: obj.is_error };
  }
  if (obj.type === 'error') return { error: obj.message || obj.error?.message || 'cli error' };
  // generic json-lines dialects
  for (const k of ['delta', 'text', 'content', 'response', 'output']) {
    if (typeof obj[k] === 'string') return { generic: obj[k], key: k };
  }
  if (obj.choices?.[0]?.delta?.content) return { generic: obj.choices[0].delta.content };
  return {};
}

export async function* chat(ctx) {
  const { provider, model, signal, log } = ctx;
  const level = normalizeLevel(ctx.level);
  const vars = {
    model: model?.id || model?.alias || '',
    level,
    budget: (budgetsOf(provider)[level] || 0),
    on: level === 'off' ? 'false' : 'true',
    cwd: provider.cwd || ''
  };

  const args = (provider.args || [])
    .map((a) => fill(a, vars))
    .filter((a) => a !== '');
  const env = {};
  for (const [k, v] of Object.entries(provider.env || {})) env[k] = fill(v, vars);
  for (const [k, v] of Object.entries(provider.thinking?.env || {})) {
    if (level !== 'off' || provider.thinking.keepEnvWhenOff) env[k] = fill(v, vars);
  }

  const command = fill(provider.command, vars);
  const prompt = buildPrompt(provider, ctx.messages, vars);
  const fullPrompt = fill(provider.promptPrefix || '', vars) + prompt + fill(provider.promptSuffix || '', vars);
  log?.note?.(`thinking=${level} · ${command} ${args.join(' ')} · ${fullPrompt.length} chars`);

  const child = spawnRaw({ command, args, env, cwd: provider.cwd });
  // A model may override how this command's stdout is read (one binary, several
  // output modes), otherwise the provider default applies.
  const parser = model?.parser || provider.parser || 'raw';
  const diffs = new Map();
  const acc = { text: '' };
  let stderr = '';
  let exitInfo = null;
  let killedFor = '';

  const limit = provider.timeoutMs || 240000;
  let watchdog = null;
  const arm = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      killedFor = killedFor || 'timeout';
      killTree(child);
    }, limit);
  };
  arm();

  const cleanup = () => {
    clearTimeout(watchdog);
    signal?.removeEventListener?.('abort', onAbort);
  };
  const onAbort = () => {
    killedFor = 'aborted';
    killTree(child);
  };
  signal?.addEventListener?.('abort', onAbort, { once: true });

  child.on('error', (e) => {
    exitInfo = { code: -1, error: e.message };
  });
  child.stderr?.on('data', (d) => {
    stderr += d.toString();
    if (stderr.length > 20000) stderr = stderr.slice(-20000);
  });
  const exited = new Promise((resolve) => {
    child.on('close', (code) => {
      exitInfo = exitInfo || { code };
      resolve();
    });
  });

  try {
    if (child.stdin) {
      child.stdin.on('error', () => {});
      try {
        child.stdin.write(fullPrompt);
        child.stdin.end();
      } catch {
        /* spawn may have failed; the exit check below reports it */
      }
    }

    const emit = function* (delta) {
      if (delta) {
        acc.text += delta;
        yield { delta };
      }
    };

    let finalText = null;
    const objBuf = [];

    /** Consume one complete line of stdout. */
    const handleLine = function* (line) {
      const t = line.trim();
      if (!t) return;
      if (!killedFor) arm();
      if (parser === 'json-object') {
        objBuf.push(line);
        return;
      }

      let obj;
      try {
        obj = JSON.parse(t);
      } catch {
        return;
      }
      const ev = parseJsonLine(obj);

      if (ev.error) throw new Error(`cli: ${ev.error}`);
      if (ev.streamEvent) {
        const e = ev.streamEvent;
        if (e.type === 'content_block_delta') {
          if (e.delta?.type === 'text_delta' && e.delta.text) yield* emit(e.delta.text);
          if (e.delta?.type === 'thinking_delta' && e.delta.thinking) yield { reasoning: e.delta.thinking };
        }
        return;
      }
      if (ev.assistant !== undefined) {
        if (parser !== 'claude-stream') {
          yield* emit(ev.generic ?? ev.assistant);
          return;
        }
        const key = ev.id || 'a';
        if (!diffs.has(key)) diffs.set(key, new DeltaDiff());
        yield* emit(diffs.get(key).push(ev.assistant || ''));
        return;
      }
      if (ev.result !== undefined) {
        finalText = ev.result || '';
        if (ev.isError && !acc.text) throw new Error(`cli: ${finalText.slice(0, 500) || 'command failed'}`);
        return;
      }
      if (ev.generic !== undefined) {
        // A dialect that prints cumulative text: diff it against what we sent.
        const d = new DeltaDiff();
        d.sent = acc.text;
        yield* emit(d.push(ev.generic));
      }
    };

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      if (parser === 'raw') {
        // Forward bytes as they arrive: a CLI that prints without newlines
        // (or slowly) should still feel like a stream.
        for await (const chunk of child.stdout) {
          if (!killedFor) arm();
          yield* emit(chunk);
        }
      } else {
        let buf = '';
        for await (const chunk of child.stdout) {
          if (!killedFor) arm();
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, '');
            buf = buf.slice(nl + 1);
            yield* handleLine(line);
          }
        }
        if (buf.trim()) yield* handleLine(buf);
      }
    }

    await exited;
    if (killedFor === 'aborted') throw new Error('cli: aborted');
    if (killedFor) throw new Error('cli: timeout, no output for ' + limit + 'ms');
    if (exitInfo?.error) throw new Error(`cli: ${exitInfo.error}`);
    if (exitInfo && exitInfo.code !== 0 && !acc.text && parser !== 'json-object') {
      throw new Error(`cli exited ${exitInfo.code}${stderr ? ': ' + stderr.trim().slice(-600) : ''}`);
    }

    if (parser === 'json-object') {
      const raw = objBuf.join('\n').trim();
      let obj = null;
      try {
        obj = JSON.parse(raw);
      } catch {
        /* plain text output despite the setting */
      }
      if (obj?.error) throw new Error('cli: ' + (obj.error.message || JSON.stringify(obj.error)));
      let text = obj && typeof obj === 'object'
        ? obj.result ?? obj.response ?? obj.text ?? obj.content ?? obj.message ?? ''
        : raw;
      if (text && typeof text === 'object') text = JSON.stringify(text);
      if (!text) throw new Error(`cli: empty output${stderr ? ': ' + stderr.trim().slice(-400) : ''}`);
      yield* emit(text);
    }
    if (finalText) {
      const d = new DeltaDiff();
      d.sent = acc.text;
      yield* emit(d.push(finalText));
    }
    if (stderr && process.env.ROOK_DEBUG) log?.note?.(`stderr: ${stderr.slice(-400)}`);
    yield { usage: { prompt_chars: fullPrompt.length, completion_chars: acc.text.length } };
    yield { finish: 'stop' };
  } finally {
    cleanup();
    killTree(child);
  }
}
