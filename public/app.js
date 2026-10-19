/* rook console */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  key: localStorage.getItem('rook.adminKey') || '',
  cfg: null,
  adapters: [],
  levels: ['off', 'low', 'medium', 'high', 'max'],
  models: [],
  baseUrl: '',
  version: '',
  hubUrl: '',
  tab: 'connect',
  logs: [],
  live: true,
  autoScroll: true
};

/* ------------------------------------------------------------------ api */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      'x-admin-key': state.key,
      ...(opts.headers || {})
    }
  });
  let json = {};
  try {
    json = await res.json();
  } catch {
    /* empty */
  }
  if (res.status === 401) {
    localStorage.removeItem('rook.adminKey');
    state.key = '';
    $('#gate').hidden = false;
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
  return json;
}

async function loadState() {
  const s = await api('/admin/api/state');
  state.cfg = s.config;
  state.adapters = s.adapters;
  state.levels = s.levels;
  state.models = s.models;
  state.baseUrl = s.baseUrl;
  state.version = s.version;
  state.hubUrl = location.origin;
  $('#ver').textContent = 'v' + s.version;
  $('#pill-endpoint').textContent = location.origin;
  renderRail();
}

async function saveConfig(patch) {
  const next = patch ? { ...state.cfg, ...patch } : state.cfg;
  const r = await api('/admin/api/config', { method: 'PUT', body: JSON.stringify(next) });
  state.cfg = r.config;
  await loadState();
  if (r.restartRequired) toast('端口/监听地址已改，重启进程后生效', 'ok');
  return r;
}

/* --------------------------------------------------------------- helpers */

function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast ' + kind;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 2600);
}

async function copy(text, label = '已复制') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(label, 'ok');
}

const fmtTime = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });

function providerById(id) {
  return (state.cfg?.providers || []).find((p) => p.id === id);
}

function adapterMeta(type) {
  return state.adapters.find((a) => a.type === type) || { fields: [] };
}

/* ------------------------------------------------------------------ rail */

function renderRail() {
  $('#model-count').textContent = state.models.length;
  $('#rail-model-list').innerHTML = state.models.length
    ? state.models
        .map(
          (m) =>
            `<div class="rail-model" title="${esc(m.providerName)} · ${esc(m.upstreamId)}">
               <span>${esc(m.name)}</span><em>${esc(m.thinkingLevel)}</em>
             </div>`
        )
        .join('')
    : `<div class="rail-model"><span style="color:var(--faint)">无 —— 去「上游」添加</span></div>`;
}

/* ----------------------------------------------------------------- views */

function render() {
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  const titles = { connect: '接入', upstreams: '上游', logs: '日志' };
  $('#top-title').textContent = titles[state.tab];
  if (state.tab === 'connect') renderConnect();
  if (state.tab === 'upstreams') renderUpstreams();
  if (state.tab === 'logs') renderLogs();
}

/* ---- connect ---- */

function renderConnect() {
  const base = state.hubUrl + '/v1';
  const models = state.models;
  $('#view').innerHTML = `
    <div class="card">
      <div class="card-head"><h2>端点</h2><span class="sub">把这两个填进酒馆</span></div>
      <div class="kv">
        <label>Base URL</label>
        <div class="copy-row">
          <input id="c-base" type="text" readonly value="${esc(base)}" />
          <button class="btn small" data-copy="c-base">复制</button>
        </div>
        <label>API Key</label>
        <div class="copy-row">
          <input id="c-key" type="text" readonly value="${esc(state.cfg.apiKey || '')}" />
          <button class="btn small" data-copy="c-key">复制</button>
          <button class="btn small ghost" id="c-regen">重新生成</button>
        </div>
        <label>模型</label>
        <div class="row wrap">
          ${
            models.length
              ? models.map((m) => `<span class="model-tag"><b>${esc(m.name)}</b><span>${esc(m.thinkingLevel)}</span></span>`).join('')
              : '<span class="empty" style="padding:0">暂无</span>'
          }
        </div>
      </div>
      ${
        state.cfg.apiKey
          ? ''
          : `<div class="note" style="margin-top:14px">当前未设 API Key，任何本机程序都能调用。设置密码可避免别的网页借用你的额度。</div>`
      }
    </div>

    <div class="card">
      <div class="card-head">
        <h2>模型 × 思考强度</h2>
        <span class="sub">改完立即生效，不用重启</span>
        <div class="spacer"></div>
        <button class="btn small ghost" id="c-add">＋ 添加上游</button>
      </div>
      ${
        models.length
          ? `<div class="table-wrap"><table>
              <thead><tr><th>对外模型名</th><th>上游模型 id</th><th>经由</th><th style="width:150px">思考强度</th></tr></thead>
              <tbody>
                ${models
                  .map(
                    (m) => `<tr>
                      <td class="mono">${esc(m.name)}</td>
                      <td class="mono" style="color:var(--dim)">${esc(m.upstreamId)}</td>
                      <td style="color:var(--dim)">${esc(m.providerName)}</td>
                      <td>
                        <select data-thinking="${esc(m.providerId)}|${esc(m.name)}">
                          ${state.levels
                            .map((l) => `<option value="${l}" ${l === m.thinkingLevel ? 'selected' : ''}>${l}</option>`)
                            .join('')}
                        </select>
                      </td>
                    </tr>`
                  )
                  .join('')}
              </tbody>
            </table></div>`
          : `<div class="empty">还没有在线模型。先在「上游」里配置一个 command 或中转。</div>`
      }
    </div>

    <div class="card">
      <div class="card-head"><h2>接到 SillyTavern</h2></div>
      <ol class="steps">
        <li>酒馆 → <code>API 连接</code> → <code>Chat Completion</code>，API 选 <code>Custom (OpenAI-compatible)</code></li>
        <li><b>Custom Endpoint</b> 填 <code>${esc(base)}</code>（结尾带 /v1）</li>
        <li><b>Custom API Key</b> 填上面那串 key</li>
        <li>点 <b>Connect</b> / 拉模型列表，选一个模型名</li>
        <li>思考强度在这里改，不要指望酒馆传 —— 酒馆不认这个概念</li>
      </ol>
      <div class="note" style="margin-top:14px">
        command 类上游（Claude Code / Gemini CLI / Codex）在酒馆里也能当普通模型用，
        但每个请求都会起一个进程，慢且有额度限制 —— 适合单人低并发。
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>联通测试</h2><span class="sub">走完整链路，等价于酒馆发一次请求</span></div>
      <div class="grid-2">
        <div class="field">
          <label>模型</label>
          <select id="t-model">${models.map((m) => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('')}</select>
        </div>
        <div class="field">
          <label>思考强度</label>
          <select id="t-level">${state.levels.map((l) => `<option value="${l}" ${l === 'medium' ? 'selected' : ''}>${l}</option>`).join('')}</select>
        </div>
      </div>
      <div class="field">
        <label>Prompt</label>
        <textarea id="t-prompt">用一句话介绍你自己。</textarea>
      </div>
      <button class="btn primary" id="t-run" ${models.length ? '' : 'disabled'}>发送</button>
      <div id="t-out" class="test-out" hidden></div>
    </div>
  `;

  $$('[data-copy]').forEach((b) =>
    b.addEventListener('click', () => copy($('#' + b.dataset.copy).value))
  );
  $('#c-add')?.addEventListener('click', () => { state.tab = 'upstreams'; render(); openEditor(null); });
  $('#c-regen')?.addEventListener('click', async () => {
    if (!confirm('重新生成 API Key？酒馆那边要同步改。')) return;
    await api('/admin/api/keys', { method: 'POST', body: JSON.stringify({ apiKey: 'generate' }) });
    await loadState();
    render();
    toast('新 key 已生成', 'ok');
  });
  $$('[data-thinking]').forEach((sel) =>
    sel.addEventListener('change', async () => {
      const [pid, name] = sel.dataset.thinking.split('|');
      const p = providerById(pid);
      const m = (p?.models || []).find((x) => (x.alias || x.id) === name);
      if (!m) return;
      m.thinkingLevel = sel.value;
      try {
        await saveConfig();
        toast(`${name} → ${sel.value}`, 'ok');
      } catch (e) {
        toast('保存失败：' + e.message, 'err');
        await loadState();
        render();
      }
    })
  );
  $('#t-run')?.addEventListener('click', runTest);
}

async function runTest() {
  const btn = $('#t-run');
  const out = $('#t-out');
  out.hidden = false;
  out.className = 'test-out';
  out.textContent = '请求中…';
  btn.disabled = true;
  const t0 = Date.now();
  try {
    const res = await fetch(state.hubUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (state.cfg.apiKey || '') },
      body: JSON.stringify({
        model: $('#t-model').value,
        messages: [{ role: 'user', content: $('#t-prompt').value }],
        thinking_level: $('#t-level').value,
        stream: false,
        max_tokens: 512
      })
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error?.message || 'HTTP ' + res.status);
    const msg = json.choices?.[0]?.message || {};
    out.textContent =
      (msg.reasoning_content ? `[思考 ${msg.reasoning_content.length} 字]\n${msg.reasoning_content.slice(0, 400)}\n\n` : '') +
      (msg.content || '(空)') +
      `\n\n— ${Date.now() - t0}ms · ${json.usage?.total_tokens ?? '?'} tokens`;
  } catch (e) {
    out.className = 'test-out err';
    out.textContent = '✕ ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

/* ---- upstreams ---- */

function renderUpstreams() {
  const list = state.cfg.providers || [];
  $('#view').innerHTML = `
    <div class="row" style="margin-bottom:14px">
      <div class="empty" style="padding:0;text-align:left;flex:1">
        一条上游 = 一个后端。command、中转、反代都挂在这里，模型名对外统一。
      </div>
      <button class="btn primary" id="p-add">＋ 添加上游</button>
    </div>
    <div class="provider-grid">
      ${
        list.length
          ? list
              .map((p) => {
                const on = p.enabled && (p.models || []).length;
                return `<div class="provider ${p.enabled ? '' : 'disabled'}">
                  <div class="provider-top">
                    <div style="flex:1">
                      <div class="provider-name">${esc(p.name || p.id)}</div>
                      <div class="provider-type">${esc(p.type)} · ${esc(p.id)}</div>
                    </div>
                    <label class="switch"><input type="checkbox" data-toggle="${esc(p.id)}" ${p.enabled ? 'checked' : ''} /><i></i></label>
                  </div>
                  <div class="provider-models">
                    ${
                      (p.models || []).length
                        ? p.models
                            .map(
                              (m) =>
                                `<span class="model-tag"><b>${esc(m.alias || m.id)}</b><span>${esc(m.thinkingLevel || 'off')}</span></span>`
                            )
                            .join('')
                        : '<span class="chip off">没有模型</span>'
                    }
                  </div>
                  <div class="row" style="gap:8px">
                    <span class="chip ${on ? 'ok' : 'off'}">${on ? 'online' : 'offline'}</span>
                    <div class="spacer" style="flex:1"></div>
                    <button class="btn small" data-edit="${esc(p.id)}">编辑</button>
                    <button class="btn small ghost" data-test="${esc(p.id)}">测试</button>
                    <button class="btn small danger" data-del="${esc(p.id)}">删除</button>
                  </div>
                </div>`;
              })
              .join('')
          : `<div class="provider"><div class="empty">空。点右上角加一条。</div></div>`
      }
    </div>
    <div id="p-test-out"></div>
  `;

  $('#p-add').addEventListener('click', () => openEditor(null));
  $$('[data-edit]').forEach((b) => b.addEventListener('click', () => openEditor(providerById(b.dataset.edit))));
  $$('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      const p = providerById(b.dataset.del);
      if (!confirm(`删除上游「${p?.name || b.dataset.del}」？`)) return;
      state.cfg.providers = state.cfg.providers.filter((x) => x.id !== b.dataset.del);
      await saveConfig();
      render();
      toast('已删除', 'ok');
    })
  );
  $$('[data-toggle]').forEach((el) =>
    el.addEventListener('change', async () => {
      const p = providerById(el.dataset.toggle);
      p.enabled = el.checked;
      await saveConfig();
      render();
    })
  );
  $$('[data-test]').forEach((b) =>
    b.addEventListener('click', async () => {
      const p = providerById(b.dataset.test);
      const box = $('#p-test-out');
      box.innerHTML = `<div class="test-out">测试中…（command 类可能要几十秒）</div>`;
      const r = await api('/admin/api/test', {
        method: 'POST',
        body: JSON.stringify({ providerId: p.id, prompt: 'Say "rook ok" and nothing else.' })
      });
      box.innerHTML = `<div class="test-out ${r.ok ? '' : 'err'}">${
        r.ok
          ? esc(r.text || '(空响应)') + `\n\n— ${r.ms}ms`
          : '✕ ' + esc(r.error)
      }</div>`;
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    })
  );
}

/* ---- provider editor modal ---- */

function fieldHtml(f, value) {
  const id = 'f-' + f.key;
  const v = value ?? '';
  if (f.json) {
    const text = v ? JSON.stringify(v, null, 2) : '';
    const rows = Math.min(12, Math.max(3, text.split('\n').length + 1));
    return `<div class="field"><label>${esc(f.label)}</label>
      <textarea data-fkey="${esc(f.key)}" data-ftype="json" rows="${rows}">${esc(text)}</textarea></div>`;
  }
  if (f.list) {
    const text = Array.isArray(v) ? v.join('\n') : '';
    const rows = Math.min(14, Math.max(4, text.split('\n').length + 1));
    return `<div class="field"><label>${esc(f.label)}</label>
      <textarea data-fkey="${esc(f.key)}" data-ftype="list" rows="${rows}">${esc(text)}</textarea>
      <div class="hint">每行一个参数。可用 {{model}} {{level}} {{budget}} {{on}}</div></div>`;
  }
  if (f.enum) {
    return `<div class="field"><label>${esc(f.label)}</label>
      <select data-fkey="${esc(f.key)}" data-ftype="text">
        ${f.enum.map((o) => `<option ${String(v) === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
      </select></div>`;
  }
  if (f.textarea) {
    return `<div class="field"><label>${esc(f.label)}</label>
      <textarea data-fkey="${esc(f.key)}" data-ftype="text">${esc(v)}</textarea></div>`;
  }
  return `<div class="field"><label>${esc(f.label)}</label>
    <input id="${id}" type="${f.secret ? 'password' : f.number ? 'number' : 'text'}"
      data-fkey="${esc(f.key)}" data-ftype="${f.number ? 'number' : 'text'}"
      value="${esc(v)}" placeholder="${esc(f.placeholder || '')}" /></div>`;
}

const THINKING_STYLES = [
  ['none', '不发送思考参数'],
  ['reasoning_effort', 'reasoning_effort（OpenAI / 多数中转）'],
  ['openrouter_reasoning', 'reasoning.effort（OpenRouter 风格）'],
  ['qwen_enable', 'enable_thinking + budget（Qwen / vLLM）'],
  ['gemini_budget', 'generationConfig.thinkingConfig（Gemini）'],
  ['custom', '自定义 JSON 模板']
];

function proxyExtraHtml(p) {
  return `<div class="field"><label>model 字段是否替换为上游 id</label>
    <select data-fkey="rewriteModel" data-ftype="bool">
      <option value="1" ${p.rewriteModel !== false ? 'selected' : ''}>是</option>
      <option value="0" ${p.rewriteModel === false ? 'selected' : ''}>否，原样透传</option>
    </select></div>`;
}

function openEditor(provider) {
  const isNew = !provider;
  $('#modal').hidden = false;
  const p = provider
    ? JSON.parse(JSON.stringify(provider))
    : {
        id: 'upstream-' + Math.random().toString(36).slice(2, 6),
        name: '',
        type: state.adapters[0]?.type || 'openai',
        enabled: true,
        models: [],
        thinking: { style: 'none' }
      };
  const ad = adapterMeta(p.type);

  $('#modal-panel').innerHTML = `
    <div class="modal-head"><h2>${isNew ? '添加上游' : '编辑上游'}</h2>
      <button class="btn ghost small" id="m-close">✕</button></div>

    <div class="grid-2">
      <div class="field"><label>显示名称</label><input id="m-name" type="text" value="${esc(p.name || '')}" placeholder="例如 Claude Code / 某中转" /></div>
      <div class="field"><label>标识 id</label><input id="m-id" type="text" value="${esc(p.id)}" ${isNew ? '' : 'readonly style="opacity:.6"'} /></div>
    </div>
    <div class="grid-2">
      <div class="field"><label>类型</label>
        <select id="m-type">${state.adapters
          .map((a) => `<option value="${a.type}" ${a.type === p.type ? 'selected' : ''}>${esc(a.label)}</option>`)
          .join('')}</select></div>
      <div class="field"><label>状态</label>
        <select id="m-enabled">
          <option value="1" ${p.enabled ? 'selected' : ''}>启用</option>
          <option value="0" ${!p.enabled ? 'selected' : ''}>停用</option>
        </select></div>
    </div>

    <div class="section-label">上游参数</div>
    <div id="m-fields">${ad.fields.map((f) => fieldHtml(f, p[f.key])).join('')}</div>
    <div id="m-proxy-extra">${p.type === 'proxy' ? proxyExtraHtml(p) : ''}</div>

    <div class="field"><label>出网</label>
      <select id="m-useproxy">
        <option value="0" ${!p.useProxy ? 'selected' : ''}>直连</option>
        <option value="1" ${p.useProxy ? 'selected' : ''}>走代理（设置里的地址）</option>
      </select>
      <div class="hint">标"直连"的地址会自动加进 NO_PROXY，本机地址永远直连。</div></div>

    <div class="section-label">思考强度映射</div>
    <div class="grid-2">
      <div class="field"><label>发送方式</label>
        <select id="m-tstyle">
          ${THINKING_STYLES.map(([v, l]) => `<option value="${v}" ${(p.thinking?.style || 'none') === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
        </select></div>
      <div class="field"><label>预算（off/low/medium/high/max）</label>
        <input id="m-tbudget" type="text" value="${esc(
          ['off', 'low', 'medium', 'high', 'max']
            .map((k) => k + ':' + (p.thinking?.budgets?.[k] ?? { off: 0, low: 1024, medium: 4096, high: 16384, max: 32768 }[k]))
            .join(' ')
        )}" placeholder="low:1024 medium:4096" /></div>
    </div>
    <div class="field"><label>自定义模板（style=custom 时使用，JSON）</label>
      <textarea id="m-ttemplate" data-ftype="json">${esc(p.thinking?.template ? JSON.stringify(p.thinking.template, null, 2) : '')}</textarea>
      <div class="hint">占位符：{{level}} {{budget}} {{on}}。例如 {"reasoning":{"effort":"{{level}}"}}</div></div>

    <div class="section-label">模型</div>
    <div class="table-wrap"><table id="m-models">
      <thead><tr><th>上游模型 id</th><th>对外名称（可留空）</th><th style="width:130px">默认思考</th><th style="width:40px"></th></tr></thead>
      <tbody></tbody>
    </table></div>
    <div class="row" style="margin-top:8px">
      <button class="btn small" id="m-addmodel">＋ 一行</button>
      <button class="btn small ghost" id="m-discover">从上游拉取</button>
    </div>

    <div class="modal-foot">
      <button class="btn ghost" id="m-cancel">取消</button>
      <button class="btn primary" id="m-save">保存</button>
    </div>
  `;

  const tbody = $('#m-models tbody');
  const addRow = (m = {}) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="text" data-mid value="${esc(m.id || '')}" placeholder="gpt-4o" /></td>
      <td><input type="text" data-malias value="${esc(m.alias || '')}" placeholder="可选" /></td>
      <td><select data-mlevel>${state.levels
        .map((l) => `<option value="${l}" ${(m.thinkingLevel || 'off') === l ? 'selected' : ''}>${l}</option>`)
        .join('')}</select></td>
      <td><button class="btn icon danger" data-mdel>✕</button></td>`;
    tr.querySelector('[data-mdel]').addEventListener('click', () => tr.remove());
    tbody.appendChild(tr);
  };
  (p.models || []).forEach(addRow);
  if (!(p.models || []).length) addRow();

  $('#m-addmodel').addEventListener('click', () => addRow({}));
  $('#m-close').addEventListener('click', closeModal);
  $('#m-cancel').addEventListener('click', closeModal);
  $('.modal-backdrop').onclick = closeModal;

  $('#m-type').addEventListener('change', (e) => {
    p.type = e.target.value;
    const ad2 = adapterMeta(p.type);
    $('#m-fields').innerHTML = ad2.fields.map((f) => fieldHtml(f, p[f.key])).join('');
    $('#m-proxy-extra').innerHTML = p.type === 'proxy' ? proxyExtraHtml(p) : '';
  });

  $('#m-discover').addEventListener('click', async () => {
    const btn = $('#m-discover');
    btn.textContent = '拉取中…';
    try {
      collect(); // read the form; nothing is written to config here
      const r = await api('/admin/api/discover', { method: 'POST', body: JSON.stringify({ provider: p }) });
      const tbody2 = $('#m-models tbody');
      const have = new Set([...tbody2.querySelectorAll('[data-mid]')].map((i) => i.value.trim()).filter(Boolean));
      // drop the blank starter row before adding real ones
      if (tbody2.children.length === 1 && !tbody2.children[0].querySelector('[data-mid]').value.trim()) {
        tbody2.children[0].remove();
      }
      let added = 0;
      for (const m of r.models || []) {
        if (!m.id || have.has(m.id)) continue;
        addRow({ id: m.id });
        added++;
      }
      toast(`拉到 ${r.models.length} 个模型，补入 ${added} 个`, 'ok');
    } catch (e) {
      toast('拉取失败：' + e.message, 'err');
    } finally {
      btn.textContent = '从上游拉取';
    }
  });

  function collect() {
    p.name = $('#m-name').value.trim();
    p.id = ($('#m-id').value || p.id).trim();
    p.enabled = $('#m-enabled').value === '1';
    p.type = $('#m-type').value;
    for (const el of $$('#m-fields [data-fkey], #m-proxy-extra [data-fkey]')) {
      const k = el.dataset.fkey;
      const t = el.dataset.ftype;
      if (t === 'json') {
        const raw = el.value.trim();
        if (raw) {
          try {
            p[k] = JSON.parse(raw);
          } catch {
            throw new Error(`${k} 不是合法 JSON`);
          }
        } else delete p[k];
      } else if (t === 'list') {
        p[k] = el.value.split('\n').map((s) => s.trim()).filter(Boolean);
      } else if (t === 'number') {
        const n = Number(el.value);
        if (el.value !== '' && !Number.isNaN(n)) p[k] = n;
        else delete p[k];
      } else if (t === 'bool') {
        p[k] = el.value === '1';
      } else {
        if (el.value !== '') p[k] = el.value;
        else delete p[k];
      }
    }
    // thinking
    p.useProxy = $('#m-useproxy').value === '1';
    const style = $('#m-tstyle').value;
    const budgets = {};
    for (const part of $('#m-tbudget').value.split(/[\s,，]+/)) {
      const m = part.match(/^(\w+):(\d+)$/);
      if (m) budgets[m[1]] = Number(m[2]);
    }
    const tplRaw = $('#m-ttemplate').value.trim();
    let template = null;
    if (tplRaw) {
      try {
        template = JSON.parse(tplRaw);
      } catch {
        throw new Error('思考模板不是合法 JSON');
      }
    }
    p.thinking = { ...(style === 'none' ? {} : { style }), budgets, ...(template ? { template } : {}) };
    if (style === 'none') p.thinking.style = 'none';
    // models
    p.models = [...tbody.querySelectorAll('tr')]
      .map((tr) => {
        const id = tr.querySelector('[data-mid]').value.trim();
        const alias = tr.querySelector('[data-malias]').value.trim();
        const thinkingLevel = tr.querySelector('[data-mlevel]').value;
        if (!id && !alias) return null;
        return { id: id || alias, ...(alias ? { alias } : {}), thinkingLevel };
      })
      .filter(Boolean);
  }

  $('#m-save').addEventListener('click', async () => {
    try {
      collect();
      if (!p.id) throw new Error('id 不能为空');
      if (isNew && state.cfg.providers.some((x) => x.id === p.id)) throw new Error('id 已存在');
      if (isNew) state.cfg.providers.push(p);
      else state.cfg.providers = state.cfg.providers.map((x) => (x.id === provider.id ? p : x));
      await saveConfig();
      closeModal();
      render();
      toast('已保存', 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  });
}

function closeModal() {
  $('#modal').hidden = true;
  $('#modal-panel').innerHTML = '';
}

/* ---- logs ---- */

function renderLogs() {
  $('#view').innerHTML = `
    <div class="log-toolbar">
      <button class="btn small" id="l-toggle">${state.autoScroll ? '暂停滚动' : '继续滚动'}</button>
      <button class="btn small ghost" id="l-clear">清屏</button>
      <span class="chip" id="l-count">${state.logs.length}</span>
      <div style="flex:1"></div>
      <span class="sub" style="color:var(--faint);font-size:12px">每条请求都会在这里留痕</span>
    </div>
    <div class="logs" id="l-box"></div>
  `;
  paintLogs(true);
  $('#l-toggle').addEventListener('click', () => {
    state.autoScroll = !state.autoScroll;
    $('#l-toggle').textContent = state.autoScroll ? '暂停滚动' : '继续滚动';
  });
  $('#l-clear').addEventListener('click', () => {
    state.logs = [];
    paintLogs(true);
  });
}

function logLine(e) {
  const cls = [
    'log-line',
    e.kind === 'request' ? 'req' : '',
    e.state === 'ok' ? 'ok' : e.state === 'error' ? 'error' : ''
  ].join(' ');
  const raw = e.detail ? String(e.detail) : '';
  const detail = raw.length > 96 ? raw.slice(0, 96) + '…' : raw;
  const meta = [detail, !e.summary && e.ms ? e.ms + 'ms' : ''].filter(Boolean).join(' · ');
  return `<div class="${cls}" title="${esc(e.detail || '')}"><span class="log-time">${fmtTime(e.ts)}</span><span class="log-lvl ${esc(e.level)}">${esc(e.level)}</span><span class="log-msg">${esc(e.msg)}${
    meta ? ` <span class="log-meta">${esc(meta)}</span>` : ''
  }</span></div>`;
}

function paintLogs(force = false) {
  const box = $('#l-box');
  if (!box) return;
  if (force) box.innerHTML = state.logs.map(logLine).join('') || '<div class="empty">还没有记录</div>';
  const c = $('#l-count');
  if (c) c.textContent = state.logs.length;
  if (state.autoScroll) box.scrollTop = box.scrollHeight;
}

function pushLog(e) {
  state.logs.push(e);
  if (state.logs.length > 400) state.logs.shift();
  if (state.tab === 'logs') {
    const box = $('#l-box');
    if (box) {
      if (box.firstElementChild?.classList.contains('empty')) box.innerHTML = '';
      box.insertAdjacentHTML('beforeend', logLine(e));
      const c = $('#l-count');
      if (c) c.textContent = state.logs.length;
      if (state.autoScroll) box.scrollTop = box.scrollHeight;
    }
  } else {
    const c = $('#l-count');
    if (c) c.textContent = state.logs.length;
  }
}

function connectLogs() {
  // backlog first
  api('/admin/api/logs?limit=200')
    .then((r) => {
      state.logs = r.logs || [];
      if (state.tab === 'logs') paintLogs(true);
    })
    .catch(() => {});

  // Live tail over fetch + ReadableStream: keeps the admin key in a header
  // instead of the query string, where it would end up in URLs and referrers.
  const ctrl = new AbortController();
  (async () => {
    while (!ctrl.signal.aborted) {
      try {
        const res = await fetch('/admin/api/logs/stream', {
          headers: { 'x-admin-key': state.key },
          signal: ctrl.signal
        });
        if (!res.ok || !res.body) throw new Error('stream ' + res.status);
        $('#live-dot').classList.add('live');
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of block.split('\n')) {
              if (!line.startsWith('data: ')) continue;
              try {
                pushLog(JSON.parse(line.slice(6)));
              } catch {
                /* keep-alive noise */
              }
            }
          }
        }
      } catch (e) {
        if (ctrl.signal.aborted) return;
      }
      $('#live-dot').classList.remove('live');
      await new Promise((r) => setTimeout(r, 3000));
    }
  })();
}

/* ---- settings ---- */

function openSettings() {
  const c = state.cfg;
  $('#modal').hidden = false;
  $('#modal-panel').innerHTML = `
    <div class="modal-head"><h2>设置</h2><button class="btn ghost small" id="s-close">✕</button></div>
    <div class="grid-2">
      <div class="field"><label>端口</label><input id="s-port" type="number" value="${esc(c.port)}" /></div>
      <div class="field"><label>监听地址</label><input id="s-host" type="text" value="${esc(c.host)}" />
        <div class="hint">127.0.0.1 仅本机；0.0.0.0 允许酒馆从局域网访问</div></div>
    </div>
    <div class="grid-2">
      <div class="field"><label>首字节超时 (ms)</label><input id="s-timeout" type="number" value="${esc(c.timeoutMs)}" /></div>
      <div class="field"><label>中途静默超时 (ms)</label><input id="s-idle" type="number" value="${esc(c.idleTimeoutMs || 60000)}" /></div>
      <div class="field"><label>日志保留条数</label><input id="s-loglimit" type="number" value="${esc(c.logLimit)}" /></div>
    </div>
    <div class="field"><label>出网代理</label>
      <input id="s-proxy" type="text" value="${esc(c.proxy || '')}" placeholder="http://127.0.0.1:7897（留空 = 直连）" />
      <div class="hint">保存即生效。上游里标了"直连"的地址会自动绕过代理。</div></div>
    <div class="section-label">密钥</div>
    <div class="field"><label>客户端 API Key（酒馆用）</label>
      <div class="copy-row"><input id="s-apikey" type="text" value="${esc(c.apiKey)}" /><button class="btn small" data-copy2="s-apikey">复制</button></div></div>
    <div class="field"><label>控制台 Admin Key（本页用）</label>
      <div class="copy-row"><input id="s-adminkey" type="text" value="${esc(c.adminKey)}" /><button class="btn small" data-copy2="s-adminkey">复制</button></div></div>
    <div class="section-label">高级</div>
    <div class="field"><label>config.json 原始内容（只读预览）</label>
      <textarea readonly style="height:180px">${esc(JSON.stringify(c, null, 2))}</textarea></div>
    <div class="modal-foot">
      <button class="btn ghost" id="s-cancel">取消</button>
      <button class="btn primary" id="s-save">保存</button>
    </div>
  `;
  $('#s-close').onclick = closeModal;
  $('#s-cancel').onclick = closeModal;
  $('.modal-backdrop').onclick = closeModal;
  $$('[data-copy2]').forEach((b) => b.addEventListener('click', () => copy($('#' + b.dataset.copy2).value)));
  $('#s-save').onclick = async () => {
    const prevAdmin = state.cfg.adminKey;
    state.cfg.port = Number($('#s-port').value);
    state.cfg.host = $('#s-host').value.trim() || '127.0.0.1';
    state.cfg.timeoutMs = Number($('#s-timeout').value) || 240000;
    state.cfg.logLimit = Number($('#s-loglimit').value) || 300;
    state.cfg.idleTimeoutMs = Number($('#s-idle').value) || 60000;
    state.cfg.proxy = $('#s-proxy').value.trim();
    state.cfg.apiKey = $('#s-apikey').value.trim();
    state.cfg.adminKey = $('#s-adminkey').value.trim();
    try {
      await saveConfig();
      if (state.cfg.adminKey !== prevAdmin) {
        localStorage.setItem('rook.adminKey', state.cfg.adminKey);
        state.key = state.cfg.adminKey;
      }
      closeModal();
      render();
      toast('已保存', 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  };
}

/* ------------------------------------------------------------------ boot */

async function boot(key) {
  state.key = key;
  try {
    await api('/admin/api/ping');
    await loadState();
    localStorage.setItem('rook.adminKey', key);
    $('#gate').hidden = true;
    $('#app').hidden = false;
    connectLogs();
    render();
    return true;
  } catch (e) {
    if (e.message !== 'unauthorized') $('#gate-err').textContent = e.message;
    return false;
  }
}

$$('.nav-item').forEach((b) =>
  b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    render();
  })
);
$('#btn-refresh').addEventListener('click', async () => {
  await loadState();
  render();
  toast('已刷新', 'ok');
});
$('#btn-settings').addEventListener('click', openSettings);
$('#gate-go').addEventListener('click', async () => {
  const v = $('#gate-input').value.trim();
  const ok = await boot(v);
  if (!ok && !$('#gate-err').textContent) $('#gate-err').textContent = '不匹配';
});
$('#gate-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#gate-go').click();
});

(async () => {
  const fromUrl = new URLSearchParams(location.search).get('key');
  const key = fromUrl || state.key;
  if (key) {
    const ok = await boot(key);
    if (ok) {
      // do not leave the admin key sitting in the address bar / history
      if (fromUrl) history.replaceState(null, '', location.pathname);
      return;
    }
  }
  $('#gate').hidden = false;
  $('#gate-input').focus();
})();
