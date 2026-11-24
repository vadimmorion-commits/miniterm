import type { Plugin } from './types';
import { h, btn } from './dom';

const KYIV = 'Europe/Kyiv';

/** Offset (ms) of `tz` relative to UTC at the instant `ms`. */
function tzOffsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const g = (t: string) => Number(parts.find(p => p.type === t)!.value);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Interpret wall-clock components as time in `tz` → epoch ms. */
function wallToEpoch(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  let t = guess - tzOffsetMs(guess, tz);
  t = guess - tzOffsetMs(t, tz); // second pass handles DST boundaries
  return t;
}

function fmtTz(ms: number, tz: string): string {
  const d = new Date(ms);
  const date = d.toLocaleString('sv-SE', { timeZone: tz, hourCycle: 'h23' }); // YYYY-MM-DD HH:MM:SS
  const off = tzOffsetMs(ms, tz) / 60000;
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  const label = `UTC${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
  return `${date}  (${label})`;
}

type Mode = 'kyiv' | 'utc';

/** Parse epoch numbers (s/ms/µs/ns) or dates; zone-less dates use `mode`. */
function parseTime(input: string, mode: Mode): number | null {
  const s = input.trim();
  if (!s) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s), abs = Math.abs(n);
    if (abs < 1e11) return n * 1000;   // seconds
    if (abs < 1e14) return n;          // milliseconds
    if (abs < 1e17) return n / 1000;   // microseconds
    return n / 1e6;                    // nanoseconds
  }
  // explicit zone (Z or ±hh:mm) -> trust it
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  // zone-less: YYYY-MM-DD[ T]HH:MM[:SS[.mmm]]  or  DD.MM.YYYY HH:MM[:SS]
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(s);
  let parts: number[] | null = null;
  if (m) parts = [+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), +((m[7] ?? '0').padEnd(3, '0'))];
  else {
    m = /^(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
    if (m) parts = [+m[3], +m[2], +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), 0];
  }
  if (!parts) { const t = Date.parse(s); return Number.isNaN(t) ? null : t; }
  const [y, mo, d, hh, mi, ss, ms] = parts;
  return mode === 'kyiv' ? wallToEpoch(y, mo, d, hh, mi, ss, ms, KYIV) : Date.UTC(y, mo - 1, d, hh, mi, ss, ms);
}

function relative(ms: number): string {
  const d = (Date.now() - ms) / 1000;
  const a = Math.abs(d);
  const u: [number, string][] = [[31536000, 'г.'], [2592000, 'мес.'], [86400, 'дн.'], [3600, 'ч'], [60, 'мин'], [1, 'с']];
  for (const [sec, name] of u) if (a >= sec) { const n = Math.floor(a / sec); return d >= 0 ? `${n} ${name} назад` : `через ${n} ${name}`; }
  return 'сейчас';
}

export const timeTool: Plugin = {
  id: 'time',
  title: 'Unix-время',
  icon: '⏱',
  mount(root, api) {
    const input = h('input', { spellcheck: false, class: 'pin', placeholder: 'Unix (с/мс/мкс/нс) или дата: 2026-11-24 15:30:00' });
    const sel = h('select', { class: 'pin small wide-sel', title: 'Как читать дату без часового пояса' },
      h('option', { value: 'kyiv' }, 'дата = Киев'), h('option', { value: 'utc' }, 'дата = UTC'));
    const out = h('div', { class: 'tout' });
    const now = h('div', { class: 'tnow' });

    const row = (label: string, value: string, strong = false) =>
      h('div', { class: 'trow' + (strong ? ' strong' : '') }, h('span', { class: 'tl' }, label), h('span', { class: 'tv' }, value),
        btn('⧉', () => api.copy(value.replace(/\s+\(UTC.*\)$/, '')), 'Копировать'));

    const run = () => {
      out.replaceChildren();
      if (!input.value.trim()) return;
      const ms = parseTime(input.value, sel.value as Mode);
      if (ms === null || Number.isNaN(new Date(ms).getTime())) {
        out.append(h('div', { class: 'pstatus err' }, '✗ не удалось разобрать'));
        return;
      }
      const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      out.append(
        row('Киев', fmtTz(ms, KYIV), true),
        row('UTC', fmtTz(ms, 'UTC')),
        ...(localTz !== KYIV && localTz !== 'UTC' ? [row('Локально', fmtTz(ms, localTz))] : []),
        row('Unix, секунды', String(Math.floor(ms / 1000))),
        row('Unix, мс', String(Math.floor(ms))),
        row('ISO UTC', new Date(ms).toISOString()),
        row('Давность', relative(ms)),
      );
    };
    const tick = () => {
      const t = Date.now();
      now.textContent = `Сейчас: ${Math.floor(t / 1000)} · ${t} · Киев ${fmtTz(t, KYIV)}`;
    };
    tick(); setInterval(tick, 1000);

    input.addEventListener('input', run);
    sel.addEventListener('change', run);
    root.append(
      now,
      h('div', { class: 'prow' }, input, sel,
        btn('Сейчас', () => { input.value = String(Math.floor(Date.now() / 1000)); run(); }),
        btn('Из выделения', () => { input.value = api.getSelection().trim(); run(); })),
      out,
    );
  },
};
