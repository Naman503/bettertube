// Lets you size the video: drag the divider between the player and the up-next
// column (double-click it to reset), or set the width / theater height in the
// popup. Widths go through a stylesheet with !important so they beat the
// inline sizes YouTube computes.
import { STORAGE_KEY, withDefaults, type Settings } from '../../shared/settings';
import { $, alive, waitFor } from '../dom';
import type { Ctx, Module } from '../types';

const MIN_SIDEBAR = 240;
const DEFAULT_COMPACT_SIDEBAR = 402;

const style = document.createElement('style');
style.id = 'bettertube-player-size';

/** Sidebar width in effect: the user's, else the classic 402px when the compact list is on. */
export const effectiveWidth = (s: Settings) => s.sidebarWidth || (s.compactSidebar ? DEFAULT_COMPACT_SIDEBAR : 0);

function css(sidebar: number, theaterHeight: number) {
  let out = '';
  if (sidebar) {
    out += `
/* Read by the sidebar fixer's inline styles, so dragging updates it live. */
ytd-watch-flexy { --bt-sidebar-w: ${sidebar}px; }
ytd-watch-flexy:not([theater]):not([fullscreen]):not([split-scroll]) {
  --ytd-watch-flexy-sidebar-width: ${sidebar}px !important;
  --ytd-watch-flexy-sidebar-min-width: ${sidebar}px !important;
}
ytd-watch-flexy:not([theater]):not([fullscreen]):not([split-scroll]) #secondary:not(:has(> #secondary-split-scroll-spacer:not([hidden]))) {
  width: ${sidebar}px !important; min-width: ${sidebar}px !important; max-width: ${sidebar}px !important;
  flex: 0 0 ${sidebar}px !important;
}`;
  }
  if (theaterHeight) {
    out += `
ytd-watch-flexy[theater]:not([fullscreen]) :is(#full-bleed-container, #player-full-bleed-container) {
  height: ${theaterHeight}vh !important; max-height: ${theaterHeight}vh !important; min-height: 0 !important;
}`;
  }
  return out;
}

let resizeFrame = 0;
/** YouTube recomputes the player size on window resize. */
function nudgeLayout() {
  if (document.fullscreenElement) return;
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

function applySizes(s: Settings, sidebarOverride?: number) {
  style.textContent = css(sidebarOverride ?? effectiveWidth(s), s.theaterHeight);
  if (!style.isConnected) (document.head ?? document.documentElement).append(style);
  nudgeLayout();
}

async function save(patch: Partial<Settings>) {
  if (!alive()) return;
  const stored = (await chrome.storage.sync.get(STORAGE_KEY))[STORAGE_KEY] as Partial<Settings> | undefined;
  await chrome.storage.sync.set({ [STORAGE_KEY]: { ...withDefaults(stored), ...patch } });
}

let handle: HTMLDivElement | null = null;

async function ensureHandle(ctx: Ctx) {
  const secondary = await waitFor('ytd-watch-flexy #secondary');
  if (!secondary || (handle && secondary.contains(handle))) return;
  handle?.remove();
  handle = document.createElement('div');
  handle.className = 'bt-resize-handle';
  handle.title = 'Drag to resize the video · double-click to reset';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const h = handle!;
    h.setPointerCapture(e.pointerId);
    h.classList.add('bt-dragging');
    document.documentElement.classList.add('bt-resizing');
    const right = secondary.getBoundingClientRect().right;
    let width = secondary.getBoundingClientRect().width;
    const move = (ev: PointerEvent) => {
      const max = Math.round(window.innerWidth * 0.65);
      width = Math.round(Math.min(max, Math.max(MIN_SIDEBAR, right - ev.clientX)));
      applySizes(ctx.settings, width);
    };
    const up = () => {
      h.removeEventListener('pointermove', move);
      h.classList.remove('bt-dragging');
      document.documentElement.classList.remove('bt-resizing');
      void save({ sidebarWidth: width });
    };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up, { once: true });
    h.addEventListener('pointercancel', up, { once: true });
  });
  handle.addEventListener('dblclick', () => void save({ sidebarWidth: 0 }));
  secondary.prepend(handle);
}

export const playerSize: Module = {
  id: 'playerSize',

  css: () => `
ytd-watch-flexy #secondary { position: relative; }
.bt-resize-handle {
  position: absolute; top: 0; bottom: 0; left: -14px; width: 12px; z-index: 5;
  cursor: col-resize; touch-action: none;
}
.bt-resize-handle::after {
  content: ""; position: absolute; top: 0; bottom: 0; left: 4px; width: 4px; border-radius: 2px;
  background: var(--bt-text-2); opacity: 0; transition: opacity .15s;
}
.bt-resize-handle:hover::after { opacity: .35; }
.bt-resize-handle.bt-dragging::after { opacity: .7; background: var(--bt-link); }
ytd-watch-flexy[theater] .bt-resize-handle, ytd-watch-flexy[fullscreen] .bt-resize-handle { display: none; }
html.bt-resizing, html.bt-resizing * { cursor: col-resize !important; user-select: none !important; }
`,

  init(ctx) {
    applySizes(ctx.settings);
    document.addEventListener('DOMContentLoaded', () => document.head?.append(style));
  },

  onSettings(ctx) {
    applySizes(ctx.settings);
  },

  onPage(ctx) {
    if (ctx.page.isWatch) {
      void ensureHandle(ctx);
      nudgeLayout();
    }
  },

  check(ctx) {
    if (!ctx.page.isWatch) return [];
    const secondary = $('ytd-watch-flexy #secondary');
    const width = secondary ? Math.round(secondary.getBoundingClientRect().width) : 0;
    const side = $('#fixed-side-menu');
    return [
      {
        label: 'Up-next column width',
        status: 'info',
        detail: `${width}px (setting: ${ctx.settings.sidebarWidth || 'default'}) · drag handle ${handle?.isConnected ? 'present' : 'missing'}`,
      },
      { label: 'New side menu (#fixed-side-menu)', status: 'info', detail: side ? 'present' : 'absent' },
    ];
  },
};
