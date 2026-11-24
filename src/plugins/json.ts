import type { Plugin } from './types';
import { h, btn, parseJson } from './dom';

export function renderValue(key: string | null, v: unknown, depth: number, last = true): HTMLElement {
  const comma = last ? '' : ',';
  const label = key !== null ? [h('span', { class: 'jk' }, JSON.stringify(key)), h('span', { class: 'jp' }, ': ')] : [];
  if (v !== null && typeof v === 'object') {
    const isArr = Array.isArray(v);
    const entries: [string, unknown][] = isArr
      ? (v as unknown[]).map((x, i) => [String(i), x])
      : Object.entries(v as Record<string, unknown>);
    const [o, c] = isArr ? ['[', ']'] : ['{', '}'];
    if (entries.length === 0) return h('div', { class: 'jl' }, ...label, h('span', { class: 'jp' }, o + c + comma));
    const summary = h('summary', {}, ...label, h('span', { class: 'jp' }, o),
      h('span', { class: 'jpre' }, h('span', { class: 'jd' }, ` ${entries.length} ${isArr ? 'элем.' : 'ключей'} `), h('span', { class: 'jp' }, c + comma)));
    const box = h('details', { class: 'jn' }, summary);
    let built = false;
    const build = () => {
      if (built) return;
      built = true;
      entries.forEach(([k, x], i) => box.append(renderValue(isArr ? null : k, x, depth + 1, i === entries.length - 1)));
      box.append(h('div', { class: 'jl jclose' }, h('span', { class: 'jp' }, c + comma)));
    };
    box.addEventListener('toggle', () => { if (box.open) build(); });
    if (depth < 2) { box.open = true; build(); }
    return box;
  }
  const cls = v === null ? 'jnull' : typeof v === 'string' ? 'jstr' : typeof v === 'number' ? 'jnum' : 'jbool';
  const text = typeof v === 'string' ? JSON.stringify(v) : String(v);
  return h('div', { class: 'jl' }, ...label, h('span', { class: cls }, text), h('span', { class: 'jp' }, comma));
}

const STORE = 'miniterm.json.text';

export const jsonViewer: Plugin = {
  id: 'json',
  title: 'JSON',
  icon: '{ }',
  exts: ['json', 'jsonl', 'geojson'],
  mount(root, api) {
    const ta = h('textarea', { class: 'pta', placeholder: 'Вставь JSON сюда…', spellcheck: false });
    const status = h('div', { class: 'pstatus' });
    const tree = h('div', { class: 'jtree' });
    const path = h('input', { spellcheck: false, class: 'pin', placeholder: 'Путь к .json файлу' });

    const show = () => {
      tree.replaceChildren();
      const text = ta.value.trim();
      if (!text) { status.textContent = ''; return; }
      const r = parseJson(text);
      if (!r.ok) { status.textContent = '✗ ' + r.error; status.className = 'pstatus err'; return; }
      status.textContent = '✓ валидный JSON'; status.className = 'pstatus ok';
      tree.append(renderValue(null, r.value, 0));
    };
    const setText = (t: string) => { ta.value = t; show(); try { localStorage.setItem(STORE, t.length < 4_000_000 ? t : ''); } catch { /* quota */ } };
    const loadFile = async (p: string) => {
      try { setText(await api.invoke<string>('read_text_file', { path: p })); path.value = p; }
      catch (e) { status.textContent = '✗ ' + String(e); status.className = 'pstatus err'; }
    };
    ta.addEventListener('input', () => { show(); try { localStorage.setItem(STORE, ta.value.length < 4_000_000 ? ta.value : ''); } catch { /* quota */ } });
    try { const saved = localStorage.getItem(STORE); if (saved) { ta.value = saved; show(); } } catch { /* none */ }

    root.append(
      h('div', { class: 'prow' },
        btn('Из буфера', async () => { try { setText(await navigator.clipboard.readText()); } catch { /* denied */ } }),
        btn('Из выделения', () => setText(api.getSelection())),
        btn('Формат', () => { const r = parseJson(ta.value); if (r.ok) setText(JSON.stringify(r.value, null, 2)); }),
        btn('Сжать', () => { const r = parseJson(ta.value); if (r.ok) setText(JSON.stringify(r.value)); }),
        btn('Копировать', () => api.copy(ta.value)),
      ),
      h('div', { class: 'prow' }, path, btn('Открыть', () => void loadFile(path.value.trim().replace(/^"|"$/g, '')))),
      ta, status, tree,
    );
    return { open: p => void loadFile(p) };
  },
};
