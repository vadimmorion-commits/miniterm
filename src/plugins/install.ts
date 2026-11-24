import type { PluginApi } from './types';
import { h, btn } from './dom';

type Sign = 'signed' | 'unsigned';
interface Inst { id: string; name: string; ver: string; front: string; back: string; sign: Sign }
interface Cfg { downloads: string; frontRoot: string; backRoot: string; src: string; cfgSrc: string; installs: Inst[] }
interface Arc { name: string; size: number; mtime: number }
interface FileDiff { rel: string; status: 'new' | 'changed' | 'same'; exe: boolean; size: number }
interface Preview { stage: string; files: FileDiff[] }

const STORE = 'installer.json';
const mb = (n: number) => (n / 1048576).toFixed(1) + ' МБ';
const join = (a: string, b: string) => a.replace(/[\\/]+$/, '') + '\\' + b;

/** 3.13.00 -> "1300", 3.9.00 -> "900" */
function verOf(name: string): string | null {
  const m = /v(\d+)\.(\d+)\.(\d+)/i.exec(name);
  return m ? String(Number(m[2]) * 100 + Number(m[3])) : null;
}

export function mountInstaller(root: HTMLElement, api: PluginApi) {
  let cfg: Cfg = { downloads: '', frontRoot: 'C:\\Work\\Front', backRoot: 'C:\\Work\\Back', src: 'C:\\Work\\Front\\1300\\Win64', cfgSrc: 'C:\\Work\\Back\\1300_test\\cfg', installs: [] };
  let arcs: Arc[] = [];
  const save = () => { void api.invoke('store_write', { name: STORE, text: JSON.stringify(cfg, null, 2) }); };

  const input = (value: string, onchange: (v: string) => void, ph = '') => {
    const i = h('input', { class: 'pin', spellcheck: false, value, placeholder: ph });
    i.addEventListener('change', () => onchange(i.value.trim()));
    return i;
  };
  const field = (label: string, el: HTMLElement) => h('label', { class: 'ifield' }, h('span', {}, label), el);
  const log = h('pre', { class: 'ilog' });
  const say = (lines: string[] | string, err = false) => { log.className = 'ilog' + (err ? ' err' : ''); log.textContent = Array.isArray(lines) ? lines.join('\n') : lines; };

  const settings = h('div', { class: 'icard' });
  const found = h('div', { class: 'icard' });
  const newBox = h('div', { class: 'icard' });
  const list = h('div', { class: 'icard' });
  const upd = h('div', { class: 'icard' });
  root.append(settings, found, newBox, list, upd, log);

  const arcPath = (a: Arc) => join(cfg.downloads, a.name);
  const roles = () => {
    const by = (re: RegExp) => arcs.filter(a => re.test(a.name));
    return {
      frontFull: by(/^frontkeeper.*v\d+\.\d+\.\d+\.zip$/i),
      backFull: by(/^backoffice.*v\d+\.\d+\.\d+\.zip$/i),
      frontExe: (s: Sign) => arcs.find(a => a.name.toLowerCase() === `win64-${s}.zip`),
      backExe: (s: Sign) => arcs.find(a => a.name.toLowerCase() === `cli-${s}.zip`),
    };
  };

  async function refresh() {
    try { arcs = await api.invoke<Arc[]>('list_archives', { dir: cfg.downloads }); } catch (e) { arcs = []; say('Не удалось прочитать папку загрузок: ' + e, true); }
    renderFound(); renderNew();
  }

  function renderSettings() {
    settings.replaceChildren(
      h('div', { class: 'ititle' }, 'Папки'),
      field('Загрузки (архивы)', input(cfg.downloads, v => { cfg.downloads = v; save(); void refresh(); })),
      field('Корень Front', input(cfg.frontRoot, v => { cfg.frontRoot = v; save(); })),
      field('Корень Back', input(cfg.backRoot, v => { cfg.backRoot = v; save(); })),
      field('Источник workplace и browser (папка Win64 готовой установки)', input(cfg.src, v => { cfg.src = v; save(); })),
      field('Шаблон конфига бэка (папка cfg рабочей установки)', input(cfg.cfgSrc, v => { cfg.cfgSrc = v; save(); })),
    );
  }

  function renderFound() {
    const r = roles();
    const mark = (ok: boolean, text: string) => h('div', { class: 'ifound ' + (ok ? 'ok' : 'no') }, (ok ? '✓ ' : '✗ ') + text);
    found.replaceChildren(
      h('div', { class: 'prow' }, h('div', { class: 'ititle' }, 'Архивы в загрузках'), btn('⟳ Обновить', () => void refresh())),
      mark(r.frontFull.length > 0, 'Фронт, полный: ' + (r.frontFull.map(a => `${verOf(a.name)} (${mb(a.size)})`).join(', ') || 'нет')),
      mark(r.backFull.length > 0, 'Бэк, полный: ' + (r.backFull.map(a => `${verOf(a.name)} (${mb(a.size)})`).join(', ') || 'нет')),
      mark(!!r.frontExe('signed') || !!r.frontExe('unsigned'), 'Фронт exe: ' + (['signed', 'unsigned'].filter(s => r.frontExe(s as Sign)).join(', ') || 'нет')),
      mark(!!r.backExe('signed') || !!r.backExe('unsigned'), 'Бэк exe: ' + (['signed', 'unsigned'].filter(s => r.backExe(s as Sign)).join(', ') || 'нет')),
    );
  }

  function renderNew() {
    const r = roles();
    const vers = [...new Set([...r.frontFull, ...r.backFull].map(a => verOf(a.name)).filter((v): v is string => !!v))];
    const verSel = h('select', { class: 'pin' }, ...vers.map(v => h('option', { value: v }, v)));
    const name = h('input', { class: 'pin', spellcheck: false, value: vers[0] ? `auto_${vers[0]}` : '' });
    const db = h('input', { class: 'pin', spellcheck: false, value: vers[0] ? `${vers[0]}_test` : '' });
    verSel.addEventListener('change', () => { name.value = `auto_${verSel.value}`; db.value = `${verSel.value}_test`; });
    const sign = h('select', { class: 'pin' }, h('option', { value: 'unsigned' }, 'unsigned'), h('option', { value: 'signed' }, 'signed'));
    const cbF = h('input', { type: 'checkbox', checked: true }), cbB = h('input', { type: 'checkbox', checked: true });
    const cbS = h('input', { type: 'checkbox', checked: true });
    const plan = h('div', { class: 'iplan' });

    const build = () => {
      const ver = verSel.value, s = sign.value as Sign;
      const ff = r.frontFull.find(a => verOf(a.name) === ver), bf = r.backFull.find(a => verOf(a.name) === ver);
      const fe = r.frontExe(s), be = r.backExe(s);
      return { ver, s, ff, bf, fe, be, nm: name.value.trim() };
    };
    const doInstall = async () => {
      const b = build();
      const tasks: [string, () => Promise<string[]>][] = [];
      if (cbF.checked && b.ff) {
        const dest = join(cfg.frontRoot, b.nm);
        tasks.push(['Фронт', () => api.invoke<string[]>('install_version', { req: { kind: 'front', full_zip: arcPath(b.ff!), exe_zip: b.fe ? arcPath(b.fe) : null, ver: b.ver, dest, wp_src: cbS.checked ? cfg.src : null, browser_src: cbS.checked ? join(cfg.src, 'browser') : null, cfg_src: null, db_name: null } })]);
      }
      if (cbB.checked && b.bf) {
        const dest = join(cfg.backRoot, b.nm);
        tasks.push(['Бэк', () => api.invoke<string[]>('install_version', { req: { kind: 'back', full_zip: arcPath(b.bf!), exe_zip: b.be ? arcPath(b.be) : null, ver: b.ver, dest, wp_src: null, browser_src: null, cfg_src: cfg.cfgSrc || null, db_name: db.value.trim() || null } })]);
      }
      say('Устанавливаю… (может занять около минуты)');
      const out: string[] = []; let failed = false;
      for (const [label, p] of tasks) {
        try { out.push(`── ${label} ──`, ...(await p())); } catch (e) { out.push(`── ${label}: ОШИБКА ──`, String(e)); failed = true; }
      }
      say(out, failed);
      if (!failed) {
        cfg.installs.push({ id: String(Date.now()), name: b.nm, ver: b.ver, sign: b.s,
          front: cbF.checked && b.ff ? join(cfg.frontRoot, b.nm) : '', back: cbB.checked && b.bf ? join(cfg.backRoot, b.nm) : '' });
        save(); renderList();
      }
      plan.replaceChildren();
    };
    const showPlan = () => {
      const b = build();
      const L: string[] = [];
      if (cbF.checked) L.push(b.ff ? `Фронт → ${join(cfg.frontRoot, b.nm)}\n   основа: ${b.ff.name}\n   exe: ${b.fe ? b.fe.name : '— (нет архива)'}${cbS.checked ? `\n   workplace.txt и browser из ${cfg.src}` : ''}` : '✗ нет полного архива фронта этой версии');
      if (cbB.checked) L.push(b.bf ? `Бэк → ${join(cfg.backRoot, b.nm)}\n   основа: ${b.bf.name}\n   mdorun.exe: ${b.be ? b.be.name : '— (нет архива)'}\n   конфиг: ${cfg.cfgSrc}, база: ${db.value.trim()}` : '✗ нет полного архива бэка этой версии');
      plan.replaceChildren(h('pre', { class: 'ilog' }, L.join('\n')), btn('✔ Установить', () => void doInstall()));
    };

    newBox.replaceChildren(
      h('div', { class: 'ititle' }, 'Новая чистая установка'),
      vers.length ? h('div', {},
        field('Версия', verSel), field('Имя папки', name), field('База бэка (Database=)', db), field('Подпись exe', sign),
        h('div', { class: 'prow' },
          h('label', { class: 'icb' }, cbF, ' Фронт'), h('label', { class: 'icb' }, cbB, ' Бэк'),
          h('label', { class: 'icb' }, cbS, ' workplace + browser')),
        btn('Показать план', showPlan), plan) : h('div', { class: 'pstatus' }, 'Полные архивы не найдены в папке загрузок'),
    );
  }

  async function run(exe: string) {
    try { await api.invoke('launch_exe', { exe }); say('Запущено: ' + exe); } catch (e) { say(String(e), true); }
  }

  function renderList() {
    list.replaceChildren(h('div', { class: 'ititle' }, 'Установленные версии'));
    if (!cfg.installs.length) list.append(h('div', { class: 'pstatus' }, 'Пока пусто. Установи версию выше или привяжи существующую ниже.'));
    for (const it of cfg.installs) {
      const sign = h('select', { class: 'pin small' }, h('option', { value: 'unsigned' }, 'unsigned'), h('option', { value: 'signed' }, 'signed'));
      sign.value = it.sign;
      sign.addEventListener('change', () => { it.sign = sign.value as Sign; save(); });
      list.append(h('div', { class: 'iitem' },
        h('div', { class: 'prow' }, h('b', {}, it.name), h('span', { class: 'chip' }, it.ver), sign,
          ...(it.front ? [btn('▶ Фронт', () => void run(join(it.front, 'Win64\keeper\FrontKeeper.exe')), 'Запустить FrontKeeper (сервер стартует вместе с ним)')] : []),
          ...(it.back ? [btn('▶ Бэк', () => void run(join(it.back, 'mdorun.exe')), 'Запустить mdorun.exe')] : []),
          btn('✕', () => { cfg.installs = cfg.installs.filter(x => x !== it); save(); renderList(); }, 'Убрать из списка (файлы не удаляются)')),
        field('Front', input(it.front, v => { it.front = v; save(); }, 'папка (содержит Win64)')),
        btn('⟳ Подкинуть exe во фронт', () => void startUpdate(it, 'front'), 'Из win64-' + it.sign + '.zip'),
        field('Back', input(it.back, v => { it.back = v; save(); }, 'папка (с mdorun.exe)')),
        btn('⟳ Подкинуть exe в бэк', () => void startUpdate(it, 'back'), 'Из cli-' + it.sign + '.zip'),
      ));
    }
    const n = h('input', { class: 'pin', placeholder: 'имя', spellcheck: false });
    const f = h('input', { class: 'pin', placeholder: 'Front папка', spellcheck: false });
    const b = h('input', { class: 'pin', placeholder: 'Back папка', spellcheck: false });
    list.append(h('details', { class: 'iadd' }, h('summary', {}, 'Привязать существующую установку'), n, f, b,
      btn('Добавить', () => {
        if (!n.value.trim()) return;
        cfg.installs.push({ id: String(Date.now()), name: n.value.trim(), ver: '', sign: 'unsigned', front: f.value.trim(), back: b.value.trim() });
        save(); renderList();
      })));
  }

  async function startUpdate(it: Inst, kind: 'front' | 'back') {
    const r = roles();
    const a = kind === 'front' ? r.frontExe(it.sign) : r.backExe(it.sign);
    const dest = kind === 'front' ? it.front : it.back;
    upd.replaceChildren();
    if (!dest) { say('Не указана папка ' + (kind === 'front' ? 'Front' : 'Back'), true); return; }
    if (!a) { say(`В загрузках нет архива ${kind === 'front' ? 'win64' : 'cli'}-${it.sign}.zip`, true); return; }
    say(`Читаю ${a.name}…`);
    let pv: Preview;
    try { pv = await api.invoke<Preview>('update_preview', { kind, exeZip: arcPath(a), dest }); } catch (e) { say(String(e), true); return; }
    say('');
    const boxes = new Map<string, HTMLInputElement>();
    const showSame = h('input', { type: 'checkbox' });
    const rows = h('div', { class: 'ifiles' });
    const draw = () => {
      rows.replaceChildren();
      for (const f of pv.files) {
        if (f.status === 'same' && !showSame.checked) continue;
        let cb = boxes.get(f.rel);
        if (!cb) { cb = h('input', { type: 'checkbox', checked: f.exe && f.status !== 'same' }); boxes.set(f.rel, cb); }
        rows.append(h('label', { class: 'ifile ' + f.status },
          cb, h('span', { class: 'ist' }, f.status === 'new' ? 'новый' : f.status === 'changed' ? 'изменён' : 'такой же'),
          h('span', { class: 'ipath' }, f.rel), h('span', { class: 'jd' }, mb(f.size))));
      }
    };
    showSame.addEventListener('change', draw); draw();
    const changed = pv.files.filter(f => f.status !== 'same').length;
    upd.append(
      h('div', { class: 'ititle' }, `${it.name}: ${kind === 'front' ? 'Фронт' : 'Бэк'} ← ${a.name}`),
      h('div', { class: 'pstatus' }, `Отличается файлов: ${changed} из ${pv.files.length}. По умолчанию отмечены только изменённые .exe.`),
      h('label', { class: 'icb' }, showSame, ' показать и одинаковые'),
      rows,
      btn('✔ Применить отмеченное (со сделанным бэкапом)', async () => {
        const files = [...boxes].filter(([, c]) => c.checked).map(([k]) => k);
        if (!files.length) { say('Ничего не отмечено'); return; }
        try { say(await api.invoke<string[]>('update_apply', { kind, stage: pv.stage, dest, files })); upd.replaceChildren(); }
        catch (e) { say(String(e), true); }
      }),
    );
  }

  void (async () => {
    try {
      const txt = await api.invoke<string>('store_read', { name: STORE });
      if (txt) cfg = { ...cfg, ...JSON.parse(txt) };
    } catch { /* first run */ }
    if (!cfg.downloads) {
      try { cfg.downloads = await api.invoke<string>('downloads_dir'); } catch { cfg.downloads = 'C:\\Users\\Public\\Downloads'; }
    }
    renderSettings(); renderList(); await refresh();
  })();
}
