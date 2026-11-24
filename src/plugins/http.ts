import type { PluginApi } from './types';
import { h, btn, parseJson } from './dom';
import { renderValue } from './json';

interface KV { k: string; v: string; on: boolean }
type BodyType = 'none' | 'json' | 'text' | 'form';
interface Req {
  id: string; name: string; method: string; url: string;
  params: KV[]; headers: KV[]; bodyType: BodyType; body: string;
  auth: { type: 'none' | 'bearer' | 'basic'; a: string; b: string };
  insecure: boolean; follow: boolean; timeout: number;
}
interface Group { name: string; reqs: Req[] }
interface Store { groups: Group[]; env: string; cur: Req }
interface Resp { status: number; status_text: string; headers: [string, string][]; body: string; size: number; time_ms: number; binary: boolean }

const STORE = 'http.json';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const blank = (): Req => ({
  id: uid(), name: '', method: 'GET', url: '', params: [], headers: [], bodyType: 'none', body: '',
  auth: { type: 'none', a: '', b: '' }, insecure: false, follow: true, timeout: 30,
});

// ---------- curl import / export ----------
function tokenize(src: string): string[] {
  const s = src.replace(/\^\r?\n/g, ' ').replace(/\\\r?\n/g, ' ').replace(/`\r?\n/g, ' ');
  const out: string[] = []; let cur = ''; let has = false; let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (q === '"' && c === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") { q = c; has = true; }
    else if (c === '^' && i + 1 < s.length) { cur += s[++i]; has = true; }
    else if (/\s/.test(c)) { if (has || cur) { out.push(cur); cur = ''; has = false; } }
    else { cur += c; has = true; }
  }
  if (has || cur) out.push(cur);
  return out;
}

function parseCurl(src: string): Partial<Req> | null {
  const t = tokenize(src.trim());
  if (!t.length || !/^curl(\.exe)?$/i.test(t[0])) return null;
  const r: Partial<Req> = { headers: [], params: [], auth: { type: 'none', a: '', b: '' } };
  const data: string[] = []; let method = ''; let url = '';
  for (let i = 1; i < t.length; i++) {
    const a = t[i]; const next = () => t[++i] ?? '';
    if (a === '-X' || a === '--request') method = next().toUpperCase();
    else if (a === '-H' || a === '--header') {
      const hv = next(); const p = hv.indexOf(':');
      if (p > 0) r.headers!.push({ k: hv.slice(0, p).trim(), v: hv.slice(p + 1).trim(), on: true });
    } else if (['-d', '--data', '--data-raw', '--data-binary', '--data-ascii'].includes(a)) data.push(next());
    else if (a === '--data-urlencode') data.push(next());
    else if (a === '-u' || a === '--user') { const [u, ...p] = next().split(':'); r.auth = { type: 'basic', a: u, b: p.join(':') }; }
    else if (a === '-k' || a === '--insecure') r.insecure = true;
    else if (a === '-L' || a === '--location') r.follow = true;
    else if (a === '-I' || a === '--head') method = 'HEAD';
    else if (a === '-b' || a === '--cookie') r.headers!.push({ k: 'Cookie', v: next(), on: true });
    else if (a === '-A' || a === '--user-agent') r.headers!.push({ k: 'User-Agent', v: next(), on: true });
    else if (a === '-e' || a === '--referer') r.headers!.push({ k: 'Referer', v: next(), on: true });
    else if (a === '--url') url = next();
    else if (['-m', '--max-time', '-o', '--output', '-w', '--write-out', '--connect-timeout'].includes(a)) next();
    else if (a.startsWith('-')) { /* flag without value: -s, -v, -i, --compressed ... */ }
    else if (!url) url = a;
  }
  r.url = url;
  const body = data.join('&');
  r.method = method || (body ? 'POST' : 'GET');
  if (body) {
    r.body = body;
    const ct = r.headers!.find(x => x.k.toLowerCase() === 'content-type')?.v.toLowerCase() ?? '';
    r.bodyType = ct.includes('json') || /^\s*[{[]/.test(body) ? 'json' : ct.includes('x-www-form-urlencoded') ? 'form' : 'text';
  } else r.bodyType = 'none';
  const auth = r.headers!.findIndex(x => x.k.toLowerCase() === 'authorization');
  if (auth >= 0 && r.auth!.type === 'none') {
    const v = r.headers![auth].v;
    if (/^bearer\s/i.test(v)) { r.auth = { type: 'bearer', a: v.replace(/^bearer\s+/i, ''), b: '' }; r.headers!.splice(auth, 1); }
  }
  return r;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// ---------- request building ----------
function parseEnv(text: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([\w.-]+)\s*=\s*(.*)$/.exec(line);
    if (m) o[m[1]] = m[2].trim();
  }
  return o;
}
const subst = (s: string, env: Record<string, string>) => s.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k: string) => (k in env ? env[k] : m));

function build(req: Req, env: Record<string, string>) {
  let url = subst(req.url.trim(), env);
  const q = req.params.filter(p => p.on && p.k).map(p => `${encodeURIComponent(subst(p.k, env))}=${encodeURIComponent(subst(p.v, env))}`).join('&');
  if (q) url += (url.includes('?') ? '&' : '?') + q;
  if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'http://' + url;
  const headers: [string, string][] = req.headers.filter(x => x.on && x.k).map(x => [subst(x.k, env), subst(x.v, env)]);
  const has = (n: string) => headers.some(([k]) => k.toLowerCase() === n);
  let body: string | null = null;
  if (req.bodyType !== 'none' && !['GET', 'HEAD'].includes(req.method)) {
    body = subst(req.body, env);
    if (!has('content-type')) {
      const ct = req.bodyType === 'json' ? 'application/json' : req.bodyType === 'form' ? 'application/x-www-form-urlencoded' : 'text/plain';
      headers.push(['Content-Type', ct]);
    }
  }
  if (!has('authorization')) {
    if (req.auth.type === 'bearer' && req.auth.a) headers.push(['Authorization', 'Bearer ' + subst(req.auth.a, env)]);
    if (req.auth.type === 'basic') headers.push(['Authorization', 'Basic ' + btoa(unescape(encodeURIComponent(subst(req.auth.a, env) + ':' + subst(req.auth.b, env))))]);
  }
  return { url, headers, body };
}

function toCurl(req: Req, env: Record<string, string>): string {
  const b = build(req, env);
  const p = ['curl'];
  if (req.insecure) p.push('-k');
  if (req.follow) p.push('-L');
  p.push('-X', req.method, shq(b.url));
  for (const [k, v] of b.headers) p.push('-H', shq(`${k}: ${v}`));
  if (b.body !== null) p.push('--data-raw', shq(b.body));
  return p.join(' ');
}

export function mountHttp(root: HTMLElement, api: PluginApi) {
  let st: Store = { groups: [], env: '', cur: blank() };
  let timer = 0;
  const save = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { void api.invoke('store_write', { name: STORE, text: JSON.stringify(st) }); }, 400);
  };
  const env = () => parseEnv(st.env);

  const editor = h('div', { class: 'hedit' });
  const respBox = h('div', { class: 'hresp' });
  const saved = h('details', { class: 'hsaved' });
  const envBox = h('details', { class: 'hsaved' });
  root.append(editor, respBox, saved, envBox);

  // ---------- small editors ----------
  function kvEditor(list: KV[], ph: [string, string]): HTMLElement {
    const box = h('div', { class: 'hkv' });
    const draw = () => {
      box.replaceChildren();
      list.forEach((row, i) => {
        const on = h('input', { type: 'checkbox', checked: row.on });
        const k = h('input', { class: 'pin', spellcheck: false, value: row.k, placeholder: ph[0] });
        const v = h('input', { class: 'pin', spellcheck: false, value: row.v, placeholder: ph[1] });
        on.addEventListener('change', () => { row.on = on.checked; save(); });
        k.addEventListener('input', () => { row.k = k.value; save(); });
        v.addEventListener('input', () => { row.v = v.value; save(); });
        box.append(h('div', { class: 'hrow' }, on, k, v, btn('✕', () => { list.splice(i, 1); draw(); save(); })));
      });
      box.append(btn('+ добавить', () => { list.push({ k: '', v: '', on: true }); draw(); }));
    };
    draw();
    return box;
  }

  function renderEditor() {
    const r = st.cur;
    const method = h('select', { class: 'pin hmethod' }, ...METHODS.map(m => h('option', { value: m }, m)));
    method.value = r.method;
    method.addEventListener('change', () => { r.method = method.value; save(); });
    const url = h('input', { class: 'pin hurl', spellcheck: false, value: r.url, placeholder: 'https://api.example.com/path  или вставь целиком curl …' });
    const importCurl = (text: string) => {
      const c = parseCurl(text);
      if (!c) return false;
      st.cur = { ...blank(), id: r.id, name: r.name, ...c } as Req;
      save(); renderEditor();
      return true;
    };
    url.addEventListener('input', () => { if (!importCurl(url.value)) { r.url = url.value; save(); } });
    url.addEventListener('keydown', e => { if (e.key === 'Enter') void send(); });
    const sendBtn = h('button', { class: 'pbtn hsend' }, 'Отправить');
    sendBtn.onclick = () => void send();

    const tabs = ['Параметры', 'Заголовки', 'Тело', 'Авторизация', 'Опции'];
    const panes = tabs.map(() => h('div', { class: 'hpane' }));
    const tbar = h('div', { class: 'prow' });
    const show = (n: number) => { panes.forEach((p, i) => { p.hidden = i !== n; }); [...tbar.children].forEach((b, i) => b.classList.toggle('on', i === n)); };
    tabs.forEach((t, i) => { const b = h('button', { class: 'ttab' }, t); b.onclick = () => show(i); tbar.append(b); });

    panes[0].append(kvEditor(r.params, ['параметр', 'значение']));
    panes[1].append(kvEditor(r.headers, ['заголовок', 'значение']));

    const bt = h('select', { class: 'pin small wide-sel' },
      h('option', { value: 'none' }, 'нет'), h('option', { value: 'json' }, 'JSON'), h('option', { value: 'text' }, 'текст'), h('option', { value: 'form' }, 'form-urlencoded'));
    bt.value = r.bodyType;
    bt.addEventListener('change', () => { r.bodyType = bt.value as BodyType; save(); });
    const body = h('textarea', { class: 'pta', spellcheck: false, placeholder: '{ "key": "value" }', value: r.body });
    body.addEventListener('input', () => { r.body = body.value; save(); });
    panes[2].append(h('div', { class: 'prow' }, bt, btn('Формат JSON', () => { const p = parseJson(body.value); if (p.ok) { body.value = JSON.stringify(p.value, null, 2); r.body = body.value; save(); } })), body);

    const at = h('select', { class: 'pin small wide-sel' }, h('option', { value: 'none' }, 'нет'), h('option', { value: 'bearer' }, 'Bearer'), h('option', { value: 'basic' }, 'Basic'));
    at.value = r.auth.type;
    const a1 = h('input', { class: 'pin', spellcheck: false, value: r.auth.a });
    const a2 = h('input', { class: 'pin', spellcheck: false, value: r.auth.b });
    const authUi = () => { a1.placeholder = r.auth.type === 'bearer' ? 'токен' : 'логин'; a2.hidden = r.auth.type !== 'basic'; a2.placeholder = 'пароль'; a1.hidden = r.auth.type === 'none'; };
    at.addEventListener('change', () => { r.auth.type = at.value as Req['auth']['type']; authUi(); save(); });
    a1.addEventListener('input', () => { r.auth.a = a1.value; save(); });
    a2.addEventListener('input', () => { r.auth.b = a2.value; save(); });
    authUi();
    panes[3].append(h('div', { class: 'prow' }, at, a1, a2));

    const ins = h('input', { type: 'checkbox', checked: r.insecure });
    const fol = h('input', { type: 'checkbox', checked: r.follow });
    const to = h('input', { class: 'pin small', type: 'number', value: String(r.timeout), min: '1' });
    ins.addEventListener('change', () => { r.insecure = ins.checked; save(); });
    fol.addEventListener('change', () => { r.follow = fol.checked; save(); });
    to.addEventListener('change', () => { r.timeout = Number(to.value) || 30; save(); });
    panes[4].append(
      h('label', { class: 'icb' }, fol, ' Следовать редиректам'),
      h('label', { class: 'icb' }, ins, ' Не проверять сертификат TLS (-k)'),
      h('label', { class: 'icb' }, 'Таймаут, с ', to));

    editor.replaceChildren(
      h('div', { class: 'prow hline' }, method, url, sendBtn),
      h('div', { class: 'prow' },
        btn('Новый', () => { st.cur = blank(); save(); renderEditor(); respBox.replaceChildren(); }),
        btn('Копировать как curl', () => api.copy(toCurl(st.cur, env()))),
        btn('curl из буфера', async () => { try { const t = await navigator.clipboard.readText(); if (!importCurl(t)) say('В буфере не curl-команда'); } catch { /* denied */ } })),
      tbar, ...panes);
    show(r.bodyType !== 'none' ? 2 : r.params.length ? 0 : r.headers.length ? 1 : 0);
  }

  const say = (t: string, err = true) => { respBox.replaceChildren(h('div', { class: 'pstatus' + (err ? ' err' : '') }, t)); };

  // ---------- sending / response ----------
  async function send() {
    const r = st.cur;
    const b = build(r, env());
    if (!r.url.trim()) { say('Введи URL'); return; }
    respBox.replaceChildren(h('div', { class: 'pstatus' }, 'Отправляю…'));
    try {
      const resp = await api.invoke<Resp>('http_request', {
        req: { method: r.method, url: b.url, headers: b.headers, body: b.body, insecure: r.insecure, follow: r.follow, timeout_s: r.timeout },
      });
      showResp(resp);
    } catch (e) { say('✗ ' + String(e)); }
  }

  function showResp(r: Resp) {
    const cls = r.status < 300 ? 'ok' : r.status < 400 ? 'warn' : 'bad';
    const kb = r.size < 1024 ? r.size + ' Б' : r.size < 1048576 ? (r.size / 1024).toFixed(1) + ' КБ' : (r.size / 1048576).toFixed(1) + ' МБ';
    const bodyBox = h('div', { class: 'hbody' });
    const hdrs = h('div', { class: 'hbody' }, ...r.headers.map(([k, v]) => h('div', { class: 'jl' }, h('span', { class: 'jk' }, k), h('span', { class: 'jp' }, ': '), v)));
    hdrs.hidden = true;
    let raw = false;
    const drawBody = () => {
      bodyBox.replaceChildren();
      const text = r.body;
      const p = !raw && /^\s*[{[]/.test(text) ? parseJson(text) : null;
      if (p && p.ok) bodyBox.append(h('div', { class: 'jtree' }, renderValue(null, p.value, 0)));
      else bodyBox.append(h('pre', { class: 'ilog' }, r.binary ? '[бинарные данные, показан приблизительный текст]\n' + text.slice(0, 20000) : text));
    };
    drawBody();
    const rawBtn = btn('Raw', () => { raw = !raw; rawBtn.classList.toggle('on', raw); drawBody(); });
    const tb = btn('Тело', () => { bodyBox.hidden = false; hdrs.hidden = true; });
    const th = btn(`Заголовки (${r.headers.length})`, () => { bodyBox.hidden = true; hdrs.hidden = false; });
    respBox.replaceChildren(
      h('div', { class: 'prow hstat' },
        h('span', { class: 'hbadge ' + cls }, `${r.status} ${r.status_text}`),
        h('span', { class: 'jd' }, `${r.time_ms} мс · ${kb}`)),
      h('div', { class: 'prow' }, tb, th, rawBtn, btn('Копировать тело', () => api.copy(r.body))),
      bodyBox, hdrs);
  }

  // ---------- saved requests ----------
  function renderSaved() {
    const open = saved.open;
    const name = h('input', { class: 'pin', spellcheck: false, placeholder: 'название запроса', value: st.cur.name });
    const grp = h('input', { class: 'pin', spellcheck: false, placeholder: 'группа' });
    grp.setAttribute('list', 'hgroups');
    const dl = h('datalist', { id: 'hgroups' }, ...st.groups.map(g => h('option', { value: g.name })));
    const found = st.groups.find(g => g.reqs.some(x => x.id === st.cur.id));
    if (found) grp.value = found.name;
    const doSave = () => {
      const nm = name.value.trim(), gn = grp.value.trim() || 'Без группы';
      if (!nm) { name.focus(); return; }
      st.cur.name = nm;
      for (const g of st.groups) g.reqs = g.reqs.filter(x => x.id !== st.cur.id);
      let g = st.groups.find(x => x.name === gn);
      if (!g) { g = { name: gn, reqs: [] }; st.groups.push(g); }
      g.reqs.push(JSON.parse(JSON.stringify(st.cur)));
      st.groups = st.groups.filter(x => x.reqs.length || x === g);
      save(); renderSaved();
    };
    saved.replaceChildren(h('summary', {}, `Сохранённые запросы (${st.groups.reduce((n, g) => n + g.reqs.length, 0)})`),
      h('div', { class: 'prow' }, name, grp, dl, btn('💾 Сохранить', doSave)));
    for (const g of st.groups) {
      saved.append(h('div', { class: 'hgroup' }, g.name));
      for (const q of g.reqs) {
        saved.append(h('div', { class: 'hitem' },
          h('span', { class: 'hm ' + q.method }, q.method),
          h('span', { class: 'hn', title: q.url, onclick: () => { st.cur = JSON.parse(JSON.stringify(q)); save(); renderEditor(); respBox.replaceChildren(); renderSaved(); } }, q.name || q.url),
          btn('✕', () => { g.reqs = g.reqs.filter(x => x !== q); st.groups = st.groups.filter(x => x.reqs.length); save(); renderSaved(); }, 'Удалить')));
      }
    }
    saved.open = open;
  }

  function renderEnv() {
    const ta = h('textarea', { class: 'pta half', spellcheck: false, placeholder: 'host=https://api.example.com\ntoken=abc123\n\nв запросах: {{host}}/v1/items', value: st.env });
    ta.addEventListener('input', () => { st.env = ta.value; save(); });
    envBox.replaceChildren(h('summary', {}, 'Переменные ({{имя}})'), ta);
  }

  void (async () => {
    try {
      const txt = await api.invoke<string>('store_read', { name: STORE });
      if (txt) { const p = JSON.parse(txt) as Partial<Store>; st = { groups: p.groups ?? [], env: p.env ?? '', cur: { ...blank(), ...(p.cur ?? {}) } }; }
    } catch { /* first run */ }
    renderEditor(); renderSaved(); renderEnv();
  })();
}
