/**
 * Real UI interaction test (headless Chrome over CDP): adds an upstream through
 * the console form, flips a thinking level, deletes it again, and checks the
 * resulting config each time.
 *   node tools/ui-test.mjs [baseUrl] [adminKey]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withPage } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.argv[2] || 'http://127.0.0.1:8790').replace(/\/+$/, '');
const ADMIN =
  process.argv[3] || JSON.parse(fs.readFileSync(path.join(HERE, '..', 'config.json'), 'utf8')).adminKey;

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✕ ' + name + (extra ? '  → ' + extra : ''));
  }
};

console.log(`\nrook UI test @ ${BASE}\n`);

await withPage({ url: `${BASE}/?key=${encodeURIComponent(ADMIN)}`, settle: 2200 }, async ({ send, evaluate, click, fill, sleep, shot, problems }) => {
  const getCfg = () =>
    evaluate(`fetch('/admin/api/state',{headers:{'x-admin-key':localStorage.getItem('rook.adminKey')}}).then(r=>r.json()).then(s=>s.config)`);

  const dropTestProvider = () =>
    evaluate(`(async () => {
      const s = await fetch('/admin/api/state',{headers:{'x-admin-key':localStorage.getItem('rook.adminKey')}}).then(r=>r.json());
      const list = s.config.providers.filter(p => p.id !== 'ui-test');
      await fetch('/admin/api/config',{method:'PUT',headers:{'content-type':'application/json','x-admin-key':localStorage.getItem('rook.adminKey')},body:JSON.stringify({providers:list})});
      return true;
    })()`);

  try {
    await dropTestProvider();

    // --- console is up -------------------------------------------------
    const gateHidden = await evaluate(`document.querySelector('#gate').hidden`);
    ok('admin key from URL unlocks console', gateHidden === true);

    // --- add an upstream through the form ------------------------------
    await click('.nav-item[data-tab="upstreams"]');
    await click('#p-add');
    ok('editor opens', await evaluate(`!document.querySelector('#modal').hidden`));

    // switching adapter type must rebuild the type-specific fields
    await fill('#m-type', 'proxy', 'change');
    await sleep(250);
    ok('proxy type renders its own field', await evaluate(`!!document.querySelector('#m-proxy-extra [data-fkey="rewriteModel"]')`));
    await fill('#m-type', 'cli', 'change');
    await sleep(250);
    ok('switching type clears the proxy field', await evaluate(`!document.querySelector('#m-proxy-extra [data-fkey="rewriteModel"]')`));

    await fill('#m-name', 'UI Test Upstream');
    await fill('#m-id', 'ui-test');
    await sleep(250);
    await fill('#m-fields [data-fkey="command"]', 'node');
    await fill('#m-fields [data-fkey="args"]', '--version\n--foo');
    await click('#m-addmodel');
    await fill('#m-models tbody tr:last-child [data-mid]', 'ui-echo');
    await fill('#m-models tbody tr:last-child [data-malias]', 'ui-alias');
    await click('#m-save');
    await sleep(500);

    let cfg = await getCfg();
    const p = cfg.providers.find((x) => x.id === 'ui-test');
    ok('form wrote provider into config', !!p, JSON.stringify(cfg.providers.map((x) => x.id)));
    ok('args split by line', JSON.stringify(p?.args) === JSON.stringify(['--version', '--foo']), JSON.stringify(p?.args));
    ok('model alias saved', p?.models?.[0]?.alias === 'ui-alias', JSON.stringify(p?.models));
    ok('editor closed after save', await evaluate(`document.querySelector('#modal').hidden`));

    // --- connect tab reflects it, thinking level persists --------------
    await click('.nav-item[data-tab="connect"]');
    const viewText = await evaluate(`document.querySelector('#view').textContent`);
    ok('connect tab lists the new model', viewText.includes('ui-alias'));

    await fill('[data-thinking="ui-test|ui-alias"]', 'high', 'change');
    await sleep(600);
    cfg = await getCfg();
    const p2 = cfg.providers.find((x) => x.id === 'ui-test');
    ok('thinking dropdown persisted', p2?.models?.[0]?.thinkingLevel === 'high', JSON.stringify(p2?.models?.[0]));

    await shot('ui-test-connect.png');

    // --- settings modal ------------------------------------------------
    await click('#btn-settings');
    ok('settings modal opens', await evaluate(`!!document.querySelector('#s-port')`));
    const shownPort = await evaluate(`document.querySelector('#s-port').value`);
    ok('settings shows current port', Number(shownPort) > 0, shownPort);
    await click('#s-cancel');
    ok('settings closes', await evaluate(`document.querySelector('#modal').hidden`));

    // --- delete --------------------------------------------------------
    await click('.nav-item[data-tab="upstreams"]');
    await evaluate(`window.confirm = () => true`);
    await click('[data-del="ui-test"]');
    await sleep(500);
    cfg = await getCfg();
    ok('delete removes provider', !cfg.providers.some((x) => x.id === 'ui-test'));

    // --- wrong admin key must not reveal the console -------------------
    await send('Page.navigate', { url: BASE + '/?key=wrong-key' });
    await sleep(1800);
    ok('bad admin key falls back to the gate', await evaluate(`!document.querySelector('#gate').hidden`));
    ok('console stays hidden without a valid key', await evaluate(`document.querySelector('#app').hidden === true`));
    ok('wrong key is not remembered', await evaluate(`!localStorage.getItem('rook.adminKey')`));

    const errs = problems().filter((x) => !x.includes('401')); // the deliberate 401 above
    ok('no runtime errors', errs.length === 0, errs.join(' | '));
  } finally {
    await dropTestProvider().catch(() => {});
  }
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
