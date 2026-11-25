// Small DOM charts for the dashboard. Every mark has a hover/focus tooltip;
// labels go in with textContent only.
import { fmtDuration } from '../shared/stats';

export const $ = (id: string) => document.getElementById(id)!;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.setAttribute('style', v);
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

export function svgIcon(paths: string[], cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  for (const d of paths) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

// ---------- tooltip ----------

/** Tooltip lines: the first is the heading, the rest "value · label". */
export function bindTip(target: HTMLElement, text: string) {
  const tooltip = $('tooltip');
  target.tabIndex = 0;
  target.setAttribute('aria-label', text.replace(/\n/g, ', '));
  const show = (x: number, y: number) => {
    const [head, ...rest] = text.split('\n');
    tooltip.replaceChildren(el('div', { class: 'tt-head' }, head), ...rest.map((l) => el('div', { class: 'tt-row' }, l)));
    tooltip.hidden = false;
    const r = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.min(window.innerWidth - r.width - 8, Math.max(8, x - r.width / 2))}px`;
    tooltip.style.top = `${y - r.height - 12 < 8 ? y + 16 : y - r.height - 12}px`;
  };
  target.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
  target.addEventListener('pointerleave', () => (tooltip.hidden = true));
  target.addEventListener('focus', () => {
    const r = target.getBoundingClientRect();
    show(r.left + r.width / 2, r.top);
  });
  target.addEventListener('blur', () => (tooltip.hidden = true));
}

// ---------- scales ----------

export type Kind = 'time' | 'count' | 'speed';

const STEPS: Record<Kind, number[]> = {
  time: [1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720, 1440, 2880, 7200].map((m) => m * 60_000),
  count: [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000],
  speed: [0.25, 0.5, 1, 2],
};

/** A "nice" axis max and step (about four gridlines). */
export function niceScale(maxValue: number, kind: Kind) {
  const steps = STEPS[kind];
  const step = steps.find((s) => maxValue / s <= 4) ?? steps.at(-1)!;
  const max = Math.max(step, Math.ceil(maxValue / step) * step);
  return { max, step };
}

export function fmtAxis(v: number, kind: Kind) {
  if (kind === 'count') return String(v);
  if (kind === 'speed') return `${v}×`;
  if (v === 0) return '0';
  return v % 3_600_000 === 0 ? `${v / 3_600_000}h` : `${Math.round(v / 60_000)}m`;
}

export function fmtValue(v: number, kind: Kind) {
  if (kind === 'count') return v.toLocaleString();
  if (kind === 'speed') return v ? `${v.toFixed(2)}×` : '—';
  return fmtDuration(v);
}

// ---------- column chart ----------

export interface Point {
  label: string;
  value: number;
  tip: string;
  highlight?: boolean;
}

export interface Ref {
  value: number;
  label: string;
  cls: 'avg' | 'limit';
}

export function columnChart(points: Point[], { height = 200, labelEvery = 1, kind = 'time' as Kind, refs = [] as Ref[] } = {}) {
  const top = Math.max(0, ...points.map((p) => p.value), ...refs.map((r) => r.value));
  const { max, step } = niceScale(top, kind);
  const root = el('div', { class: 'colchart', style: `--h:${height}px` });
  const yaxis = el('div', { class: 'yaxis', 'aria-hidden': 'true' });
  const plot = el('div', { class: 'plot' });
  for (let v = 0; v <= max + 1e-9; v += step) {
    const pct = (v / max) * 100;
    yaxis.append(el('span', { style: `bottom:${pct}%` }, fmtAxis(Math.round(v * 100) / 100, kind)));
    if (v > 0) plot.append(el('div', { class: 'gridline', style: `bottom:${pct}%` }));
  }
  const cols = el('div', { class: 'cols' });
  const xlabels = el('div', { class: 'xlabels', 'aria-hidden': 'true' });
  points.forEach((p, i) => {
    const col = el('div', { class: `col${p.highlight ? ' today' : ''}` });
    if (p.value > 0) col.append(el('div', { class: 'bar', style: `height:${(p.value / max) * 100}%` }));
    bindTip(col, p.tip);
    cols.append(col);
    xlabels.append(el('span', {}, i % labelEvery === 0 ? p.label : ''));
  });
  plot.append(cols);
  for (const r of refs) {
    if (!r.value) continue;
    plot.append(
      el('div', { class: `refline ${r.cls}`, style: `bottom:${(r.value / max) * 100}%` }, el('span', {}, `${r.label} ${fmtValue(r.value, kind)}`)),
    );
  }
  root.append(yaxis, plot, xlabels);
  return root;
}

// ---------- horizontal bars ----------

export interface BarRow {
  name: string | Node;
  value: number;
  text: string;
  sub?: string;
  tip: string;
}

export function barList(rows: BarRow[], empty = 'Nothing yet') {
  if (!rows.length || rows.every((r) => !r.value)) return el('p', { class: 'muted' }, empty);
  const max = Math.max(...rows.map((r) => r.value)) || 1;
  const list = el('div', { class: 'hbars' });
  for (const r of rows) {
    const track = el('div', { class: 'track' }, el('div', { class: 'fill', style: `width:${(r.value / max) * 100}%` }));
    const name = el('div', { class: 'name' }, r.name);
    if (r.sub) name.append(el('span', { class: 'sub' }, r.sub));
    const row = el('div', { class: 'hbar' }, name, track, el('div', { class: 'val' }, r.text));
    bindTip(row, r.tip);
    list.append(row);
  }
  return list;
}

// ---------- heat cells ----------

/** 0 (nothing) … 5 (most), on a square-root scale so one huge day doesn't wash out the rest. */
export const heatLevel = (v: number, max: number) => (v <= 0 || max <= 0 ? 0 : Math.max(1, Math.ceil(Math.sqrt(v / max) * 5)));

export function heatLegend() {
  return el(
    'div',
    { class: 'heat-legend', 'aria-hidden': 'true' },
    el('span', {}, 'Less'),
    ...[0, 1, 2, 3, 4, 5].map((l) => el('i', { class: `cell l${l}` })),
    el('span', {}, 'More'),
  );
}
