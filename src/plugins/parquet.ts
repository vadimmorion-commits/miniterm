import type { Plugin } from './types';
import { h, btn } from './dom';

type ParquetInfo = { columns: [string, string][]; num_rows: number; rows: Record<string, unknown>[] };

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
};

export const parquetViewer: Plugin = {
  id: 'parquet',
  title: 'Parquet',
  icon: '▦',
  exts: ['parquet', 'pq'],
  mount(root, api) {
    const path = h('input', { spellcheck: false, class: 'pin', placeholder: 'Путь к .parquet файлу' });
    const limit = h('input', { class: 'pin small', type: 'number', value: '200', min: '1', max: '5000', title: 'Сколько строк показать' });
    const status = h('div', { class: 'pstatus' });
    const schema = h('div', { class: 'pschema' });
    const wrap = h('div', { class: 'ptable' });

    const load = async (p: string) => {
      status.className = 'pstatus'; status.textContent = 'Читаю…';
      schema.replaceChildren(); wrap.replaceChildren();
      try {
        const info = await api.invoke<ParquetInfo>('parquet_read', { path: p, limit: Number(limit.value) || 200 });
        path.value = p;
        status.className = 'pstatus ok';
        status.textContent = `Строк в файле: ${info.num_rows} · показано: ${info.rows.length} · колонок: ${info.columns.length}`;
        for (const [n, t] of info.columns) schema.append(h('span', { class: 'chip' }, `${n} : ${t}`));
        const head = h('tr', {}, h('th', {}, '#'), ...info.columns.map(([n]) => h('th', {}, n)));
        const body = info.rows.map((r, i) =>
          h('tr', {}, h('td', { class: 'idx' }, String(i + 1)), ...info.columns.map(([n]) => h('td', {}, cell(r[n])))));
        wrap.append(h('table', {}, h('thead', {}, head), h('tbody', {}, ...body)));
      } catch (e) {
        status.className = 'pstatus err'; status.textContent = '✗ ' + String(e);
      }
    };

    root.append(
      h('div', { class: 'prow' }, path, limit, btn('Открыть', () => void load(path.value.trim().replace(/^"|"$/g, '')))),
      status, schema, wrap,
    );
    return { open: p => void load(p) };
  },
};
