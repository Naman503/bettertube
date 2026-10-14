// Puts the watch page back to: player + description + comments on the left,
// up-next videos on the right. The MAIN-world script first tries experiment
// flags; this is the DOM fallback for layouts the flags don't cover.
import { $, pathOf, waitFor } from '../dom';
import type { Check, Module } from '../types';

export type LayoutVariant = 'classic' | 'comments-sidebar' | 'grid' | 'single-column' | 'unknown';

function parts() {
  const flexy = $('ytd-watch-flexy');
  return {
    flexy,
    grid: $('ytd-watch-grid'),
    secondary: flexy && ($('#secondary-inner', flexy) ?? $('#secondary', flexy)),
    below: flexy && $('#below', flexy),
    related: flexy && $('#related', flexy),
    metadata: flexy && $('ytd-watch-metadata', flexy),
    comments: flexy && ($('ytd-comments#comments', flexy) ?? $('#comments', flexy)),
  };
}

export function detectLayout(): LayoutVariant {
  const p = parts();
  if (p.grid && !p.flexy) return 'grid';
  if (!p.flexy || !p.secondary) return 'unknown';
  if (p.secondary.getBoundingClientRect().width < 250) return 'single-column';
  if ((p.comments && p.secondary.contains(p.comments)) || (p.metadata && p.secondary.contains(p.metadata))) {
    return 'comments-sidebar';
  }
  if (p.related && p.secondary.contains(p.related)) return 'classic';
  return 'unknown';
}

function relocate() {
  const p = parts();
  if (!p.flexy || !p.secondary || !p.below) return;
  // Narrow windows legitimately stack everything in one column.
  if (p.secondary.getBoundingClientRect().width < 250) return;
  if (p.related && !p.secondary.contains(p.related)) p.secondary.append(p.related);
  if (p.metadata && p.secondary.contains(p.metadata)) p.below.prepend(p.metadata);
  if (p.comments && p.secondary.contains(p.comments)) p.below.append(p.comments);
}

let observer: MutationObserver | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

export const classicLayout: Module = {
  id: 'classicLayout',

  async onPage(ctx) {
    if (!ctx.page.isWatch || !ctx.settings.classicLayout) return;
    relocate();
    if (observer) return;
    // On a fresh load this runs before YouTube has built the watch page.
    const flexy = await waitFor('ytd-watch-flexy', { timeout: 30_000 });
    if (!flexy || observer) return;
    // YouTube re-renders columns lazily (comments load, window resizes), so keep fixing.
    observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (ctx.settings.classicLayout && ctx.page.isWatch) relocate();
      }, 250);
    });
    observer.observe(flexy, { childList: true, subtree: true });
  },

  onSettings(ctx) {
    this.onPage?.(ctx);
  },

  check(ctx) {
    if (!ctx.page.isWatch) return [];
    const p = parts();
    const layout = detectLayout();
    const checks: Check[] = [
      {
        label: 'Watch layout',
        status: layout === 'classic' || layout === 'single-column' ? 'ok' : layout === 'unknown' ? 'fail' : 'warn',
        detail: layout,
      },
      { label: 'Up-next videos at', status: 'info', detail: pathOf(p.related) ?? 'not found' },
      { label: 'Description at', status: 'info', detail: pathOf(p.metadata) ?? 'not found' },
      { label: 'Comments at', status: 'info', detail: pathOf(p.comments) ?? 'not found' },
    ];
    return checks;
  },
};
