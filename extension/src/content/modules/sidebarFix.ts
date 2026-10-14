// Keeps the up-next list a single column of the chosen width beside the video,
// whatever layout YouTube serves. The 2026 layouts change element names and
// grid rules often, so this measures the page instead of trusting selectors:
// it finds the up-next results, collapses any multi-column grid holding them,
// and sizes the column that contains them.
import { $, pathOf, waitFor } from '../dom';
import type { Ctx, Module } from '../types';
import { effectiveWidth } from './playerSize';

const RESULTS = 'ytd-watch-flexy ytd-watch-next-secondary-results-renderer';
const ITEM = 'yt-lockup-view-model, ytd-compact-video-renderer, ytd-compact-radio-renderer, ytd-compact-playlist-renderer';

const important = (el: HTMLElement, styles: Record<string, string>) => {
  for (const [k, v] of Object.entries(styles)) {
    if (el.style.getPropertyValue(k) !== v || el.style.getPropertyPriority(k) !== 'important') {
      el.style.setProperty(k, v, 'important');
    }
  }
};

const columnCount = (el: Element) => {
  const cs = getComputedStyle(el);
  return cs.display.includes('grid') ? cs.gridTemplateColumns.split(' ').filter(Boolean).length : 1;
};

/** Grids between the results renderer and its first items. */
function gridsHoldingItems(results: HTMLElement): HTMLElement[] {
  const grids = new Set<HTMLElement>();
  for (const item of [...results.querySelectorAll<HTMLElement>(ITEM)].slice(0, 3)) {
    for (let n = item.parentElement; n && n !== results.parentElement; n = n.parentElement) {
      if (columnCount(n) > 1) grids.add(n);
    }
  }
  return [...grids];
}

/** The up-next column: #secondary if there is one, else the results' outermost box beside the player. */
function columnOf(results: HTMLElement): HTMLElement {
  return results.closest<HTMLElement>('#secondary') ?? results;
}

function isSplitScroll(column: HTMLElement) {
  const spacer = column.querySelector<HTMLElement>(':scope > #secondary-split-scroll-spacer');
  return (
    !!$('ytd-watch-flexy[split-scroll]') ||
    (!!spacer && !spacer.hidden && spacer.getBoundingClientRect().width > 0) ||
    getComputedStyle(column).position === 'fixed'
  );
}

/** Earlier versions sized the split-scroll box itself; undo that on pages that still have it. */
function clearSplitScrollSizing(column: HTMLElement) {
  for (const n of [column, ...column.querySelectorAll<HTMLElement>('#secondary-inner, #related, ytd-watch-next-secondary-results-renderer')]) {
    for (const prop of ['width', 'min-width', 'max-width', 'flex']) {
      if (n.style.getPropertyPriority(prop) === 'important') n.style.removeProperty(prop);
    }
  }
}

let lastNudge = 0;
let lastAction = 'none yet';

function fix(ctx: Ctx) {
  const s = ctx.settings;
  const width = effectiveWidth(s);
  if (!ctx.page.isWatch || (!s.compactSidebar && !width)) return;
  if (document.fullscreenElement) return; // nothing to fix, and no re-layouts mid-fullscreen
  const results = $(RESULTS);
  const player = $('#movie_player')?.getBoundingClientRect();
  if (!results || !player || player.width === 0) return;
  const column = columnOf(results);
  // Only when up-next sits beside the player (not below it in theater or a narrow window).
  if (column.getBoundingClientRect().top > player.bottom - 40) return;
  // "Split scroll" pins #secondary as a full-width fixed box with a spacer on
  // the left; resizing that box squeezes the list to nothing. BetterTube turns
  // the layout off via flags; if it still shows up, only collapse the grid.
  const split = isSplitScroll(column);
  if (split) clearSplitScrollSizing(column);

  const actions: string[] = [];
  if (s.compactSidebar) {
    for (const grid of gridsHoldingItems(results)) {
      important(grid, { 'grid-template-columns': 'minmax(0, 1fr)' });
      actions.push(`1 column: ${pathOf(grid)}`);
    }
  }
  if (width && !split) {
    const w = 'var(--bt-sidebar-w, 402px)';
    important(column, { width: w, 'min-width': w, 'max-width': w, flex: `0 0 ${w}` });
    // Everything between the column and the list just fills it.
    for (let n: HTMLElement | null = results; n && n !== column; n = n.parentElement) {
      important(n, { width: '100%', 'max-width': '100%', 'min-width': '0' });
    }
    actions.push(`width ${Math.round(column.getBoundingClientRect().width)}px: ${pathOf(column)}`);
  }
  // If the player still runs underneath the list, have YouTube re-measure.
  const col = column.getBoundingClientRect();
  if (!split && player.right > col.left + 4 && Date.now() - lastNudge > 1000) {
    lastNudge = Date.now();
    window.dispatchEvent(new Event('resize'));
    actions.push(`overlap ${Math.round(player.right - col.left)}px → asked YouTube to re-measure`);
  }
  if (actions.length) lastAction = actions.join(' · ');
}

/** Geometry and computed styles along the up-next and player chains, for the snapshot. */
export function sidebarProbe() {
  const describe = (el: Element | null) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      el: `${el.localName}${el.id ? `#${el.id}` : ''}${el.classList.length ? `.${[...el.classList].slice(0, 3).join('.')}` : ''}`,
      attrs: [...el.attributes].map((a) => a.name).filter((n) => !['id', 'class', 'style'].includes(n)).slice(0, 10),
      rect: [r.left, r.top, r.width, r.height].map(Math.round),
      display: cs.display,
      cols: cs.gridTemplateColumns === 'none' ? undefined : cs.gridTemplateColumns,
      position: cs.position,
      flex: cs.flex,
      justify: cs.justifyContent,
      inline: (el as HTMLElement).getAttribute('style')?.slice(0, 200) ?? undefined,
    };
  };
  const chain = (start: Element | null, stop = 'ytd-watch-flexy') => {
    const out = [];
    for (let n = start; n && n.localName !== 'ytd-app'; n = n.parentElement) {
      out.push(describe(n));
      if (n.localName === stop) break;
    }
    return out;
  };
  const results = $(RESULTS);
  const firstItem = results?.querySelector(ITEM) ?? null;
  return {
    viewport: [document.documentElement.clientWidth, window.innerHeight],
    lastAction,
    upNextChain: chain(firstItem),
    playerChain: chain($('#movie_player')),
    sideMenu: describe($('#fixed-side-menu')),
    secondaryCount: document.querySelectorAll('ytd-watch-flexy #secondary').length,
    resultsCount: document.querySelectorAll('ytd-watch-next-secondary-results-renderer').length,
  };
}

let observer: MutationObserver | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

export const sidebarFix: Module = {
  id: 'sidebarFix',

  init(ctx) {
    window.addEventListener('resize', () => {
      clearTimeout(timer);
      timer = setTimeout(() => fix(ctx), 300);
    });
  },

  async onPage(ctx) {
    if (!ctx.page.isWatch) return;
    fix(ctx);
    if (observer) return;
    // On a fresh load this runs before YouTube has built the watch page.
    const flexy = await waitFor('ytd-watch-flexy', { timeout: 30_000 });
    if (!flexy || observer) return;
    // Items load lazily and YouTube re-renders the column; re-check after changes.
    observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => fix(ctx), 250);
    });
    observer.observe(flexy, { childList: true, subtree: true, attributes: true, attributeFilter: ['theater', 'full-bleed-player'] });
    fix(ctx);
  },

  onSettings(ctx) {
    fix(ctx);
  },

  check(ctx) {
    if (!ctx.page.isWatch) return [];
    const results = $(RESULTS);
    const grids = results ? gridsHoldingItems(results) : [];
    return [
      {
        label: 'Up-next as one column',
        status: !results ? 'warn' : grids.length ? 'fail' : 'ok',
        detail: !results ? 'results list not found' : grids.length ? `${grids.length} multi-column grid(s) left` : `ok · ${lastAction}`,
      },
    ];
  },
};
