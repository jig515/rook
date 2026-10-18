/**
 * Headless screenshot + console capture via raw CDP (no npm deps).
 *   node tools/shot.mjs <baseUrl> <adminKey> <outPrefix>
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME =
  process.env.CHROME ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = (process.argv[2] || 'http://127.0.0.1:8790').replace(/\/+$/, '');
const ADMIN = process.argv[3];
const PREFIX = process.argv[4] || 'shot';
const PORT = 9333;
const W = 1460;
const H = 940;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userDir = path.join(os.tmpdir(), 'rook-shot-' + Date.now());

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    `--window-size=${W},${H}`,
    'about:blank'
  ],
  { stdio: 'ignore', windowsHide: true }
);

async function waitChrome() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return r.json();
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error('chrome did not start');
}

const version = await waitChrome();
console.log('chrome', version['Browser']);

const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
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

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: W,
  height: H,
  deviceScaleFactor: 1,
  mobile: false
});

async function shot(name) {
  await sleep(700);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(process.cwd(), `${PREFIX}-${name}.png`);
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  console.log('wrote', file);
}

const url = `${BASE}/?key=${encodeURIComponent(ADMIN)}`;
await send('Page.navigate', { url });
await sleep(2200);
await shot('connect');

await send('Runtime.evaluate', {
  expression: `document.querySelector('[data-tab="upstreams"]').click()`
});
await shot('upstreams');

await send('Runtime.evaluate', {
  expression: `document.querySelector('[data-edit]')?.click()`
});
await shot('editor');
await send('Runtime.evaluate', {
  expression: `document.querySelector('#m-close')?.click()`
});
await sleep(200);

await send('Runtime.evaluate', {
  expression: `document.querySelector('[data-tab="logs"]').click()`
});
await sleep(400);
// trigger a request so the live SSE tail has something to show
await send('Runtime.evaluate', {
  expression: `fetch('/admin/api/test',{method:'POST',headers:{'content-type':'application/json','x-admin-key':localStorage.getItem('rook.adminKey')},body:JSON.stringify({providerId:'demo',model:'echo-deep',prompt:'live log check',level:'high'})}).then(r=>r.status)`,
  awaitPromise: true,
  returnByValue: true
});
await sleep(600);
await shot('logs');

// verify the console can still talk to its own admin API (Origin checks)
const probe = await send('Runtime.evaluate', {
  expression: `Promise.all([
    fetch('/admin/api/state',{headers:{'x-admin-key':localStorage.getItem('rook.adminKey')}}).then(r=>r.status),
    fetch('/admin/api/config',{method:'PUT',headers:{'content-type':'application/json','x-admin-key':localStorage.getItem('rook.adminKey')},body:JSON.stringify({logLimit:300})}).then(r=>r.status)
  ])`,
  awaitPromise: true,
  returnByValue: true
});
console.log('admin from page (GET/PUT):', JSON.stringify(probe.result?.result?.value));

// capture problems
const problems = events.filter(
  (e) =>
    e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
);
if (problems.length) {
  console.log('\n--- console problems ---');
  for (const p of problems) {
    if (p.method === 'Runtime.exceptionThrown') {
      console.log('EXC', p.params.exceptionDetails?.exception?.description || p.params.exceptionDetails?.text);
    } else if (p.method === 'Runtime.consoleAPICalled') {
      console.log('ERR', p.params.args?.map((a) => a.value ?? a.description).join(' '));
    } else {
      console.log('LOG', p.params.entry.text);
    }
  }
} else {
  console.log('\nno console errors');
}

ws.close();
chrome.kill();
await sleep(300);
try {
  fs.rmSync(userDir, { recursive: true, force: true });
} catch {
  /* locked */
}
process.exit(0);
