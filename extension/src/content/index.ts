// Isolated-world entry. Runs at document_start on www.youtube.com.
import { onIsolatedMessage, sendToMain } from '../shared/bridge';
import { MIRROR_KEY, readMirror, STORAGE_KEY, withDefaults, type Settings } from '../shared/settings';
import { collectDiagnostics, saveAutoSnapshot } from './diagnostics';
import { toast } from './dom';
import { classicLayout } from './modules/classicLayout';
import { declutter } from './modules/declutter';
import { density } from './modules/density';
import { description } from './modules/description';
import { playerSize } from './modules/playerSize';
import { shorts } from './modules/shorts';
import { sidebarFix } from './modules/sidebarFix';
import { stats } from './modules/stats';
import { viewMode } from './modules/viewMode';
import type { Ctx, Module, PageInfo } from './types';

const modules: Module[] = [viewMode, classicLayout, density, playerSize, sidebarFix, description, shorts, declutter, stats];

function readPage(): PageInfo {
  const isWatch = location.pathname === '/watch';
  return {
    path: location.pathname,
    isWatch,
    videoId: isWatch ? new URLSearchParams(location.search).get('v') : null,
  };
}

// Start from the mirrored copy so CSS applies before the first paint.
const ctx: Ctx = { settings: readMirror(), page: readPage(), video: null };

function each(fn: (m: Module) => void) {
  for (const m of modules) {
    try {
      fn(m);
    } catch (err) {
      console.error(`[BetterTube] ${m.id}:`, err);
    }
  }
}

// Colours for BetterTube's own UI. YouTube marks its dark theme with html[dark];
// its --yt-spec-* variables aren't reliably defined where we insert elements.
const THEME = `
html {
  --bt-text: #0f0f0f; --bt-text-2: #606060; --bt-chip: rgba(0,0,0,.05); --bt-chip-hover: rgba(0,0,0,.1);
  --bt-link: #065fd4; --bt-menu: #ffffff; --bt-shadow: 0 4px 32px rgba(0,0,0,.15);
}
html[dark] {
  --bt-text: #f1f1f1; --bt-text-2: #aaaaaa; --bt-chip: rgba(255,255,255,.1); --bt-chip-hover: rgba(255,255,255,.2);
  --bt-link: #3ea6ff; --bt-menu: #282828; --bt-shadow: 0 4px 32px rgba(0,0,0,.4);
}
.bt-toast {
  position: absolute; top: 16px; left: 50%; z-index: 70; max-width: 60%;
  padding: 8px 12px; border-radius: 8px; background: rgba(0,0,0,.78); color: #fff;
  font: 500 14px/1.3 Roboto, Arial, sans-serif; pointer-events: none;
  opacity: 0; transform: translate(-50%, -4px); transition: opacity .2s, transform .2s;
}
.bt-toast.bt-visible { opacity: 1; transform: translate(-50%, 0); }
.bt-update-bar {
  position: fixed; right: 16px; bottom: 16px; z-index: 9999; display: flex; align-items: center; gap: 10px;
  padding: 10px 12px 10px 16px; border-radius: 12px; background: var(--bt-menu); color: var(--bt-text);
  box-shadow: var(--bt-shadow); font: 400 1.4rem/1.4 Roboto, Arial, sans-serif;
}
.bt-update-bar button {
  border: 0; border-radius: 18px; padding: 6px 14px; cursor: pointer; font: 500 1.4rem Roboto, Arial, sans-serif;
  background: var(--bt-text); color: var(--bt-menu);
}
.bt-update-bar button:last-child { background: none; color: var(--bt-text-2); padding: 6px 8px; }
`;

const style = document.createElement('style');
style.id = 'bettertube-style';
function applyStyles() {
  style.textContent = THEME + modules.map((m) => m.css?.(ctx.settings) ?? '').join('\n');
  if (!style.isConnected) (document.head ?? document.documentElement).append(style);
}

function publishSettings() {
  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(ctx.settings));
  } catch {
    // Storage can be blocked; the MAIN world then falls back to defaults.
  }
  sendToMain({ type: 'settings', settings: ctx.settings });
}

let lastUrl = '';
function checkNavigation() {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  ctx.page = readPage();
  if (!ctx.page.isWatch || ctx.video?.videoId !== ctx.page.videoId) ctx.video = null;
  each((m) => m.onPage?.(ctx));
}

async function start() {
  applyStyles();
  ctx.settings = withDefaults((await chrome.storage.sync.get(STORAGE_KEY))[STORAGE_KEY] as Partial<Settings> | undefined);
  applyStyles();
  publishSettings();
  each((m) => m.init?.(ctx));

  // YouTube is a single-page app: these fire on in-app navigation.
  document.addEventListener('yt-navigate-finish', checkNavigation);
  document.addEventListener('yt-page-data-updated', checkNavigation);
  window.addEventListener('popstate', checkNavigation);
  setInterval(checkNavigation, 1000);
  checkNavigation();

  // <head> doesn't exist yet at document_start; keep the style last in it.
  document.addEventListener('DOMContentLoaded', () => document.head?.append(style));
}

onIsolatedMessage((msg) => {
  if (msg.type === 'toast') toast(msg.text);
  if (msg.type !== 'video') return;
  ctx.video = msg.info;
  each((m) => m.onVideo?.(ctx, msg.info));
  // One snapshot after the page settles, one after the theater guard has finished.
  const id = msg.info.videoId;
  for (const [delay, label] of [[6000, 'settled'], [18000, 'after-guard']] as const) {
    setTimeout(() => {
      if (ctx.video?.videoId === id) void saveAutoSnapshot(ctx, modules, label);
    }, delay);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes[STORAGE_KEY]) return;
  ctx.settings = withDefaults(changes[STORAGE_KEY].newValue as Partial<Settings> | undefined);
  applyStyles();
  publishSettings();
  each((m) => m.onSettings?.(ctx));
});

const VERSION = chrome.runtime.getManifest().version;

/**
 * After BetterTube is reloaded or updated, the scripts already in open tabs
 * are cut off from the extension. Say so, instead of silently doing nothing.
 */
function watchForUpdate() {
  const timer = setInterval(() => {
    if (chrome.runtime?.id) return;
    clearInterval(timer);
    const bar = document.createElement('div');
    bar.className = 'bt-update-bar';
    bar.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.textContent = 'BetterTube was updated. Reload this tab to use the new version.';
    const reload = document.createElement('button');
    reload.textContent = 'Reload';
    reload.addEventListener('click', () => location.reload());
    const close = document.createElement('button');
    close.textContent = '✕';
    close.setAttribute('aria-label', 'Dismiss');
    close.addEventListener('click', () => bar.remove());
    bar.append(text, reload, close);
    document.body.append(bar);
  }, 5000);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'ping') {
    sendResponse({ version: VERSION, page: ctx.page, video: ctx.video?.title ?? null });
    return;
  }
  if (msg?.type !== 'diagnostics') return;
  void collectDiagnostics(ctx, modules).then(sendResponse);
  return true; // async response
});

void start();
watchForUpdate();
