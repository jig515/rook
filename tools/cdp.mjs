/**
 * Minimal CDP driver: starts headless Chrome, exposes send/eval/screenshot,
 * tears everything down afterwards. No npm dependencies.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function withPage(opts, fn) {
  const width = opts.width || 1460;
  const height = opts.height || 940;
  const port = 9300 + Math.floor(Math.random() * 400);
  const userDir = path.join(os.tmpdir(), 'rook-cdp-' + Date.now());

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      `--window-size=${width},${height}`,
      'about:blank'
    ],
    { stdio: 'ignore', windowsHide: true }
  );

  const cleanup = async () => {
    try {
      chrome.kill();
    } catch {
      /* already gone */
    }
    await sleep(300);
    try {
      fs.rmSync(userDir, { recursive: true, force: true });
    } catch {
      /* locked by chrome */
    }
  };

  let ws;
  try {
    let version = null;
    for (let i = 0; i < 80 && !version; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (r.ok) version = await r.json();
      } catch {
        await sleep(150);
      }
    }
    if (!version) throw new Error('chrome did not start');

    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const page = targets.find((t) => t.type === 'page');

    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });

    let msgId = 0;
    const pending = new Map();
    const events = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      } else {
        events.push(m);
      }
    });

    const send = (method, params = {}) =>
      new Promise((res) => {
        const id = ++msgId;
        pending.set(id, res);
        ws.send(JSON.stringify({ id, method, params }));
      });

    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      });
      const ex = r.result?.exceptionDetails;
      if (ex) throw new Error(ex.exception?.description || ex.text || 'eval threw');
      return r.result?.result?.value;
    };

    const click = async (selector) => {
      const done = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.click();
        return true;
      })()`);
      if (!done) throw new Error('selector not found: ' + selector);
      await sleep(120);
    };

    const fill = async (selector, value, fire = 'input') => {
      const done = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event(${JSON.stringify(fire)}, { bubbles: true }));
        return true;
      })()`);
      if (!done) throw new Error('field not found: ' + selector);
    };

    const shot = async (file) => {
      await sleep(500);
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
      return file;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    });

    if (opts.url) {
      await send('Page.navigate', { url: opts.url });
      await sleep(opts.settle || 2000);
    }

    const problems = () =>
      events
        .filter(
          (e) =>
            e.method === 'Runtime.exceptionThrown' ||
            (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
            (e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
        )
        .map((p) => {
          if (p.method === 'Runtime.exceptionThrown') {
            return 'EXC ' + (p.params.exceptionDetails?.exception?.description || p.params.exceptionDetails?.text);
          }
          if (p.method === 'Runtime.consoleAPICalled') {
            return 'ERR ' + p.params.args?.map((a) => a.value ?? a.description).join(' ');
          }
          return 'LOG ' + p.params.entry.text;
        });

    return await fn({ send, evaluate, click, fill, shot, sleep, problems, version });
  } finally {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    await cleanup();
  }
}
