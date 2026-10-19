// Tracks watch time, videos, sessions and playback health, and shows today's
// numbers in a badge in YouTube's top bar (click it for the full dashboard).
import { onIsolatedMessage, type PlayerStats } from '../../shared/bridge';
import { DAY_PREFIX, dayKey, fmtDuration, summarize, type DayStats, type Tick } from '../../shared/stats';
import { $, alive, mainVideo, waitFor } from '../dom';
import type { Ctx, Module } from '../types';

const TICK_MS = 5000;
const IDLE_AFTER_MS = 2 * 60_000;

let ctxRef: Ctx;
let lastTickAt = Date.now();
let lastInputAt = Date.now();
let lastVideoId: string | null = null;
let lastPos = 0;
let lastDropped = 0;
let lastFrames = 0;
let stalls = 0;
let stallMs = 0;
let stallStart = 0;
/** A seek (X, Z, clicking the bar, chapters) happened since the last tick. */
let seekedSinceTick = false;
/**
 * Fastest speed since the last sample. Speed changes mid-sample (gradual
 * speed-up steps, R back to 1×) mean the speed at sample time may be lower
 * than what actually played; checking against it would reject real playback.
 */
let maxRateSinceTick = 0;
let searches = 0;
let playerStats: PlayerStats | null = null;

const isAd = () => !!$('#movie_player.ad-showing');

let soonTimer: ReturnType<typeof setTimeout> | undefined;
/** Record right away (not at the next 5 s tick) when playback starts. */
function tickSoon() {
  clearTimeout(soonTimer);
  soonTimer = setTimeout(tick, 600);
}

function onMediaEvent(e: Event) {
  const video = e.target;
  if (!(video instanceof HTMLVideoElement) || video !== mainVideo()) return;
  if (e.type === 'playing') tickSoon();
  if (e.type === 'seeking') seekedSinceTick = true;
  if (e.type === 'ratechange') {
    // Not a playback-state change: don't let it end a buffering stall below.
    maxRateSinceTick = Math.max(maxRateSinceTick, video.playbackRate);
    return;
  }
  if (e.type === 'waiting') {
    // Buffering mid-playback (not a seek, not the initial load).
    if (!video.seeking && video.currentTime > 0.5 && !stallStart) {
      stalls++;
      stallStart = Date.now();
    }
  } else if (stallStart) {
    stallMs += Date.now() - stallStart;
    stallStart = 0;
  }
}

function tick() {
  if (!ctxRef.settings.statsEnabled || !alive() || ctxRef.incognito) return; // incognito: not recorded
  const now = Date.now();
  const video = ctxRef.page.isWatch ? mainVideo() : null;
  const adPlaying = !!video && !video.paused && isAd();
  const playing = !!video && !video.paused && !video.ended && video.readyState > 2 && !adPlaying;
  const visible = document.visibilityState === 'visible';
  const active = visible && (now - lastInputAt < IDLE_AFTER_MS || playing);
  let dt = now - lastTickAt;
  lastTickAt = now;
  // Hidden tabs get throttled timers, so allow long gaps while playing; anything
  // longer is a sleep/suspend and must not be counted.
  if (dt > (playing ? 65_000 : 15_000)) dt = TICK_MS;

  let tickVideo: Tick['video'] = null;
  let dropped = 0;
  let frames = 0;
  const info = ctxRef.video;
  if (video && info && info.videoId === ctxRef.page.videoId && !adPlaying) {
    const pos = video.currentTime;
    const sameVideo = lastVideoId === info.videoId;
    let delta = sameVideo ? pos - lastPos : 0;
    // Only continuous playback counts as video covered: drop any interval that
    // contains a seek (a +10 s jump inside a throttled 1-minute background tick
    // used to count as "watched"), and anything faster than the speed allows.
    const fastest = Math.max(maxRateSinceTick, video.playbackRate);
    if (seekedSinceTick || delta < 0 || delta > (dt / 1000) * fastest * 1.1 + 1) delta = 0;
    seekedSinceTick = false;
    maxRateSinceTick = video.playbackRate;
    const quality = video.getVideoPlaybackQuality();
    if (sameVideo) {
      dropped = Math.max(0, quality.droppedVideoFrames - lastDropped);
      frames = Math.max(0, quality.totalVideoFrames - lastFrames);
    }
    lastDropped = quality.droppedVideoFrames;
    lastFrames = quality.totalVideoFrames;
    lastPos = pos;
    lastVideoId = info.videoId;
    tickVideo = {
      id: info.videoId,
      title: info.title,
      author: info.author,
      channelId: info.channelId,
      durationSec: info.lengthSeconds || (Number.isFinite(video.duration) ? video.duration : 0),
      posSec: pos,
      contentDeltaSec: playing ? delta : 0,
    };
  }

  if (!active && !playing && !adPlaying && !stalls && !searches) return;
  if (stallStart) {
    stallMs += now - stallStart;
    stallStart = now;
  }
  const msg: Tick = {
    type: 'stats:tick',
    at: now,
    dt,
    active,
    playing,
    adPlaying,
    video: tickVideo,
    stalls,
    stallMs,
    droppedFrames: dropped,
    totalFrames: frames,
    resolution: playing && video?.videoHeight ? `${video.videoHeight}p` : null,
    codec: playing ? (playerStats?.codec ?? null) : null,
    bandwidthKbps: playing ? (playerStats?.bandwidthKbps ?? null) : null,
    searches,
  };
  stalls = 0;
  stallMs = 0;
  searches = 0;
  playerStats = null;
  try {
    void chrome.runtime.sendMessage(msg).catch(() => {});
  } catch {
    // Extension was reloaded; this content script is orphaned until the tab reloads.
  }
}

// ---------- top-bar badge ----------

const SVG = 'http://www.w3.org/2000/svg';

function icon(paths: string[], { fill = false } = {}) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', fill ? 'currentColor' : 'none');
    p.setAttribute('stroke', fill ? 'none' : 'currentColor');
    p.setAttribute('stroke-width', '2');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.append(p);
  }
  return svg;
}

const PLAY_ICON = ['M8 5.5v13l10.5-6.5z'];
const CLOCK_ICON = ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'];

let badge: HTMLElement | null = null;
const badgeParts: Record<string, HTMLElement> = {};

function buildBadge() {
  const root = document.createElement('div');
  root.id = 'bt-stats-badge';
  root.setAttribute('role', 'button');
  root.tabIndex = 0;
  root.setAttribute('aria-label', "Today's YouTube stats. Open dashboard");

  const videos = document.createElement('span');
  videos.className = 'bt-stat';
  badgeParts.videos = document.createElement('b');
  videos.append(icon(PLAY_ICON, { fill: true }), badgeParts.videos);

  const time = document.createElement('span');
  time.className = 'bt-stat';
  badgeParts.time = document.createElement('b');
  time.append(icon(CLOCK_ICON), badgeParts.time);

  const card = document.createElement('div');
  card.className = 'bt-stats-card';
  badgeParts.card = card;

  root.append(videos, time, card);
  const open = () => {
    if (alive()) void chrome.runtime.sendMessage({ type: 'open-dashboard' }).catch(() => {});
  };
  root.addEventListener('click', open);
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') open();
  });
  return root;
}

function cardRow(label: string, value: string) {
  const row = document.createElement('div');
  row.className = 'bt-card-row';
  const l = document.createElement('span');
  l.textContent = label;
  const v = document.createElement('b');
  v.textContent = value;
  row.append(l, v);
  return row;
}

async function renderBadge() {
  if (!badge || !alive()) return;
  if (ctxRef.incognito) {
    badgeParts.videos.textContent = 'Incognito';
    badgeParts.time.textContent = 'not recorded';
    badge.dataset.level = 'none';
    const title = document.createElement('div');
    title.className = 'bt-card-title';
    title.textContent = 'Incognito: nothing is recorded';
    const body = document.createElement('div');
    body.className = 'bt-card-hint';
    body.textContent = 'No watch stats are saved here. Site speeds last until you close your incognito tabs.';
    badgeParts.card.replaceChildren(title, body);
    return;
  }
  const key = DAY_PREFIX + dayKey();
  let day: DayStats | undefined;
  try {
    day = (await chrome.storage.local.get(key))[key] as DayStats | undefined;
  } catch {
    return; // extension reloaded mid-call
  }
  const s = summarize(day);
  const limitMs = ctxRef.settings.dailyLimitMinutes * 60_000;
  badgeParts.videos.textContent = String(s.videos);
  badgeParts.time.textContent = fmtDuration(s.watchMs);
  const ratio = limitMs ? s.watchMs / limitMs : 0;
  badge.dataset.level = !limitMs ? 'none' : ratio >= 1 ? 'over' : ratio >= 0.8 ? 'near' : 'ok';
  badge.style.setProperty('--bt-limit', `${Math.min(1, ratio) * 100}%`);
  badge.title = '';

  const title = document.createElement('div');
  title.className = 'bt-card-title';
  title.textContent = 'Today on YouTube';
  const rows = [
    cardRow('Videos watched', String(s.videos)),
    cardRow('Watch time', fmtDuration(s.watchMs)),
    cardRow('Time on YouTube', fmtDuration(s.activeMs)),
    cardRow('Saved by speed', fmtDuration(s.savedMs)),
    cardRow('Ads', fmtDuration(s.adMs)),
  ];
  if (limitMs) rows.push(cardRow('Daily limit', `${Math.round(ratio * 100)}% of ${fmtDuration(limitMs)}`));
  const hint = document.createElement('div');
  hint.className = 'bt-card-hint';
  hint.textContent = 'Click for the full dashboard';
  badgeParts.card.replaceChildren(title, ...rows, hint);
}

async function ensureBadge() {
  if (!ctxRef.settings.statsEnabled || !ctxRef.settings.statsBadge) {
    badge?.remove();
    return;
  }
  const end = await waitFor('ytd-masthead #end');
  if (!end) return;
  badge ??= buildBadge();
  if (!badge.isConnected) end.prepend(badge);
  void renderBadge();
}

export const stats: Module = {
  id: 'stats',

  css: () => `
#bt-stats-badge {
  position: relative; display: flex; align-items: center; gap: 10px; height: 36px;
  margin-right: 8px; padding: 0 12px; border-radius: 18px; cursor: pointer;
  background: var(--bt-chip);
  color: var(--bt-text);
  font: 500 1.4rem/1 Roboto, Arial, sans-serif; font-variant-numeric: tabular-nums;
  white-space: nowrap; user-select: none;
}
#bt-stats-badge:hover { background: var(--bt-chip-hover); }
#bt-stats-badge:focus-visible { outline: 2px solid var(--bt-link); }
#bt-stats-badge .bt-stat { display: inline-flex; align-items: center; gap: 5px; }
#bt-stats-badge .bt-stat svg { color: var(--bt-text-2); flex: none; }
#bt-stats-badge b { font-weight: 500; }
/* Daily-limit progress: an underline that fills up. */
#bt-stats-badge:not([data-level="none"])::after {
  content: ""; position: absolute; left: 12px; right: 12px; bottom: 4px; height: 2px; border-radius: 1px;
  background: linear-gradient(to right, var(--bt-limit-color) var(--bt-limit), rgba(127,127,127,.3) var(--bt-limit));
}
#bt-stats-badge[data-level="ok"] { --bt-limit-color: #0ca30c; }
#bt-stats-badge[data-level="near"] { --bt-limit-color: #fab219; }
#bt-stats-badge[data-level="over"] { --bt-limit-color: #d03b3b; }
#bt-stats-badge[data-level="over"] .bt-stat:last-of-type svg { color: #d03b3b; }
#bt-stats-badge .bt-stats-card {
  position: absolute; top: calc(100% + 8px); right: 0; z-index: 3000; min-width: 230px;
  padding: 12px 14px; border-radius: 12px; cursor: default;
  background: var(--bt-menu); color: var(--bt-text);
  box-shadow: var(--bt-shadow); font: 400 1.3rem/1.4 Roboto, Arial, sans-serif;
  opacity: 0; visibility: hidden; transform: translateY(-4px); transition: opacity .12s, transform .12s, visibility .12s;
}
#bt-stats-badge:hover .bt-stats-card, #bt-stats-badge:focus-within .bt-stats-card {
  opacity: 1; visibility: visible; transform: none;
}
.bt-stats-card .bt-card-title { font-weight: 600; font-size: 1.4rem; margin-bottom: 8px; }
.bt-stats-card .bt-card-row { display: flex; justify-content: space-between; gap: 16px; padding: 3px 0; }
.bt-stats-card .bt-card-row span { color: var(--bt-text-2); }
.bt-stats-card .bt-card-hint { margin-top: 8px; color: var(--bt-text-2); font-size: 1.2rem; }
`,

  init(ctx) {
    ctxRef = ctx;
    const markInput = () => (lastInputAt = Date.now());
    for (const type of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'scroll']) {
      window.addEventListener(type, markInput, { passive: true, capture: true });
    }
    for (const type of ['waiting', 'playing', 'pause', 'seeking', 'emptied', 'ratechange']) {
      document.addEventListener(type, onMediaEvent, true);
    }
    onIsolatedMessage((msg) => {
      if (msg.type === 'player-stats') playerStats = msg.stats;
      if (msg.type === 'video') tickSoon();
    });
    setInterval(tick, TICK_MS);
    // Send the last partial interval when the tab goes away.
    window.addEventListener('pagehide', tick);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[DAY_PREFIX + dayKey()]) void renderBadge();
    });
    // Day rollover.
    setInterval(() => void renderBadge(), 60_000);
    void ensureBadge();
  },

  onPage(ctx) {
    if (ctx.page.path === '/results') searches++;
    void ensureBadge();
  },

  onSettings() {
    void ensureBadge();
  },

  check(ctx) {
    return [
      {
        label: 'Watch stats',
        status: ctx.settings.statsEnabled ? 'ok' : 'info',
        detail: ctx.settings.statsEnabled
          ? `tracking · top-bar badge ${badge?.isConnected ? 'shown' : 'not shown'}`
          : 'disabled',
      },
    ];
  },
};
