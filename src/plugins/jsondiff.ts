import type { Plugin } from './types';
import { h, btn, parseJson } from './dom';

type Diff = { path: string; kind: 'added' | 'removed' | 'changed'; a?: unknown; b?: unknown };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function diff(a: unknown, b: unknown, path: string, out: Diff[]) {
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const p = `${path}[${i}]`;
      if (i >= a.length) out.push({ path: p, kind: 'added', b: b[i] });
      else if (i >= b.length) out.push({ path: p, kind: 'removed', a: a[i] });
      else diff(a[i], b[i], p, out);
    }
  } else if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in a)) out.push({ path: p, kind: 'added', b: b[k] });
      else if (!(k in b)) out.push({ path: p, kind: 'removed', a: a[k] });
      else diff(a[k], b[k], p, out);
    }
  } else if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push({ path: path || '(корень)', kind: 'changed', a, b });
  }
}

const short = (v: unknown) => {
  const s = JSON.stringify(v);
  return s.length > 160 ? s.slice(0, 160) + '…' : s;
};

export const jsonDiff: Plugin = {
  id: 'jsondiff',
  title: 'Сравнение JSON',
  icon: '⇄',
  mount(root, api) {
    const ta = h('textarea', { class: 'pta half', placeholder: 'JSON A (было)', spellcheck: false });
    const tb = h('textarea', { class: 'pta half', placeholder: 'JSON B (стало)', spellcheck: false });
    const status = h('div', { class: 'pstatus' });
    const list = h('div', { class: 'dlist' });

    const run = () => {
      list.replaceChildren();
      status.className = 'pstatus';
      const ea = !ta.value.trim(), eb = !tb.value.trim();
      if (ea || eb) {
        status.textContent = ea && eb ? 'Вставь JSON в оба поля' : ea ? 'Поле A пустое — вставь JSON' : 'Поле B пустое — вставь JSON';
        return;
      }
      const ra = parseJson(ta.value), rb = parseJson(tb.value);
      if (!ra.ok) { status.textContent = '✗ A: ' + ra.error; status.className = 'pstatus err'; return; }
      if (!rb.ok) { status.textContent = '✗ B: ' + rb.error; status.className = 'pstatus err'; return; }
      const out: Diff[] = [];
      diff(ra.value, rb.value, '', out);
      status.className = out.length ? 'pstatus' : 'pstatus ok';
      status.textContent = out.length ? `Различий: ${out.length}` : '✓ идентичны';
      for (const d of out) {
        const sign = d.kind === 'added' ? '+' : d.kind === 'removed' ? '−' : '~';
        const row = h('div', { class: `drow ${d.kind}` },
          h('span', { class: 'dsign' }, sign), h('span', { class: 'dpath' }, d.path));
        const vals = d.kind === 'changed'
          ? `${short(d.a)}  →  ${short(d.b)}`
          : short(d.kind === 'added' ? d.b : d.a);
        row.append(h('div', { class: 'dval' }, vals));
        list.append(row);
      }
    };
    const swap = () => { const t = ta.value; ta.value = tb.value; tb.value = t; run(); };

    root.append(
      h('div', { class: 'prow' },
        btn('A из буфера', async () => { try { ta.value = await navigator.clipboard.readText(); run(); } catch { /* denied */ } }),
        btn('B из буфера', async () => { try { tb.value = await navigator.clipboard.readText(); run(); } catch { /* denied */ } }),
        btn('⇄ Поменять', swap),
        btn('Сравнить', run),
      ),
      ta, tb, status, list,
    );
    void api;
    ta.addEventListener('input', run);
    tb.addEventListener('input', run);
  },
};
