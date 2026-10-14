import { onIsolatedMessage, sendToMain, type MainRecon } from '../shared/bridge';
import type { Diagnostics, DiagnosticCheck } from '../shared/diagnostics';
import { $, alive } from './dom';
import { sidebarProbe } from './modules/sidebarFix';
import { viewSignals, viewTrace } from './modules/viewMode';
import type { Ctx, Module } from './types';

export const AUTO_SNAPSHOT_KEY = 'diag:auto';
const LAYOUT_FLAGS = /watch|theat|secondary|sidebar|side_menu|grid|panel|column|player_width|lockup|related|delhi|rounded/i;

/**
 * Saves what the page looks like a few seconds after a video loads to
 * chrome.storage.local, so layout problems can be investigated without
 * asking you to copy anything. Only page structure and settings, nothing
 * about your account.
 */
export async function saveAutoSnapshot(ctx: Ctx, modules: Module[], label: string) {
  if (!ctx.page.isWatch || !alive()) return;
  try {
    await writeSnapshot(ctx, modules, label);
  } catch {
    // extension reloaded mid-call
  }
}

async function writeSnapshot(ctx: Ctx, modules: Module[], label: string) {
  const d = await collectDiagnostics(ctx, modules);
  const flags = d.main?.experimentFlags ?? {};
  const snapshot = {
    label,
    ...d,
    main: d.main && {
      ...d.main,
      experimentFlags: Object.fromEntries(Object.entries(flags).filter(([k]) => LAYOUT_FLAGS.test(k))),
      playerFlags: d.main.playerFlags
        ?.split('&')
        .filter((kv) => LAYOUT_FLAGS.test(kv.split('=')[0]))
        .join('&'),
      video: d.main.video && { ...d.main.video, description: `${d.main.video.description.length} chars` },
    },
    view: { signals: viewSignals(), trace: viewTrace },
    sidebar: sidebarProbe(),
  };
  await chrome.storage.local.set({ [AUTO_SNAPSHOT_KEY]: snapshot });
}

const pending = new Map<string, (data: MainRecon) => void>();

onIsolatedMessage((msg) => {
  if (msg.type === 'recon-result') pending.get(msg.id)?.(msg.data);
});

function requestMainRecon(): Promise<MainRecon | null> {
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(null);
    }, 1500);
    pending.set(id, (data) => {
      clearTimeout(timer);
      pending.delete(id);
      resolve(data);
    });
    sendToMain({ type: 'recon', id });
  });
}

/** Indented outline of custom elements and ids under the watch page, 4 levels deep. */
function layoutTree(): string | null {
  const root = $('ytd-watch-flexy') ?? $('ytd-watch-grid');
  if (!root) return null;
  const lines: string[] = [];
  const walk = (el: Element, depth: number) => {
    const named = el.id || el.localName.includes('-');
    if (named) {
      const attrs = [...el.attributes]
        .map((a) => a.name)
        .filter((n) => !['id', 'class', 'style'].includes(n))
        .slice(0, 8);
      const size = el.getBoundingClientRect();
      lines.push(
        `${'  '.repeat(depth)}${el.localName}${el.id ? `#${el.id}` : ''}` +
          `${attrs.length ? ` [${attrs.join(' ')}]` : ''} ${Math.round(size.width)}×${Math.round(size.height)}`,
      );
    }
    if (depth < 4) for (const child of el.children) walk(child, named ? depth + 1 : depth);
  };
  walk(root, 0);
  return lines.slice(0, 200).join('\n');
}

export async function collectDiagnostics(ctx: Ctx, modules: Module[]): Promise<Diagnostics> {
  const checks: DiagnosticCheck[] = [];
  for (const m of modules) {
    try {
      for (const c of m.check?.(ctx) ?? []) checks.push({ module: m.id, ...c });
    } catch (err) {
      checks.push({ module: m.id, label: 'check crashed', status: 'fail', detail: String(err) });
    }
  }

  const main = await requestMainRecon();
  if (!main) {
    checks.unshift({ module: 'core', label: 'Page script', status: 'fail', detail: 'no response from MAIN world' });
  } else {
    const flags = Object.entries(main.appliedFlags);
    checks.push({
      module: 'flags',
      label: 'Experiment flags overridden',
      status: 'info',
      detail: flags.length ? flags.map(([k, v]) => `${k}: ${v.from} → ${v.to}`).join('; ') : 'none needed',
    });
    checks.push({
      module: 'performance',
      label: 'Codec filter',
      status: 'info',
      detail: `${main.codecMode}${main.currentCodecs ? ` · playing ${main.currentCodecs}` : ''}`,
    });
    if (main.currentQuality) {
      checks.push({ module: 'playback', label: 'Quality', status: 'info', detail: main.currentQuality });
    }
  }

  return {
    version: chrome.runtime.getManifest().version,
    url: location.href,
    collectedAt: new Date().toISOString(),
    checks,
    settings: ctx.settings,
    layoutTree: layoutTree(),
    main,
  };
}
