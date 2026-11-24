// Daily limit prompt: once today's watch time passes the limit, pause the
// video and ask. "Okay for today" stops it until tomorrow; "Remind me later"
// asks again in 15 min; "Stop watching" closes the tab.
import { LIMIT_ACK_KEY, LIMIT_ICONS, LIMIT_SNOOZE_KEY, LIMIT_SNOOZE_MIN, limitStatus } from '../../shared/limit';
import { DAY_PREFIX, dayKey, fmtDuration, summarize, type DayStats } from '../../shared/stats';
import { track } from '../../shared/track';
import { alive, mainVideo } from '../dom';
import type { Ctx, Module } from '../types';

const SVG = 'http://www.w3.org/2000/svg';

let ctxRef: Ctx;
let dialog: HTMLElement | null = null;
let checking = false;

function svgIcon(paths: string[]) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

function close() {
  dialog?.remove();
  dialog = null;
}

/** Show the prompt if today is over the limit and it hasn't been answered. */
async function check() {
  const s = ctxRef?.settings;
  if (!s || !alive() || dialog || checking) return;
  if (ctxRef.incognito || !s.statsEnabled || !s.dailyLimitMinutes || !s.dailyLimitPrompt) return;
  // Only the tab you're watching asks, not every YouTube tab in the background.
  const video = mainVideo();
  if (document.visibilityState !== 'visible' || !video || video.paused) return;
  checking = true;
  try {
    const key = DAY_PREFIX + dayKey();
    const got = await chrome.storage.local.get([key, LIMIT_ACK_KEY, LIMIT_SNOOZE_KEY]);
    if (got[LIMIT_ACK_KEY] === dayKey() || Date.now() < ((got[LIMIT_SNOOZE_KEY] as number | undefined) ?? 0)) return;
    const watchMs = summarize(got[key] as DayStats | undefined).watchMs;
    const status = limitStatus(watchMs, s.dailyLimitMinutes);
    if (status.level === 'over' && !dialog) show(video, watchMs, status.limitMs);
  } catch {
    // extension reloaded mid-call
  } finally {
    checking = false;
  }
}

function show(video: HTMLVideoElement, watchMs: number, limitMs: number) {
  const wasPlaying = !video.paused;
  video.pause();
  track('daily_limit_prompt', { action: 'shown' });

  const root = document.createElement('div');
  root.id = 'bt-limit-prompt';
  root.setAttribute('role', 'alertdialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'bt-limit-title');

  const card = document.createElement('div');
  card.className = 'bt-limit-card';
  const badge = document.createElement('div');
  badge.className = 'bt-limit-icon';
  badge.append(svgIcon(LIMIT_ICONS.over));
  const title = document.createElement('h2');
  title.id = 'bt-limit-title';
  title.textContent = "You're over your daily limit";
  const body = document.createElement('p');
  const over = watchMs - limitMs;
  body.textContent = `${fmtDuration(watchMs)} watched today${over >= 60_000 ? `, ${fmtDuration(over)} over` : ''} your ${fmtDuration(limitMs)} limit.`;

  const actions = document.createElement('div');
  actions.className = 'bt-limit-actions';
  const button = (label: string, cls: string, onClick: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  };
  const answer = (action: string, patch: Record<string, unknown>, resume: boolean) => {
    track('daily_limit_prompt', { action });
    close();
    if (resume && wasPlaying) void video.play().catch(() => {});
    if (alive()) void chrome.storage.local.set(patch).catch(() => {});
  };
  const snooze = () => answer('snooze', { [LIMIT_SNOOZE_KEY]: Date.now() + LIMIT_SNOOZE_MIN * 60_000 }, true);
  const okToday = button('Okay for today', 'bt-primary', () => answer('ok_today', { [LIMIT_ACK_KEY]: dayKey() }, true));
  actions.append(
    button('Stop watching', 'bt-secondary', () => {
      track('daily_limit_prompt', { action: 'stop' });
      close();
      if (alive()) void chrome.runtime.sendMessage({ type: 'close-tab' }).catch(() => {});
    }),
    button(`Remind me in ${LIMIT_SNOOZE_MIN} min`, 'bt-secondary', snooze),
    okToday,
  );
  const note = document.createElement('p');
  note.className = 'bt-limit-note';
  note.textContent = '"Okay for today" keeps this away until tomorrow. Change the limit in BetterTube → YouTube → Watch stats.';

  card.append(badge, title, body, actions, note);
  root.append(card);
  // Keys stay in the dialog (no YouTube shortcuts behind it); Esc = remind me later.
  root.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') snooze();
  });
  (document.fullscreenElement ?? document.body).append(root);
  dialog = root;
  okToday.focus();
}

export const limitPrompt: Module = {
  id: 'limitPrompt',

  css: () => `
#bt-limit-prompt {
  position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center;
  background: rgba(0,0,0,.55); animation: bt-limit-fade .18s ease-out;
}
@keyframes bt-limit-fade { from { opacity: 0; } }
#bt-limit-prompt .bt-limit-card {
  width: min(500px, calc(100vw - 32px)); box-sizing: border-box; padding: 28px 24px 20px; border-radius: 16px;
  background: var(--bt-menu); color: var(--bt-text); box-shadow: var(--bt-shadow);
  border-top: 4px solid #d03b3b; text-align: center; font: 400 14px/1.45 Roboto, Arial, sans-serif;
}
#bt-limit-prompt .bt-limit-icon {
  width: 56px; height: 56px; margin: 0 auto 14px; border-radius: 50%; display: grid; place-items: center;
  background: rgba(208,59,59,.14); color: #d03b3b;
}
#bt-limit-prompt .bt-limit-icon svg { width: 28px; height: 28px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
#bt-limit-prompt h2 { margin: 0 0 6px; font: 600 20px/1.3 Roboto, Arial, sans-serif; }
#bt-limit-prompt p { margin: 0; color: var(--bt-text-2); }
#bt-limit-prompt .bt-limit-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin: 20px 0 14px; }
#bt-limit-prompt button {
  all: unset; box-sizing: border-box; cursor: pointer; padding: 9px 16px; border-radius: 18px;
  font: 500 14px/1.2 Roboto, Arial, sans-serif; white-space: nowrap;
}
#bt-limit-prompt button:focus-visible { outline: 2px solid var(--bt-link); outline-offset: 2px; }
#bt-limit-prompt .bt-secondary { background: var(--bt-chip); color: var(--bt-text); }
#bt-limit-prompt .bt-secondary:hover { background: var(--bt-chip-hover); }
#bt-limit-prompt .bt-primary { background: var(--bt-text); color: var(--bt-menu); }
#bt-limit-prompt .bt-primary:hover { opacity: .88; }
#bt-limit-prompt .bt-limit-note { font-size: 12px; }
`,

  init(ctx) {
    ctxRef = ctx;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      // Answered in another tab: close here too.
      if (changes[LIMIT_ACK_KEY] || changes[LIMIT_SNOOZE_KEY]) close();
      else if (changes[DAY_PREFIX + dayKey()]) void check();
    });
    document.addEventListener('playing', () => void check(), true);
    // Snoozes run out without anything changing in storage.
    setInterval(() => void check(), 60_000);
  },

  onSettings() {
    if (!ctxRef.settings.dailyLimitPrompt || !ctxRef.settings.dailyLimitMinutes) close();
    else void check();
  },
};
