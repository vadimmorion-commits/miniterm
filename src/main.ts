import './style.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

// ---------- UI settings ----------
const UI_KEY = 'miniterm.ui.v1';
const ui = { side: true, files: false, fontSize: 14 };
try { Object.assign(ui, JSON.parse(localStorage.getItem(UI_KEY) || '{}')); } catch { /* ignore */ }
function saveUi() { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch { /* ignore */ } }

// ---------- model ----------
type Leaf = { t: 'leaf'; id: number };
type Split = { t: 'split'; dir: 'row' | 'col'; a: Node; b: Node; r: number };
type Node = Leaf | Split;
type Tab = { root: Node; active: number };
type Pane = {
  id: number; term: Terminal; fit: FitAddon; el: HTMLElement; cwd: string;
  unlisten: UnlistenFn[]; spawned: boolean;
};

const STORE_KEY = 'miniterm.layout.v1';
const panes = new Map<number, Pane>();
let tabs: Tab[] = [];
let activeTab = 0;
let nextId = 1;

const $tabs = document.getElementById('tablist')!;
const $tabq = document.getElementById('tabq') as HTMLInputElement;
const $main = document.getElementById('main')!;

// ---------- persistence ----------
type SNode = { t: 'leaf'; cwd: string } | { t: 'split'; dir: 'row' | 'col'; a: SNode; b: SNode; r: number };
type SState = { tabs: { root: SNode; active: number }[]; activeTab: number };

function ser(n: Node, activeId: number, out: { idx: number }): SNode {
  if (n.t === 'leaf') {
    if (n.id === activeId) out.idx = leafOrder;
    leafOrder++;
    return { t: 'leaf', cwd: panes.get(n.id)?.cwd ?? '' };
  }
  return { t: 'split', dir: n.dir, a: ser(n.a, activeId, out), b: ser(n.b, activeId, out), r: n.r };
}
let leafOrder = 0;

let saveTimer: number | undefined;
function save() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveNow, 400);
}
function saveNow() {
  try {
    const st: SState = {
      activeTab,
      tabs: tabs.map(t => {
        leafOrder = 0;
        const out = { idx: 0 };
        const root = ser(t.root, t.active, out);
        return { root, active: out.idx };
      }),
    };
    localStorage.setItem(STORE_KEY, JSON.stringify(st));
  } catch { /* ignore */ }
}
window.addEventListener('beforeunload', saveNow);

function loadState(): SState | null {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null') as SState | null;
    if (s && Array.isArray(s.tabs) && s.tabs.length) return s;
  } catch { /* ignore */ }
  return null;
}

// ---------- tree helpers ----------
function leaves(n: Node): Leaf[] {
  return n.t === 'leaf' ? [n] : [...leaves(n.a), ...leaves(n.b)];
}
function replaceNode(root: Node, target: Node, repl: Node): Node {
  if (root === target) return repl;
  if (root.t === 'split') {
    root.a = replaceNode(root.a, target, repl);
    root.b = replaceNode(root.b, target, repl);
  }
  return root;
}
function findParent(root: Node, target: Node): Split | null {
  if (root.t !== 'split') return null;
  if (root.a === target || root.b === target) return root;
  return findParent(root.a, target) ?? findParent(root.b, target);
}
function findLeaf(root: Node, id: number): Leaf | null {
  return leaves(root).find(l => l.id === id) ?? null;
}

// ---------- panes ----------
function basename(p: string): string {
  const s = p.replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return (i >= 0 ? s.slice(i + 1) : s) || p || 'shell';
}

function parseOsc7(data: string): string | null {
  const m = /^file:\/\/[^/]*\/(.*)$/.exec(data);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

async function createPane(cwd: string): Promise<number> {
  const id = nextId++;
  const el = document.createElement('div');
  el.className = 'pane';
  const term = new Terminal({
    fontFamily: 'Cascadia Mono, Consolas, monospace',
    fontSize: ui.fontSize,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    theme: { background: '#1b1d23', foreground: '#d6d9e0', cursor: '#5aa2ff', selectionBackground: '#5aa2ff55' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const pane: Pane = { id, term, fit, el, cwd, unlisten: [], spawned: false };
  panes.set(id, pane);

  term.open(el);
  try {
    const gl = new WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    term.loadAddon(gl);
  } catch { /* DOM renderer fallback */ }

  term.parser.registerOscHandler(7, data => {
    const p = parseOsc7(data);
    if (p) { pane.cwd = p; updateTabTitles(); syncExplorer(); save(); }
    return true;
  });
  term.onData(d => { void invoke('pty_write', { id, data: d }); });
  term.onResize(({ cols, rows }) => { if (pane.spawned) void invoke('pty_resize', { id, cols, rows }); });

  // Ctrl+V with image-only clipboard -> Alt+V for Claude Code (image paste)
  el.addEventListener('paste', ev => {
    const cd = (ev as ClipboardEvent).clipboardData;
    if (!cd) return;
    const hasImage = Array.from(cd.items).some(i => i.kind === 'file' && i.type.startsWith('image/'));
    const hasText = cd.getData('text/plain').length > 0;
    if (hasImage && !hasText) {
      ev.preventDefault(); ev.stopPropagation();
      void invoke('pty_write', { id, data: '\x1bv' });
    }
  }, true);

  term.attachCustomKeyEventHandler(e => {
    if (e.type !== 'keydown') return true;
    // let the browser fire a real paste event for these
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyV') return false;
    if (e.shiftKey && e.code === 'Insert') return false;
    return true;
  });

  pane.unlisten.push(await listen<string>(`pty-data-${id}`, e => term.write(e.payload)));
  pane.unlisten.push(await listen(`pty-exit-${id}`, () => closePane(id, true)));
  return id;
}

async function spawnPane(pane: Pane) {
  if (pane.spawned) return;
  pane.spawned = true;
  await invoke('pty_spawn', {
    id: pane.id, cwd: pane.cwd || null,
    cols: Math.max(pane.term.cols, 20), rows: Math.max(pane.term.rows, 5),
  });
}

function destroyPane(id: number) {
  const p = panes.get(id);
  if (!p) return;
  p.unlisten.forEach(u => u());
  void invoke('pty_kill', { id });
  p.term.dispose();
  p.el.remove();
  panes.delete(id);
}

// ---------- rendering ----------
function buildNode(n: Node, multi: boolean, activeId: number): HTMLElement {
  if (n.t === 'leaf') {
    const p = panes.get(n.id)!;
    p.el.classList.toggle('focus', n.id === activeId);
    p.el.classList.toggle('multi', multi);
    p.el.onmousedown = () => focusPane(n.id);
    const slot = document.createElement('div');
    slot.className = 'slot';
    slot.style.flex = '1 1 0';
    slot.appendChild(p.el);
    return slot;
  }
  const box = document.createElement('div');
  box.className = `split ${n.dir}`;
  const a = buildNode(n.a, multi, activeId);
  const b = buildNode(n.b, multi, activeId);
  a.style.flex = `${n.r} 1 0`;
  b.style.flex = `${1 - n.r} 1 0`;
  const div = document.createElement('div');
  div.className = 'divider';
  div.onmousedown = ev => {
    ev.preventDefault();
    const rect = box.getBoundingClientRect();
    const move = (m: MouseEvent) => {
      const r = n.dir === 'row' ? (m.clientX - rect.left) / rect.width : (m.clientY - rect.top) / rect.height;
      n.r = Math.min(0.9, Math.max(0.1, r));
      a.style.flex = `${n.r} 1 0`;
      b.style.flex = `${1 - n.r} 1 0`;
      fitAll();
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); save(); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  box.append(a, div, b);
  return box;
}

function render() {
  const tab = tabs[activeTab];
  $main.replaceChildren();
  if (!tab) return;
  const ls = leaves(tab.root);
  $main.appendChild(buildNode(tab.root, ls.length > 1, tab.active));
  renderTabs();
  requestAnimationFrame(() => {
    fitAll();
    for (const l of ls) {
      const p = panes.get(l.id)!;
      void spawnPane(p);
      p.term.refresh(0, p.term.rows - 1);
    }
    panes.get(tab.active)?.term.focus();
  });
  syncExplorer();
}

const branchCache = new Map<string, string>();
function refreshBranch(cwd: string) {
  if (!cwd) return;
  invoke<string | null>('git_branch', { cwd }).then(b => {
    const nv = b ?? '';
    if (branchCache.get(cwd) !== nv) { branchCache.set(cwd, nv); renderTabs(); }
  }).catch(() => { /* ignore */ });
}

function renderTabs() {
  $tabs.replaceChildren();
  const q = $tabq.value.trim().toLowerCase();
  tabs.forEach((t, i) => {
    const cwd = panes.get(t.active)?.cwd ?? '';
    const name = basename(cwd) || 'shell';
    if (q && !(name + ' ' + cwd).toLowerCase().includes(q)) return;
    if (cwd && !branchCache.has(cwd)) { branchCache.set(cwd, ''); refreshBranch(cwd); }
    const branch = branchCache.get(cwd);
    const el = document.createElement('div');
    el.className = 'tab' + (i === activeTab ? ' active' : '');
    const info = document.createElement('div');
    info.className = 'ti';
    const t1 = document.createElement('div'); t1.className = 't1'; t1.textContent = name;
    const t2 = document.createElement('div'); t2.className = 't2';
    t2.textContent = branch ? `⎇ ${branch}` : cwd;
    t2.title = cwd;
    info.append(t1, t2);
    const x = document.createElement('button');
    x.className = 'x'; x.textContent = '×';
    x.onclick = ev => { ev.stopPropagation(); closeTab(i); };
    el.append(info, x);
    el.onclick = () => switchTab(i);
    el.onauxclick = ev => { if (ev.button === 1) closeTab(i); };
    $tabs.appendChild(el);
  });
}
function updateTabTitles() { renderTabs(); }
$tabq.addEventListener('input', renderTabs);

function fitAll() {
  const tab = tabs[activeTab];
  if (!tab) return;
  for (const l of leaves(tab.root)) {
    const p = panes.get(l.id);
    if (!p || !p.el.isConnected) continue;
    try { p.fit.fit(); } catch { /* not laid out yet */ }
  }
}
new ResizeObserver(() => fitAll()).observe($main);

// ---------- actions ----------
function focusPane(id: number) {
  const tab = tabs[activeTab];
  if (!tab || tab.active === id) { panes.get(id)?.term.focus(); return; }
  tab.active = id;
  const ls = leaves(tab.root);
  for (const l of ls) panes.get(l.id)?.el.classList.toggle('focus', l.id === id);
  panes.get(id)?.term.focus();
  updateTabTitles(); save();
}

async function newTab(cwd?: string) {
  const id = await createPane(cwd ?? panes.get(tabs[activeTab]?.active ?? -1)?.cwd ?? '');
  tabs.push({ root: { t: 'leaf', id }, active: id });
  activeTab = tabs.length - 1;
  render(); save();
}

function switchTab(i: number) {
  if (i < 0 || i >= tabs.length || i === activeTab) return;
  activeTab = i; render(); save();
}

function closeTab(i: number) {
  const t = tabs[i];
  if (!t) return;
  for (const l of leaves(t.root)) destroyPane(l.id);
  tabs.splice(i, 1);
  if (!tabs.length) { void newTab(); return; }
  activeTab = Math.min(activeTab, tabs.length - 1);
  render(); save();
}

async function splitActive(dir: 'row' | 'col') {
  const tab = tabs[activeTab];
  if (!tab) return;
  const cur = findLeaf(tab.root, tab.active)!;
  const id = await createPane(panes.get(tab.active)?.cwd ?? '');
  const sp: Split = { t: 'split', dir, a: cur, b: { t: 'leaf', id }, r: 0.5 };
  tab.root = replaceNode(tab.root, cur, sp);
  tab.active = id;
  render(); save();
}

function closePane(id: number, fromExit = false) {
  const ti = tabs.findIndex(t => findLeaf(t.root, id));
  if (ti < 0) return;
  const tab = tabs[ti];
  const leaf = findLeaf(tab.root, id)!;
  if (tab.root === leaf) { closeTab(ti); return; }
  const parent = findParent(tab.root, leaf)!;
  const sibling = parent.a === leaf ? parent.b : parent.a;
  tab.root = replaceNode(tab.root, parent, sibling);
  if (tab.active === id) tab.active = leaves(sibling)[0].id;
  destroyPane(id);
  void fromExit;
  render(); save();
}

function moveFocus(delta: number) {
  const tab = tabs[activeTab];
  if (!tab) return;
  const ls = leaves(tab.root);
  const i = ls.findIndex(l => l.id === tab.active);
  focusPane(ls[(i + delta + ls.length) % ls.length].id);
}

// ---------- history search (Ctrl+R) ----------
const $hist = document.getElementById('hist')!;
const $histq = document.getElementById('histq') as HTMLInputElement;
const $histlist = document.getElementById('histlist')!;
let histAll: string[] = [];
let histShown: string[] = [];
let histSel = 0;

function histRender() {
  const words = $histq.value.toLowerCase().split(/\s+/).filter(Boolean);
  histShown = histAll.filter(h => { const l = h.toLowerCase(); return words.every(w => l.includes(w)); }).slice(0, 60);
  histSel = Math.min(histSel, Math.max(0, histShown.length - 1));
  $histlist.replaceChildren(...histShown.map((h, i) => {
    const d = document.createElement('div');
    d.className = 'hi' + (i === histSel ? ' sel' : '');
    d.textContent = h;
    d.onclick = () => histPick(i);
    return d;
  }));
  $histlist.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}
async function histOpen() {
  histAll = await invoke<string[]>('read_history');
  $histq.value = ''; histSel = 0;
  $hist.hidden = false;
  histRender();
  $histq.focus();
}
function histClose() {
  $hist.hidden = true;
  const tab = tabs[activeTab];
  if (tab) panes.get(tab.active)?.term.focus();
}
function histPick(i: number) {
  const text = histShown[i];
  histClose();
  const tab = tabs[activeTab];
  if (text && tab) void invoke('pty_write', { id: tab.active, data: text });
}
$histq.addEventListener('input', () => { histSel = 0; histRender(); });
$histq.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); histClose(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); histSel = Math.min(histSel + 1, histShown.length - 1); histRender(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); histSel = Math.max(histSel - 1, 0); histRender(); }
  else if (e.key === 'Enter') { e.preventDefault(); histPick(histSel); }
});

// ---------- global shortcuts ----------
window.addEventListener('keydown', e => {
  if (!$hist.hidden) return; // overlay handles its own keys
  const c = e.ctrlKey, s = e.shiftKey, a = e.altKey;
  const stop = () => { e.preventDefault(); e.stopPropagation(); };
  const tab = tabs[activeTab];

  if (c && !s && !a && e.code === 'KeyC') {
    const sel = tab && panes.get(tab.active)?.term.getSelection();
    if (sel) { stop(); void navigator.clipboard.writeText(sel); panes.get(tab!.active)!.term.clearSelection(); }
    return; // no selection -> let ^C through
  }
  if (c && s && e.code === 'KeyC') {
    const sel = tab && panes.get(tab.active)?.term.getSelection();
    if (sel) { stop(); void navigator.clipboard.writeText(sel); }
    return;
  }
  if (c && !s && !a && e.code === 'KeyT') { stop(); void newTab(); }
  else if (c && !s && !a && e.code === 'KeyW') { stop(); if (tab) closePane(tab.active); }
  else if (c && !a && e.code === 'Tab') { stop(); switchTab((activeTab + (s ? -1 : 1) + tabs.length) % tabs.length); }
  else if (c && !s && !a && /^Digit[1-9]$/.test(e.code)) { stop(); switchTab(Number(e.code.slice(5)) - 1); }
  else if (c && s && e.code === 'KeyD') { stop(); void splitActive('row'); }
  else if (c && s && e.code === 'KeyE') { stop(); void splitActive('col'); }
  else if (a && !c && (e.code === 'ArrowLeft' || e.code === 'ArrowUp')) { stop(); moveFocus(-1); }
  else if (a && !c && (e.code === 'ArrowRight' || e.code === 'ArrowDown')) { stop(); moveFocus(1); }
  else if (c && !s && !a && e.code === 'KeyR') { stop(); void histOpen(); }
  else if (c && !s && !a && (e.code === 'Equal' || e.code === 'Minus' || e.code === 'Digit0')) {
    stop();
    for (const p of panes.values()) {
      void p;
    }
    setFont(e.code === 'Digit0' ? 14 : ui.fontSize + (e.code === 'Equal' ? 1 : -1));
  }
  else if (c && !s && !a && e.code === 'KeyB') { stop(); toggleSide(); }
  else if (c && s && !a && e.code === 'KeyB') { stop(); toggleFiles(); }
}, true);

document.getElementById('newbtn')!.onclick = () => void newTab();

// ---------- layout: sidebar, explorer, settings, window controls ----------
const $side = document.getElementById('side')!;
const $files = document.getElementById('files')!;
const $settings = document.getElementById('settings')!;
const $btnSide = document.getElementById('btnSide')!;
const $btnFiles = document.getElementById('btnFiles')!;
const $fsVal = document.getElementById('fsVal')!;

function applyLayout() {
  $side.hidden = !ui.side;
  $files.hidden = !ui.files;
  $btnSide.classList.toggle('on', ui.side);
  $btnFiles.classList.toggle('on', ui.files);
  $fsVal.textContent = String(ui.fontSize);
  saveUi();
  requestAnimationFrame(fitAll);
}
function toggleSide() { ui.side = !ui.side; applyLayout(); }
function toggleFiles() {
  ui.files = !ui.files; applyLayout();
  if (ui.files) { syncExplorer(true); void explRender(); }
}
function setFont(n: number) {
  ui.fontSize = Math.min(32, Math.max(8, n));
  for (const p of panes.values()) p.term.options.fontSize = ui.fontSize;
  applyLayout(); fitAll();
}
$btnSide.onclick = toggleSide;
$btnFiles.onclick = toggleFiles;
document.getElementById('fClose')!.onclick = toggleFiles;
document.getElementById('btnSet')!.onclick = ev => { ev.stopPropagation(); $settings.hidden = !$settings.hidden; };
document.addEventListener('mousedown', ev => {
  if (!$settings.hidden && !$settings.contains(ev.target as globalThis.Node) && (ev.target as HTMLElement).id !== 'btnSet') $settings.hidden = true;
});
document.getElementById('fsMinus')!.onclick = () => setFont(ui.fontSize - 1);
document.getElementById('fsPlus')!.onclick = () => setFont(ui.fontSize + 1);
document.getElementById('resetLayout')!.onclick = () => {
  try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
  window.removeEventListener('beforeunload', saveNow);
  location.reload();
};
document.getElementById('btnHist')!.onclick = () => void histOpen();
const win = getCurrentWindow();
document.getElementById('wMin')!.onclick = () => void win.minimize();
document.getElementById('wMax')!.onclick = () => void win.toggleMaximize();
document.getElementById('wClose')!.onclick = () => void win.close();

// ---------- mini explorer ----------
type Ent = { name: string; dir: boolean };
type Found = { path: string; dir: boolean };
const $ftree = document.getElementById('ftree')!;
const $fq = document.getElementById('fq') as HTMLInputElement;
const $fpath = document.getElementById('fpath')!;
let explRoot = '';
let lastSync = '';
let explToken = 0;
const expanded = new Set<string>();
const dirCache = new Map<string, Ent[]>();
let fqTimer: number | undefined;

const joinPath = (a: string, b: string) => a.replace(/[\\/]+$/, '') + '\\' + b;
const parentPath = (p: string) => {
  const s = p.replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i <= 2 ? s.slice(0, 3) : s.slice(0, i);
};
const psQuote = (p: string) => `'${p.replace(/'/g, "''")}'`;

function sendToActive(text: string) {
  const tab = tabs[activeTab];
  if (tab) { void invoke('pty_write', { id: tab.active, data: text }); panes.get(tab.active)?.term.focus(); }
}
function cdTo(path: string) { sendToActive(`cd ${psQuote(path)}\r`); }

function syncExplorer(force = false) {
  const cwd = panes.get(tabs[activeTab]?.active ?? -1)?.cwd ?? '';
  if (cwd && (cwd !== lastSync || force)) {
    lastSync = cwd; explRoot = cwd;
    if (ui.files) void explRender();
  }
}

function fileRow(icon: string, name: string, dir: boolean, indent: number, sub?: string): HTMLElement {
  const r = document.createElement('div');
  r.className = 'fr' + (dir ? ' dir' : '');
  r.style.paddingLeft = `${8 + indent * 14}px`;
  const ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = icon;
  const nm = document.createElement('span'); nm.textContent = name;
  r.append(ic, nm);
  if (sub) { const s = document.createElement('span'); s.className = 'sub'; s.textContent = sub; r.append(s); }
  return r;
}

async function loadDir(p: string): Promise<Ent[]> {
  const hit = dirCache.get(p);
  if (hit) return hit;
  try { const r = await invoke<Ent[]>('list_dir', { path: p }); dirCache.set(p, r); return r; } catch { return []; }
}

async function addDir(frag: DocumentFragment, p: string, depth: number, token: number) {
  const ents = await loadDir(p);
  for (const e of ents) {
    if (token !== explToken) return;
    const full = joinPath(p, e.name);
    const open = e.dir && expanded.has(full);
    const row = fileRow(e.dir ? (open ? '▾' : '▸') : '·', e.name, e.dir, depth);
    row.onclick = () => {
      if (!e.dir) return;
      if (open) expanded.delete(full); else expanded.add(full);
      void explRender();
    };
    row.ondblclick = () => { if (e.dir) cdTo(full); else sendToActive(psQuote(full) + ' '); };
    frag.appendChild(row);
    if (open) await addDir(frag, full, depth + 1, token);
  }
}

async function explRender() {
  const token = ++explToken;
  $fpath.textContent = explRoot;
  $fpath.title = explRoot;
  if (!explRoot) { $ftree.replaceChildren(); return; }
  const frag = document.createDocumentFragment();
  const q = $fq.value.trim();
  if (q.length >= 2) {
    const res = await invoke<Found[]>('search_paths', { root: explRoot, query: q }).catch(() => [] as Found[]);
    if (token !== explToken) return;
    for (const f of res) {
      const rel = f.path.startsWith(explRoot) ? f.path.slice(explRoot.length).replace(/^[\\/]/, '') : f.path;
      const row = fileRow(f.dir ? '▸' : '·', basename(f.path), f.dir, 0, parentPath(rel) === rel ? '' : rel);
      row.title = f.path;
      row.onclick = () => { if (f.dir) { explRoot = f.path; $fq.value = ''; void explRender(); } };
      row.ondblclick = () => { if (f.dir) cdTo(f.path); else sendToActive(psQuote(f.path) + ' '); };
      frag.appendChild(row);
    }
  } else {
    await addDir(frag, explRoot, 0, token);
  }
  if (token !== explToken) return;
  $ftree.replaceChildren(frag);
}

document.getElementById('fUp')!.onclick = () => { if (explRoot) { explRoot = parentPath(explRoot); void explRender(); } };
document.getElementById('fRef')!.onclick = () => { dirCache.clear(); void explRender(); };
$fq.addEventListener('input', () => { clearTimeout(fqTimer); fqTimer = window.setTimeout(() => void explRender(), 250); });

// ---------- boot ----------
async function restoreNode(s: SNode, ids: number[]): Promise<Node> {
  if (s.t === 'leaf') {
    const id = await createPane(s.cwd);
    ids.push(id);
    return { t: 'leaf', id };
  }
  const a = await restoreNode(s.a, ids);
  const b = await restoreNode(s.b, ids);
  return { t: 'split', dir: s.dir, a, b, r: s.r };
}

applyLayout();
(async () => {
  const st = loadState();
  if (st) {
    for (const t of st.tabs) {
      const ids: number[] = [];
      const root = await restoreNode(t.root, ids);
      tabs.push({ root, active: ids[Math.min(t.active, ids.length - 1)] ?? ids[0] });
    }
    activeTab = Math.min(st.activeTab, tabs.length - 1);
    render();
  } else {
    await newTab('');
  }
})();
