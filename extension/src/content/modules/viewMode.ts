// Opens every video in the chosen view (normal or theater) instead of whatever
// YouTube remembered, and optionally strips the oversized theater controls.
//
// YouTube can switch into theater at several moments while a video loads
// (server render from the `wide` cookie, then its theater manager restoring a
// saved preference), so a single check is not enough: for the first seconds of
// each video we watch the mode and correct it, until the user toggles it
// themselves.
import type { ViewMode } from '../../shared/settings';
import { $, getCookie, setCookie, waitFor } from '../dom';
import type { Check, Module } from '../types';

const GUARD_MS = 15_000;
const MAX_CORRECTIONS = 6;

function sidebarBeside(player: DOMRect) {
  const side = $('ytd-watch-flexy #secondary')?.getBoundingClientRect();
  return !!side && side.width > 100 && side.left >= player.left + player.width / 2 && side.top < player.bottom;
}

/** How the page signals theater: attributes (classic layout) and geometry (any layout). */
function theaterSignals(flexy: Element | null) {
  const player = $('#movie_player');
  const rect = player?.getBoundingClientRect();
  const viewport = document.documentElement.clientWidth;
  return {
    attr: !!flexy && (flexy.hasAttribute('theater') || flexy.hasAttribute('full-bleed-player')),
    fullBleed: !!$('#player-full-bleed-container #movie_player'),
    // Theater stretches the player across (nearly) the whole window, with the
    // up-next column moved below it rather than beside it.
    wide: !!rect && rect.width > 0 && rect.width >= viewport * 0.8 && !sidebarBeside(rect),
    playerWidth: Math.round(rect?.width ?? 0),
    viewport,
  };
}

/** Fullscreen also fills the window; it is never "theater" and never corrected. */
const inFullscreen = () => !!document.fullscreenElement || !!$('ytd-watch-flexy[fullscreen]');

const isTheater = (flexy: Element | null) => {
  const s = theaterSignals(flexy);
  return s.attr || s.fullBleed || s.wide;
};

/** The player's theater / default-view button, wherever this player build puts it. */
function sizeButton(): HTMLElement | null {
  return (
    $('#movie_player .ytp-size-button') ??
    [...document.querySelectorAll<HTMLElement>('#movie_player button')].find((b) =>
      /theat|cinema|default view/i.test(`${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.dataset.titleNoTooltip ?? ''}`),
    ) ??
    null
  );
}

/** Same as pressing "t", for player builds without a findable button. */
function pressT() {
  const init = { key: 't', code: 'KeyT', keyCode: 84, which: 84, bubbles: true, cancelable: true } as KeyboardEventInit;
  ($('#movie_player') ?? document).dispatchEvent(new KeyboardEvent('keydown', init));
}

/** Recent guard decisions, kept for the diagnostics snapshot. */
export const viewTrace: string[] = [];
function trace(line: string) {
  viewTrace.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
  if (viewTrace.length > 40) viewTrace.shift();
}
export const viewSignals = () => ({ ...theaterSignals($('ytd-watch-flexy')), button: !!sizeButton() });

function writeWideCookie(mode: ViewMode) {
  // YouTube reads `wide` when rendering the watch page: 1 = theater, 0 = normal.
  if (mode !== 'remember') setCookie('wide', mode === 'theater' ? '1' : '0');
}

let guard: { videoId: string | null; until: number; corrections: number; userToggled: boolean } = {
  videoId: null,
  until: 0,
  corrections: 0,
  userToggled: false,
};
let guardObserver: MutationObserver | null = null;
let guardTimer: ReturnType<typeof setInterval> | undefined;
let lastCorrectionAt = 0;
let bigModeObserver: MutationObserver | null = null;
/** Last correction outcome, for diagnostics. */
let lastAction = 'none yet';

function enforce(mode: ViewMode) {
  if (mode === 'remember' || guard.userToggled || Date.now() > guard.until) return;
  if (inFullscreen()) return;
  const flexy = $('ytd-watch-flexy');
  if (!flexy || !$('#movie_player')) return;
  const want = mode === 'theater';
  if (isTheater(flexy) === want) return;
  // Give the previous click time to take effect before trying again.
  if (Date.now() - lastCorrectionAt < 600 || guard.corrections >= MAX_CORRECTIONS) return;
  guard.corrections++;
  lastCorrectionAt = Date.now();
  const button = sizeButton();
  const how = button ? 'size button' : '"t" key';
  lastAction = `switched to ${want ? 'theater' : 'normal'} view via ${how} (correction ${guard.corrections})`;
  trace(`${lastAction} · signals ${JSON.stringify(theaterSignals(flexy))}`);
  if (button) button.click();
  else pressT();
}

function stopGuard() {
  guardObserver?.disconnect();
  guardObserver = null;
  clearInterval(guardTimer);
}

async function startGuard(mode: ViewMode, videoId: string | null) {
  stopGuard();
  guard = { videoId, until: Date.now() + GUARD_MS, corrections: 0, userToggled: false };
  const flexy = await waitFor('ytd-watch-flexy');
  if (!flexy || guard.videoId !== videoId) return;
  // Slow loads: start the clock once the player exists.
  await waitFor('#movie_player', { timeout: 15_000 });
  if (guard.videoId !== videoId) return;
  guard.until = Date.now() + GUARD_MS;
  trace(`guard start ${videoId} · signals ${JSON.stringify(theaterSignals(flexy))}`);
  const run = () => {
    if (Date.now() > guard.until || guard.userToggled) stopGuard();
    else enforce(mode);
  };
  guardObserver = new MutationObserver(run);
  guardObserver.observe(flexy, { attributes: true, attributeFilter: ['theater', 'full-bleed-player'] });
  // Player resizing is the geometric signal.
  const player = $('#movie_player');
  if (player) guardObserver.observe(player, { attributes: true, attributeFilter: ['class', 'style'] });
  guardTimer = setInterval(run, 250);
  run();
}

export const viewMode: Module = {
  id: 'viewMode',

  init(ctx) {
    writeWideCookie(ctx.settings.viewMode);
    // Changing the view yourself (size or fullscreen button, "t", "f",
    // double-clicking the video) means you want that view for this video:
    // stop correcting until the next video.
    const userChose = (why: string) => {
      if (!guard.userToggled) trace(`you chose a view (${why}); not correcting this video`);
      guard.userToggled = true;
    };
    document.addEventListener(
      'click',
      (e) => {
        const el = e.target as Element | null;
        if (e.isTrusted && el?.closest?.('.ytp-size-button, .ytp-fullscreen-button')) userChose('player button');
      },
      true,
    );
    document.addEventListener(
      'dblclick',
      (e) => {
        if (e.isTrusted && (e.target as Element | null)?.closest?.('#movie_player')) userChose('double-click');
      },
      true,
    );
    document.addEventListener(
      'keydown',
      (e) => {
        const target = e.target as HTMLElement | null;
        if (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? '')) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === 't' || e.key === 'T' || e.key === 'f' || e.key === 'F') userChose(`"${e.key}" key`);
      },
      true,
    );
    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement) userChose('fullscreen');
    });
  },

  onSettings(ctx) {
    writeWideCookie(ctx.settings.viewMode);
  },

  async onPage(ctx) {
    if (!ctx.page.isWatch) {
      stopGuard();
      return;
    }
    if (guard.videoId !== ctx.page.videoId) void startGuard(ctx.settings.viewMode, ctx.page.videoId);
    // Keep the cookie right for the next full page load too.
    writeWideCookie(ctx.settings.viewMode);

    const player = await waitFor('#movie_player');
    if (player && !bigModeObserver) {
      bigModeObserver = new MutationObserver(() => {
        if (ctx.settings.noBigTheater && player.classList.contains('ytp-big-mode')) {
          player.classList.remove('ytp-big-mode');
        }
      });
      bigModeObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
    }
  },

  check(ctx) {
    const checks: Check[] = [];
    checks.push({ label: 'wide cookie', status: 'info', detail: getCookie('wide').join(', ') || '(not set)' });
    if (!ctx.page.isWatch) return checks;
    const flexy = $('ytd-watch-flexy');
    const button = $('#movie_player .ytp-size-button');
    checks.push({
      label: 'Theater / default-view button',
      status: button ? 'ok' : 'fail',
      detail: button ? undefined : '.ytp-size-button not found',
    });
    if (flexy && ctx.settings.viewMode !== 'remember') {
      const theater = isTheater(flexy);
      const want = ctx.settings.viewMode === 'theater';
      checks.push({
        label: 'View mode',
        status: theater === want || guard.userToggled ? 'ok' : 'warn',
        detail: `${theater ? 'theater' : 'normal'} (want ${ctx.settings.viewMode}${guard.userToggled ? ', you toggled it' : ''}) · last action: ${lastAction}`,
      });
    }
    // Where YouTube might be remembering the view mode besides the cookie.
    try {
      const keys = Object.keys(localStorage).filter((k) => /theat|wide|size|watch_?mode|player_?mode/i.test(k));
      checks.push({
        label: 'View-mode storage keys',
        status: 'info',
        detail: keys.length ? keys.map((k) => `${k}=${String(localStorage.getItem(k)).slice(0, 80)}`).join('; ') : 'none',
      });
    } catch {
      // localStorage blocked
    }
    const big = $('#movie_player.ytp-big-mode');
    checks.push({ label: 'Big theater controls', status: big ? 'warn' : 'ok', detail: big ? 'present' : 'absent' });
    return checks;
  },
};
