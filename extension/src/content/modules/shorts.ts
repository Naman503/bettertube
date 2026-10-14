// Hides Shorts shelves, items and nav entries; opens /shorts/ID in the normal player.
import { isVisible } from '../dom';
import type { Module } from '../types';

const SHORTS_SELECTORS = [
  'ytd-reel-shelf-renderer',
  'ytd-rich-shelf-renderer[is-shorts]',
  'ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts])',
  'ytd-rich-section-renderer:has(a[href^="/shorts/"])',
  'grid-shelf-view-model:has(a[href^="/shorts/"])',
  'ytd-rich-item-renderer:has(a[href^="/shorts/"])',
  'ytd-video-renderer:has(a[href^="/shorts/"])',
  'ytd-grid-video-renderer:has(a[href^="/shorts/"])',
  'ytd-compact-video-renderer:has(a[href^="/shorts/"])',
  'yt-lockup-view-model:has(a[href^="/shorts/"])',
  'ytm-shorts-lockup-view-model',
  'ytm-shorts-lockup-view-model-v2',
  // Sidebar entries have no href; the title is localised ("Shorts" in English).
  'ytd-guide-entry-renderer:has(> a[title="Shorts"])',
  'ytd-mini-guide-entry-renderer[aria-label="Shorts"]',
  'yt-tab-shape[tab-title="Shorts"]',
];

function redirect() {
  const m = /^\/shorts\/([\w-]{6,})/.exec(location.pathname);
  if (m) location.replace(`/watch?v=${m[1]}`);
}

export const shorts: Module = {
  id: 'shorts',

  css(s) {
    return s.hideShorts ? `${SHORTS_SELECTORS.join(',\n')} { display: none !important; }\n` : '';
  },

  onPage(ctx) {
    if (ctx.settings.redirectShorts) redirect();
  },

  check(ctx) {
    if (!ctx.settings.hideShorts) return [];
    const visible = [...document.querySelectorAll('a[href^="/shorts/"]')].filter(isVisible).length;
    return [
      {
        label: 'Visible Shorts links',
        status: visible ? 'warn' : 'ok',
        detail: String(visible),
      },
    ];
  },
};
