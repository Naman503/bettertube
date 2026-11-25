// DOM helpers and number formats for the dashboard (charts are ECharts).
// Labels go in with textContent only.
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
