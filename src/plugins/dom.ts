type Kid = Node | string | null | undefined;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...kids: Kid[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'spellcheck') { el.setAttribute('spellcheck', String(v)); continue; }
    if (v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k in el) (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid != null) el.append(kid);
  return el;
}

export function btn(label: string, onclick: () => void, title = ''): HTMLButtonElement {
  return h('button', { class: 'pbtn', title, onclick }, label);
}

export function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try { return { ok: true, value: JSON.parse(text) }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}
