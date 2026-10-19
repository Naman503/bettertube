// Speed controller for every site: an on-video overlay plus keyboard shortcuts,
// modelled on Video Speed Controller but built to cost almost nothing:
//  - no MutationObservers: media are found through their own events
//    (play / loadedmetadata / ratechange), captured once at the document;
//  - an overlay is created only for a video that actually loads and is big
//    enough to matter, and all overlays share one constructed stylesheet;
//  - no work per key press beyond a Map lookup;
//  - the last speed is saved to local storage, debounced.
import {
  ACTIONS,
  LAST_SPEED_KEY,
  SITE_SPEEDS_KEY,
  siteKey,
  MAX_RATE,
  MIN_RATE,
  SPEED_KEY,
  isBlacklisted,
  fmtInterval,
  fmtRate,
  fmtRateDisplay,
  inQuietZone,
  keyLabel,
  rampEffectOf,
  RAMP_PAUSED_KEY,
  RAMP_PAUSED_UNTIL_KEY,
  rampMinutesToMax,
  withSpeedDefaults,
  type RampEffect,
  type Shortcut,
  type SpeedAction,
  type SpeedSettings,
} from '../shared/speedSettings';
import { INCOGNITO_PREFIX, isIncognito } from '../shared/privacy';

let settings: SpeedSettings = withSpeedDefaults(undefined);
let shortcuts = new Map<string, Shortcut>();
/** Your last speed anywhere: what a site you haven't set a speed on starts at. */
let lastSpeed = 1;
/** Last speed per site, e.g. { "youtube.com": 3.1, "udemy.com": 1.75 }. */
let siteSpeeds: Record<string, number> = {};

// Incognito: our own speeds and pause states live in session memory under
// "incognito:" keys (wiped when the last incognito tab closes); your normal
// saved speeds are read as a starting point but never written.
let INCOGNITO = false;
let normalSiteSpeeds: Record<string, number> = {};
const privateArea = () => (INCOGNITO ? chrome.storage.session : chrome.storage.local);
const privateAreaName = () => (INCOGNITO ? 'session' : 'local');
const pk = (key: string) => (INCOGNITO ? INCOGNITO_PREFIX + key : key);

/**
 * The site a video "belongs to" is the page you're on: a YouTube embed inside
 * a blog follows the blog's speed. Frames learn the top page from
 * location.ancestorOrigins (its last entry is the top-level origin).
 */
function pageSite() {
  try {
    const origins = location.ancestorOrigins;
    if (window !== window.top && origins?.length) return siteKey(new URL(origins[origins.length - 1]).hostname);
  } catch {
    // fall back to this frame's host
  }
  return siteKey(location.hostname || 'file');
}
const site = pageSite();

/** The speed new videos here should start at. */
function targetSpeed() {
  if (!settings.perSiteSpeed) return lastSpeed;
  return siteSpeeds[site] ?? (INCOGNITO ? normalSiteSpeeds[site] : undefined) ?? lastSpeed;
}
let active = false; // enabled and not blacklisted
let ready = false;
/** All overlays hidden ("V"). */
let hiddenAll = false;

// Speeds keep 3 decimals: gradual speed-up steps can be as fine as 0.001×.
// (At 2 decimals a +0.005× ramp got stuck: 3.01 + 0.005 = 3.01499…, which
// rounds back down to 3.01 on every step.)
const round = (r: number) => Math.round(r * 1000) / 1000;
const clamp = (r: number) => Math.min(MAX_RATE, Math.max(MIN_RATE, r));
const fmt = fmtRate;

// ---------- media tracking ----------

interface MediaState {
  /**
   * The last rate we set. A ratechange to this value is ours, not the site's:
   * kept (not cleared on first match) because media loads can deliver the
   * event twice, and setting an equal rate never fires one.
   */
  ownRate: number | null;
  /** When the media (re)started loading; site resets happen right after. */
  loadedAt: number;
  /** For reset / preferred toggles: the speed to go back to. */
  previous: number;
  mark: number | null;
  controller: Controller | null;
}

const states = new WeakMap<HTMLMediaElement, MediaState>();
/** Media seen in this frame, most recently active last. Pruned lazily. */
let recent: HTMLMediaElement[] = [];
const RESET_WINDOW_MS = 1500;

function stateOf(m: HTMLMediaElement): MediaState {
  let s = states.get(m);
  if (!s) {
    s = { ownRate: null, loadedAt: Date.now(), previous: 1, mark: null, controller: null };
    states.set(m, s);
  }
  return s;
}

function touch(m: HTMLMediaElement) {
  recent = recent.filter((x) => x !== m && x.isConnected);
  recent.push(m);
  if (recent.length > 20) recent.shift();
}

const eligible = (m: HTMLMediaElement) => m instanceof HTMLVideoElement || settings.workOnAudio;

/**
 * How likely this is the media you mean: playing beats paused, audible beats
 * muted (muted hover previews and background videos lose), bigger on-screen
 * beats smaller, and more recent breaks ties.
 */
function prominence(m: HTMLMediaElement, recency: number) {
  let score = recency;
  if (!m.paused && !m.ended) score += 1000;
  if (!m.muted && m.volume > 0) score += 500;
  if (m instanceof HTMLVideoElement) {
    const r = m.getBoundingClientRect();
    const visible = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    score += Math.min(300, visible / 2000);
  } else {
    score += 150; // audio has no box; treat it like a medium-size player
  }
  return score;
}

/** The media a shortcut should act on in this frame (see prominence), or null. */
function targetMedia(): HTMLMediaElement | null {
  recent = recent.filter((m) => m.isConnected && eligible(m));
  // Nothing playing that we know of: look for media we can't see through
  // events (e.g. inside shadow DOM) before settling for a paused one.
  if (!recent.some((m) => !m.paused)) deepFindMedia(document).forEach(adopt);
  let best: HTMLMediaElement | null = null;
  let bestScore = -1;
  recent.forEach((m, i) => {
    const score = prominence(m, i);
    if (score > bestScore) {
      best = m;
      bestScore = score;
    }
  });
  return best;
}

function deepFindMedia(root: Document | ShadowRoot): HTMLMediaElement[] {
  const out: HTMLMediaElement[] = [...root.querySelectorAll<HTMLMediaElement>('video, audio')].filter(eligible);
  for (const el of root.querySelectorAll('*')) if (el.shadowRoot) out.push(...deepFindMedia(el.shadowRoot));
  return out;
}

function setRate(m: HTMLMediaElement, rate: number) {
  rate = round(clamp(rate));
  if (m.playbackRate === rate) return;
  stateOf(m).ownRate = rate;
  m.playbackRate = rate;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function rememberSpeed(rate: number) {
  lastSpeed = rate;
  if (settings.perSiteSpeed) siteSpeeds = { ...siteSpeeds, [site]: rate };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const patch: Record<string, unknown> = { [pk(LAST_SPEED_KEY)]: rate };
      if (settings.perSiteSpeed) {
        // Merge with what other tabs saved for other sites meanwhile.
        const stored = ((await privateArea().get(pk(SITE_SPEEDS_KEY)))[pk(SITE_SPEEDS_KEY)] ?? {}) as Record<string, number>;
        patch[pk(SITE_SPEEDS_KEY)] = { ...stored, [site]: rate };
      }
      await privateArea().set(patch);
    } catch {
      // extension reloaded
    }
  }, 400);
}

/** A speed you chose (keys, overlay, or the site's own menu). */
function userSetRate(m: HTMLMediaElement, rate: number) {
  setRate(m, rate);
  rememberSpeed(round(clamp(rate)));
  onManualChange(m);
}

// ---------- gradual speed-up ----------
// One 1-second timer, running only while something plays with the ramp on.
// Playback time is measured from the media's own clock, so throttled
// background tabs neither over- nor under-count much.

let rampTimer: ReturnType<typeof setInterval> | undefined;
let rampAcc = 0; // seconds of playback since the last step
let rampPausedUntil = 0;
/** "Pause for N min": until this time (shared by all tabs, survives videos). */
let rampTimedUntil = 0;
let rampNote = '';
const rampHeld = new WeakSet<HTMLMediaElement>();
const rampLastPos = new WeakMap<HTMLMediaElement, number>();

const isAd = (m: HTMLMediaElement) => !!m.closest('.ad-showing');
const tooShort = (m: HTMLMediaElement) =>
  settings.rampMinVideoMin > 0 && Number.isFinite(m.duration) && m.duration > 0 && m.duration < settings.rampMinVideoMin * 60;

/** Paused by a shortcut (R by default) until a resume shortcut; shared by all tabs. */
let rampPaused = false;

function setRampPaused(paused: boolean) {
  if (rampPaused === paused) return;
  rampPaused = paused;
  rampAcc = 0;
  try {
    void privateArea().set({ [pk(RAMP_PAUSED_KEY)]: paused });
  } catch {
    // extension reloaded
  }
  for (const x of recent) stateOf(x).controller?.update();
}

/** Keys that resume the climb, for the panel: "G, H, D". */
const resumeKeys = () =>
  settings.shortcuts
    .filter((x) => x.code && rampEffectOf(x) === 'resume')
    .map((x) => keyLabel(x.code))
    .join(', ');

/** A shortcut's side effect on gradual speed-up. Returns a label to flash, if the state changed. */
function applyRampEffect(effect: RampEffect, m: HTMLMediaElement): string | null {
  if (!settings.ramp || effect === 'none') return null;
  if (effect === 'pause') {
    if (rampPaused) return null;
    setRampPaused(true);
    return 'Speed-up paused';
  }
  const wasStopped = rampPaused || rampHeld.has(m) || Date.now() < rampTimedUntil;
  setRampPaused(false);
  rampHeld.delete(m);
  rampPausedUntil = 0;
  if (rampTimedUntil) setTimedPause(0);
  startRamp();
  return wasStopped ? 'Speed-up on' : null;
}

function setTimedPause(until: number) {
  rampTimedUntil = until;
  rampAcc = 0;
  try {
    void privateArea().set({ [pk(RAMP_PAUSED_UNTIL_KEY)]: until });
  } catch {
    // extension reloaded
  }
  for (const x of recent) stateOf(x).controller?.update();
}

/** Stop gradual speed-up for this video only (toggle). Returns a label to show. */
function toggleHoldVideo(m: HTMLMediaElement): string {
  if (rampHeld.has(m)) {
    rampHeld.delete(m);
    rampAcc = 0;
    startRamp();
    return 'Speed-up resumed';
  }
  rampHeld.add(m);
  return 'Speed-up stopped for this video';
}

/** Pause gradual speed-up everywhere for `minutes`. Returns a label to show. */
function pauseFor(minutes: number): string {
  const mins = minutes > 0 ? minutes : 10;
  setTimedPause(Date.now() + mins * 60_000);
  return `Speed-up paused for ${fmtInterval(mins * 60)}`;
}

const minutesLeft = () => Math.max(1, Math.ceil((rampTimedUntil - Date.now()) / 60_000));

function onManualChange(m: HTMLMediaElement) {
  rampAcc = 0;
  rampPausedUntil = 0; // you took over: a rewind pause no longer applies
  if (settings.ramp && settings.rampOnManual === 'hold') rampHeld.add(m);
}

/** Why the ramp is or isn't climbing on this media, for the panel. */
function rampStatus(m: HTMLMediaElement): string {
  if (!settings.ramp) return 'Off';
  if (rampPaused) {
    const keys = resumeKeys();
    return `Paused${keys ? `: press ${keys} to resume` : ''}`;
  }
  if (Date.now() < rampTimedUntil) return `Paused for ${minutesLeft()} more min`;
  if (rampHeld.has(m)) {
    const key = settings.shortcuts.find((x) => x.action === 'rampHoldVideo' && x.code);
    return `Stopped for this video${key ? `: press ${keyLabel(key.code)} to resume` : ''}`;
  }
  if (inQuietZone(m.playbackRate, settings)) {
    return `Waiting: no speed-up between ${fmt(settings.rampQuietFrom)}× and ${fmt(settings.rampQuietTo)}×`;
  }
  if (tooShort(m)) return `Off for videos under ${settings.rampMinVideoMin} min`;
  if (Date.now() < rampPausedUntil) return rampNote || 'Paused for a minute';
  const rate = m.playbackRate;
  if (rate >= settings.rampMax) return `At your max (${fmt(settings.rampMax)}×)`;
  const mins = rampMinutesToMax(rate, settings);
  return `+${settings.rampStep}× every ${fmtInterval(settings.rampEverySec)} → ${fmt(settings.rampMax)}× in ~${mins < 1 ? '<1' : Math.round(mins)} min of watching`;
}

function rampTick() {
  if (!active || !settings.ramp) return stopRamp();
  const m = recent.filter((x) => x.isConnected && !x.paused && !x.ended && eligible(x)).pop();
  if (!m) return stopRamp(); // restarts on the next 'play'
  const pos = m.currentTime;
  const last = rampLastPos.get(m);
  rampLastPos.set(m, pos);
  if (last === undefined || isAd(m)) return;
  const delta = pos - last;

  // Jumped back a few seconds or more: it was probably too fast.
  if (settings.rampEaseOnRewind && delta < -4 && delta > -180 && !rampHeld.has(m)) {
    const eased = round(Math.max(Math.min(1, m.playbackRate), m.playbackRate - 0.05));
    setRate(m, eased);
    if (settings.rampCarryOver) rememberSpeed(eased);
    rampPausedUntil = Date.now() + 60_000;
    rampNote = `Eased to ${fmt(eased)}× after you rewound; climbing again in a minute`;
    rampAcc = 0;
    stateOf(m).controller?.update();
    return;
  }
  if (rampPaused || rampHeld.has(m) || tooShort(m) || Date.now() < rampPausedUntil || Date.now() < rampTimedUntil) return;
  // Quiet zone (e.g. music between 1× and 2×): wait, and start fresh once you leave it.
  if (inQuietZone(m.playbackRate, settings)) {
    rampAcc = 0;
    return;
  }

  // Real seconds of playback since the last tick (bounded: seeks forward aren't watching).
  const watched = delta > 0 ? Math.min(delta / m.playbackRate, 70) : 0;
  rampAcc += watched;
  // Small tolerance: ticks are ~1 s apart, so 1.99 s of playback counts as 2.
  if (rampAcc < settings.rampEverySec - 0.05) return;
  // Keep the leftover so the average interval is exactly what you set.
  rampAcc = Math.max(0, Math.min(rampAcc - settings.rampEverySec, settings.rampEverySec));
  if (m.playbackRate >= settings.rampMax) return;
  let next = round(Math.min(settings.rampMax, m.playbackRate + settings.rampStep));
  // Never let a rounding edge swallow a step (that is how it once stuck at 3.01).
  if (next <= m.playbackRate) next = Math.min(settings.rampMax, m.playbackRate + settings.rampStep);
  if (next <= m.playbackRate) return;
  setRate(m, next);
  // Carry over: the next video starts where this one got to.
  if (settings.rampCarryOver) rememberSpeed(next);
  stateOf(m).controller?.update();
}

function startRamp() {
  if (!rampTimer && settings.ramp && active) rampTimer = setInterval(rampTick, 1000);
}

function stopRamp() {
  clearInterval(rampTimer);
  rampTimer = undefined;
}

async function saveSpeedSettings(patch: Partial<SpeedSettings>) {
  try {
    const stored = (await chrome.storage.sync.get(SPEED_KEY))[SPEED_KEY] ?? {};
    await chrome.storage.sync.set({ [SPEED_KEY]: { ...withSpeedDefaults(stored), ...patch } });
  } catch {
    // extension reloaded
  }
}

function adopt(m: HTMLMediaElement) {
  if (!eligible(m)) return;
  touch(m);
  announceHasMedia();
  const s = stateOf(m);
  if (settings.rememberSpeed && m.playbackRate !== targetSpeed()) setRate(m, targetSpeed());
  if (!s.controller && m instanceof HTMLVideoElement && wantsOverlay(m)) s.controller = new Controller(m);
  s.controller?.update();
}

function wantsOverlay(v: HTMLVideoElement) {
  const r = v.getBoundingClientRect();
  if (r.width < 160 || r.height < 90) return false;
  // YouTube's hover previews on thumbnails.
  return !v.closest('ytd-video-preview, #video-preview, #inline-preview-player');
}

function onMediaEvent(e: Event) {
  if (!active) return;
  const m = e.composedPath()[0];
  if (!(m instanceof HTMLMediaElement) || !eligible(m)) return;
  const s = stateOf(m);
  switch (e.type) {
    case 'loadstart':
      s.loadedAt = Date.now();
      rampLastPos.delete(m);
      rampHeld.delete(m); // "hold" lasts for one video
      rampAcc = 0;
      break;
    case 'loadedmetadata':
    case 'play':
      if (e.type === 'play' && m.currentTime < 1) s.loadedAt = Date.now();
      adopt(m);
      if (e.type === 'play') startRamp();
      break;
    case 'ratechange': {
      const rate = m.playbackRate;
      if (s.ownRate !== null && rate === s.ownRate) {
        // ours (keys, overlay, ramp): no flash, the overlay already shows it
      } else if (m.readyState > 0) {
        const siteReset = Date.now() - s.loadedAt < RESET_WINDOW_MS;
        if (settings.rememberSpeed && (settings.forceSpeed || siteReset) && rate !== targetSpeed()) {
          setRate(m, targetSpeed()); // the site put its own speed back; keep yours
        } else {
          rememberSpeed(rate); // you changed it in the site's own menu
          s.ownRate = rate; // the known current rate from now on
          onManualChange(m);
        }
        s.controller?.blink();
      }
      s.controller?.update();
      break;
    }
  }
}

// ---------- actions ----------

function run(action: SpeedAction, m: HTMLMediaElement, value: number) {
  const s = stateOf(m);
  const rate = m.playbackRate;
  const change = (next: number) => userSetRate(m, next);
  switch (action) {
    case 'faster':
      change(rate + value);
      break;
    case 'slower':
      change(rate - value);
      break;
    case 'rewind':
      m.currentTime = Math.max(0, m.currentTime - value);
      break;
    case 'advance':
      m.currentTime = Math.min(m.duration || Infinity, m.currentTime + value);
      break;
    case 'reset':
    case 'preferred': {
      const target = action === 'reset' ? 1 : value;
      if (rate === target) change(s.previous !== target ? s.previous : action === 'reset' ? lastPreferred() : 1);
      else {
        s.previous = rate;
        change(target);
      }
      break;
    }
    case 'pause':
      if (m.paused) void m.play();
      else m.pause();
      break;
    case 'mute':
      m.muted = !m.muted;
      break;
    case 'mark':
      s.mark = m.currentTime;
      break;
    case 'jump':
      if (s.mark !== null) m.currentTime = s.mark;
      break;
    case 'display':
      hiddenAll = !hiddenAll;
      for (const x of recent) stateOf(x).controller?.update();
      return;
    case 'ramp': {
      const on = !settings.ramp;
      settings = { ...settings, ramp: on };
      rampHeld.delete(m);
      rampAcc = 0;
      rampPausedUntil = 0;
      setRampPaused(false);
      void saveSpeedSettings({ ramp: on });
      if (on) startRamp();
      if (rampTimedUntil) setTimedPause(0);
      s.controller?.flashLabel(on ? 'Speed-up on' : 'Speed-up off');
      return;
    }
    case 'rampHoldVideo':
    case 'rampPauseFor': {
      const label = action === 'rampHoldVideo' ? toggleHoldVideo(m) : pauseFor(value);
      if (s.controller) s.controller.flashLabel(label);
      else cornerBadge(label);
      return;
    }
  }
  touch(m);
  s.controller?.update();
  s.controller?.blink();
}

function lastPreferred() {
  return settings.shortcuts.find((x) => x.action === 'preferred')?.value ?? 1.5;
}

function isTyping(e: KeyboardEvent) {
  const t = e.composedPath()[0] as HTMLElement | undefined;
  if (!t || !(t instanceof HTMLElement)) return false;
  return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
}

function onKey(e: KeyboardEvent) {
  if (!active || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || isTyping(e)) return;
  const sc = shortcuts.get(e.code);
  if (!sc) return;
  // Another speed extension is handling keys on this page; don't double up.
  if (vscPresent()) return;
  const m = targetMedia();
  if (!m) {
    // The media may be in another frame of this tab (an embedded player while
    // the key went to the page, or the other way round): hand the key over.
    if (mediaInOtherFrames) {
      e.preventDefault();
      e.stopImmediatePropagation();
      try {
        void chrome.runtime.sendMessage({ type: 'speed:relay', code: e.code }).catch(() => {});
      } catch {
        // extension reloaded
      }
    }
    return; // no media anywhere: leave the key to the page
  }
  e.preventDefault();
  e.stopImmediatePropagation();
  runShortcut(sc, m);
}

/** Run a shortcut's action and its gradual speed-up effect on `m`. */
function runShortcut(sc: Shortcut, m: HTMLMediaElement) {
  run(sc.action, m, sc.value);
  let label: string | null = null;
  if (sc.action !== 'ramp') {
    label = applyRampEffect(rampEffectOf(sc), m);
    if (label) stateOf(m).controller?.flashLabel(label);
  }
  // Audio (and tiny videos) have no overlay: show the result in a corner badge.
  if (!stateOf(m).controller && !['display', 'rampHoldVideo', 'rampPauseFor'].includes(sc.action)) {
    const what = sc.action === 'ramp' ? (settings.ramp ? 'Speed-up on' : 'Speed-up off') : `${fmtRateDisplay(m.playbackRate, settings.speedDecimals)}×`;
    cornerBadge(label ? `${what} · ${label}` : what);
  }
}

// ---------- corner badge (feedback for audio) ----------

let badgeHost: HTMLElement | null = null;
let badgeTimer: ReturnType<typeof setTimeout> | undefined;
function cornerBadge(text: string) {
  if (!badgeHost) {
    badgeHost = document.createElement('div');
    badgeHost.className = 'bt-speed-badge';
    const root = badgeHost.attachShadow({ mode: 'open' });
    const style = new CSSStyleSheet();
    style.replaceSync(`:host { all: initial; position: fixed; top: 16px; right: 16px; z-index: 2147483000; pointer-events: none; }
      div { padding: 7px 12px; border-radius: 9px; background: rgba(16,16,16,.86); color: #fff;
        font: 600 14px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; font-variant-numeric: tabular-nums;
        box-shadow: 0 2px 10px rgba(0,0,0,.35); opacity: 0; transition: opacity .15s; }
      div.on { opacity: 1; }`);
    root.adoptedStyleSheets = [style];
    root.append(document.createElement('div'));
  }
  if (!badgeHost.isConnected) (document.body ?? document.documentElement).append(badgeHost);
  const box = badgeHost.shadowRoot!.firstElementChild as HTMLElement;
  box.textContent = text;
  box.classList.add('on');
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => box.classList.remove('on'), 1200);
}

// ---------- frames: hand keys to the frame that has the media ----------
// The background keeps, per tab, which frames have media. A frame that gets a
// shortcut but has no media of its own passes it on (see onKey).

let myFrameId = -1;
let mediaInOtherFrames = false;
let toldHasMedia = false;

async function joinFrameRelay() {
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'speed:media-frames') {
        mediaInOtherFrames = (msg.frames as number[]).some((f) => f !== myFrameId);
      } else if (msg?.type === 'speed:run-key' && active) {
        const sc = shortcuts.get(msg.code);
        const m = targetMedia();
        if (sc && m) runShortcut(sc, m);
      }
    });
    const reply = (await chrome.runtime.sendMessage({ type: 'speed:hello' })) as { frameId: number; frames: number[] } | undefined;
    if (reply) {
      myFrameId = reply.frameId;
      mediaInOtherFrames = reply.frames.some((f) => f !== myFrameId);
    }
  } catch {
    // extension reloaded
  }
}

function announceHasMedia() {
  if (toldHasMedia) return;
  toldHasMedia = true;
  try {
    void chrome.runtime.sendMessage({ type: 'speed:has-media' }).catch(() => {});
  } catch {
    // extension reloaded
  }
}

const vscPresent = () => !!document.querySelector('.vsc-controller');

// ---------- overlay ----------

const CSS = `
:host { all: initial; position: absolute; z-index: 2147483000; top: 0; left: 0; width: 0; height: 0; }
.ctl {
  position: absolute; display: flex; align-items: center; gap: 2px;
  margin: 10px 0 0 12px; padding: 3px; border-radius: 9px;
  background: rgba(16,16,16,.82); color: #fff; box-shadow: 0 2px 10px rgba(0,0,0,.35);
  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  font: 600 13px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-variant-numeric: tabular-nums; user-select: none; transition: opacity .15s;
}
.ctl.hidden { display: none; }
.ctl.flash { opacity: 1 !important; }
.ctl:hover, .ctl.open { opacity: 1 !important; }
button {
  all: unset; box-sizing: border-box; cursor: pointer; border-radius: 6px;
  min-width: 26px; height: 24px; padding: 0 6px; display: inline-flex; align-items: center; justify-content: center;
  font: inherit; color: inherit;
}
button:hover { background: rgba(255,255,255,.16); }
button:focus-visible { outline: 2px solid #3ea6ff; outline-offset: 1px; }
.speed { min-width: 46px; cursor: grab; }
.speed.dragging { cursor: grabbing; }
.btns { display: none; align-items: center; gap: 2px; }
.ctl:hover .btns, .ctl.open .btns { display: inline-flex; }
.btns button { font-weight: 500; color: rgba(255,255,255,.85); }
.sep { width: 1px; height: 14px; background: rgba(255,255,255,.18); margin: 0 2px; }
.panel {
  position: absolute; top: calc(100% + 6px); left: 0; width: 264px; padding: 12px;
  border-radius: 12px; background: rgba(20,20,20,.96); box-shadow: 0 8px 28px rgba(0,0,0,.45);
  display: grid; gap: 10px; font-weight: 500;
}
.panel[hidden] { display: none; }
.row { display: flex; align-items: center; gap: 6px; }
.row input[type=range] { flex: 1; min-width: 0; accent-color: #3ea6ff; }
.row input[type=number] {
  width: 64px; padding: 4px 6px; border-radius: 6px; border: 1px solid rgba(255,255,255,.2);
  background: rgba(255,255,255,.06); color: #fff; font: inherit;
}
.chips { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; }
.chip { background: rgba(255,255,255,.1); border-radius: 999px; height: 26px; font-weight: 500; }
.chip.on { background: #fff; color: #111; }
.hint { color: rgba(255,255,255,.55); font-size: 11px; font-weight: 400; line-height: 1.4; }
.warn { color: #ffb74d; font-size: 11px; font-weight: 400; }
.ramp { display: grid; gap: 4px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,.12); }
.ramp-head { display: flex; align-items: center; justify-content: space-between; }
.ramp-title { font-weight: 600; }
.ramp-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin-top: 2px; }
.ramp-actions .chip { padding: 0 9px; min-width: 0; font-size: 12px; }
.ramp-actions .chip.wide { flex-basis: 100%; }
.ramp-pause-label { color: rgba(255,255,255,.6); font-size: 11px; font-weight: 400; margin: 0 2px 0 0; }
.switch { position: relative; width: 32px; min-width: 32px; height: 18px; padding: 0; border-radius: 999px; background: rgba(255,255,255,.25); }
.switch:hover { background: rgba(255,255,255,.35); }
.switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform .15s; }
.switch[aria-checked="true"] { background: #3ea6ff; }
.switch[aria-checked="true"]::after { transform: translateX(14px); }
`;

let sheet: CSSStyleSheet | null = null;
function sharedSheet() {
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
  }
  return sheet;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}

class Controller {
  private host: HTMLElement;
  private root: ShadowRoot;
  private ctl: HTMLDivElement;
  private speed: HTMLButtonElement;
  private panel: HTMLDivElement | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  private panelInputs: {
    slider: HTMLInputElement;
    input: HTMLInputElement;
    chips: HTMLButtonElement[];
    warn: HTMLElement;
    rampToggle: HTMLButtonElement;
    rampText: HTMLElement;
  } | null = null;
  private label: string | null = null;
  private labelTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private media: HTMLVideoElement) {
    this.host = document.createElement('div');
    this.host.className = 'bt-speed-controller';
    const root = (this.root = this.host.attachShadow({ mode: 'open' }));
    root.adoptedStyleSheets = [sharedSheet()];

    this.ctl = h('div', 'ctl');
    this.ctl.style.opacity = String(settings.opacity);
    this.speed = h('button', 'speed');
    this.speed.title = 'Click for speed options · drag to move · scroll to adjust';
    const btns = h('div', 'btns');
    const btn = (label: string, title: string, fn: () => void) => {
      const b = h('button', '', label);
      b.title = title;
      b.addEventListener('click', fn);
      return b;
    };
    const step = (dir: 1 | -1) => () => {
      const action = dir > 0 ? 'faster' : 'slower';
      const sc = settings.shortcuts.find((x) => x.action === action);
      run(action, this.media, sc?.value ?? 0.1);
      const label = applyRampEffect(rampEffectOf(sc ?? { action }), this.media);
      if (label) this.flashLabel(label);
    };
    const seek = (dir: 1 | -1) => () => {
      const sc = settings.shortcuts.find((x) => x.action === (dir > 0 ? 'advance' : 'rewind'));
      run(dir > 0 ? 'advance' : 'rewind', this.media, sc?.value ?? 10);
    };
    btns.append(
      btn('«', 'Rewind', seek(-1)),
      btn('−', 'Slower', step(-1)),
      btn('+', 'Faster', step(1)),
      btn('»', 'Advance', seek(1)),
      h('span', 'sep'),
      btn('✕', 'Hide (press the show/hide key to bring it back)', () => run('display', this.media, 0)),
    );
    this.ctl.append(this.speed, btns);
    root.append(this.ctl);

    // Keep clicks on the overlay away from the page (players toggle on click).
    for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart']) {
      this.host.addEventListener(type, (e) => e.stopPropagation());
    }
    this.speed.addEventListener('pointerdown', (e) => this.dragOrClick(e));
    this.ctl.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        const delta = e.shiftKey ? 0.25 : 0.05;
        run(e.deltaY < 0 ? 'faster' : 'slower', this.media, delta);
      },
      { passive: false },
    );

    this.mount();
    this.update();
  }

  /** YouTube: inside the player so it survives fullscreen; elsewhere: next to the video. */
  private mount() {
    const player = this.media.closest('#movie_player, .html5-video-player');
    if (player) {
      player.prepend(this.host);
      this.host.style.top = '0px';
      this.host.style.left = '0px';
    } else {
      const parent = this.media.parentElement;
      if (!parent) return;
      parent.insertBefore(this.host, parent.firstChild);
      this.host.style.top = `${Math.max(0, this.media.offsetTop)}px`;
      this.host.style.left = `${Math.max(0, this.media.offsetLeft)}px`;
    }
  }

  update() {
    if (!this.media.isConnected) {
      this.host.remove();
      return;
    }
    if (!this.host.isConnected) this.mount();
    const rate = this.media.playbackRate;
    this.speed.textContent = this.label ?? fmtRateDisplay(rate, settings.speedDecimals);
    this.ctl.style.opacity = String(settings.opacity);
    const hidden = !active || hiddenAll || vscPresent() || (!this.media.currentSrc && !this.media.srcObject);
    this.ctl.classList.toggle('hidden', hidden);
    if (this.panelInputs) {
      const { slider, input, chips, warn, rampToggle, rampText } = this.panelInputs;
      slider.value = String(Math.min(rate, 4));
      if (this.root.activeElement !== input) input.value = fmt(rate);
      chips.forEach((c) => c.classList.toggle('on', Number(c.dataset.rate) === round(rate)));
      warn.hidden = rate <= 4;
      rampToggle.setAttribute('aria-checked', String(settings.ramp));
      rampText.textContent = rampStatus(this.media);
    }
  }

  /** Show a word in place of the speed for a moment ("Speed-up on"). */
  flashLabel(text: string) {
    this.label = text;
    this.update();
    this.blink();
    clearTimeout(this.labelTimer);
    this.labelTimer = setTimeout(() => {
      this.label = null;
      this.update();
    }, 1200);
  }

  /** Briefly show a hidden overlay so key presses get feedback. */
  blink() {
    if (!hiddenAll || !active) return;
    this.ctl.classList.remove('hidden');
    this.ctl.classList.add('flash');
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.ctl.classList.remove('flash');
      this.update();
    }, 1000);
  }

  private dragOrClick(e: PointerEvent) {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const left = this.ctl.offsetLeft;
    const top = this.ctl.offsetTop;
    let dragging = false;
    this.speed.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) < 4) return;
      dragging = true;
      this.speed.classList.add('dragging');
      this.ctl.style.left = `${left + dx - 12}px`;
      this.ctl.style.top = `${top + dy - 10}px`;
    };
    const up = () => {
      this.speed.removeEventListener('pointermove', move);
      this.speed.classList.remove('dragging');
      if (!dragging) this.togglePanel();
    };
    this.speed.addEventListener('pointermove', move);
    this.speed.addEventListener('pointerup', up, { once: true });
    this.speed.addEventListener('pointercancel', up, { once: true });
  }

  private togglePanel() {
    if (!this.panel) this.buildPanel();
    const open = this.panel!.hidden === true;
    this.panel!.hidden = !open;
    this.ctl.classList.toggle('open', open);
    this.update();
  }

  private buildPanel() {
    const panel = h('div', 'panel');
    panel.hidden = true;
    const slider = h('input');
    slider.type = 'range';
    slider.min = '0.25';
    slider.max = '4';
    slider.step = '0.05';
    slider.setAttribute('aria-label', 'Speed');
    slider.addEventListener('input', () => {
      userSetRate(this.media, Number(slider.value));
    });
    const input = h('input');
    input.type = 'number';
    input.min = String(MIN_RATE);
    input.max = String(MAX_RATE);
    input.step = '0.05';
    input.setAttribute('aria-label', 'Exact speed');
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (Number.isFinite(v) && v > 0) {
        userSetRate(this.media, v);
      }
    });
    input.addEventListener('keydown', (e) => e.stopPropagation());
    const preferred = settings.shortcuts.filter((x) => x.action === 'preferred').map((x) => x.value);
    const rates = [...new Set([1, 1.25, 1.5, 2, ...preferred])].sort((a, b) => a - b).slice(0, 12);
    const chipsWrap = h('div', 'chips');
    const chips = rates.map((r) => {
      const c = h('button', 'chip', `${r}×`);
      c.dataset.rate = String(r);
      c.addEventListener('click', () => {
        userSetRate(this.media, r);
      });
      return c;
    });
    chipsWrap.append(...chips);
    const warn = h('div', 'warn', 'Browsers mute audio above 4×.');
    const keys = settings.shortcuts
      .filter((x) => ['slower', 'faster', 'reset', 'display'].includes(x.action))
      .map((x) => `${keyLabel(x.code)} ${ACTIONS[x.action].label.split(' ')[0].toLowerCase()}`)
      .join(' · ');
    const hint = h('div', 'hint', `${keys} · scroll on the speed to adjust`);
    const row = h('div', 'row');
    row.append(slider, input);

    // Gradual speed-up: on/off and what it's doing right now.
    const rampToggle = h('button', 'switch');
    rampToggle.setAttribute('role', 'switch');
    rampToggle.setAttribute('aria-label', 'Gradual speed-up');
    rampToggle.addEventListener('click', () => {
      run('ramp', this.media, 0);
      this.update();
    });
    const rampKey = settings.shortcuts.find((x) => x.action === 'ramp');
    const rampHead = h('div', 'ramp-head');
    rampHead.append(h('span', 'ramp-title', `Gradual speed-up${rampKey?.code ? ` (${keyLabel(rampKey.code)})` : ''}`), rampToggle);
    const rampText = h('div', 'hint');
    // Stop for this video, or pause for a while.
    const holdKey = settings.shortcuts.find((x) => x.action === 'rampHoldVideo' && x.code);
    const hold = h('button', 'chip wide', `Stop for this video${holdKey ? ` (${keyLabel(holdKey.code)})` : ''}`);
    hold.addEventListener('click', () => {
      run('rampHoldVideo', this.media, 0);
      this.update();
    });
    const pauseRow = h('div', 'ramp-actions');
    pauseRow.append(hold, h('span', 'ramp-pause-label', 'Pause for'));
    for (const mins of [5, 10, 30, 60]) {
      const c = h('button', 'chip', mins < 60 ? `${mins}m` : '1h');
      c.addEventListener('click', () => {
        run('rampPauseFor', this.media, mins);
        this.update();
      });
      pauseRow.append(c);
    }
    const ramp = h('div', 'ramp');
    ramp.append(rampHead, rampText, pauseRow);

    panel.append(row, chipsWrap, warn, ramp, hint);
    this.ctl.append(panel);
    this.panel = panel;
    this.panelInputs = { slider, input, chips, warn, rampToggle, rampText };
    // Close when clicking anywhere else.
    document.addEventListener('pointerdown', (e) => {
      if (this.panel && !this.panel.hidden && !e.composedPath().includes(this.host)) this.togglePanel();
    });
  }
}

// ---------- settings & startup ----------

function applySettings(s: SpeedSettings) {
  // "Hide controller by default": start hidden on load or when the option flips.
  if (!ready || s.startHidden !== settings.startHidden) hiddenAll = s.startHidden;
  settings = s;
  shortcuts = new Map(s.shortcuts.filter((x) => x.code).map((x) => [x.code, x]));
  active = s.enabled && !isBlacklisted(s.blacklist, location.href);
  if (s.ramp && active) startRamp();
  else stopRamp();
  for (const m of recent) stateOf(m).controller?.update();
}

async function start() {
  for (const type of ['loadstart', 'loadedmetadata', 'play', 'ratechange']) {
    document.addEventListener(type, onMediaEvent, true);
  }
  // Media inside shadow DOM announce themselves (speed-main.js).
  document.addEventListener(
    'bt-media',
    (e) => {
      const m = e.composedPath()[0];
      if (active && m instanceof HTMLMediaElement) {
        adopt(m);
        startRamp();
      }
    },
    true,
  );
  void joinFrameRelay();
  window.addEventListener('keydown', onKey, true);

  INCOGNITO = await isIncognito();
  const keys = [LAST_SPEED_KEY, RAMP_PAUSED_KEY, SITE_SPEEDS_KEY, RAMP_PAUSED_UNTIL_KEY];
  const [sync, local, own] = await Promise.all([
    chrome.storage.sync.get(SPEED_KEY),
    chrome.storage.local.get(keys),
    privateArea().get(keys.map(pk)),
  ]);
  if (INCOGNITO) normalSiteSpeeds = (local[SITE_SPEEDS_KEY] as Record<string, number> | undefined) ?? {};
  // In incognito, a fresh session starts from your normal last speed.
  lastSpeed = (own[pk(LAST_SPEED_KEY)] as number | undefined) ?? (local[LAST_SPEED_KEY] as number | undefined) ?? 1;
  siteSpeeds = (own[pk(SITE_SPEEDS_KEY)] as Record<string, number> | undefined) ?? {};
  rampPaused = own[pk(RAMP_PAUSED_KEY)] === true;
  rampTimedUntil = (own[pk(RAMP_PAUSED_UNTIL_KEY)] as number | undefined) ?? 0;
  applySettings(withSpeedDefaults(sync[SPEED_KEY] as Partial<SpeedSettings> | undefined));
  ready = true;

  // Media that started before settings arrived.
  const adoptExisting = () => {
    for (const m of document.querySelectorAll<HTMLMediaElement>('video, audio')) {
      if (m.readyState > 0 && active) adopt(m);
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', adoptExisting, { once: true });
  else adoptExisting();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes[SPEED_KEY]) {
      applySettings(withSpeedDefaults(changes[SPEED_KEY].newValue as Partial<SpeedSettings> | undefined));
    }
    if (INCOGNITO && area === 'local' && changes[SITE_SPEEDS_KEY]) {
      normalSiteSpeeds = (changes[SITE_SPEEDS_KEY].newValue as Record<string, number> | undefined) ?? {};
    }
    if (area !== privateAreaName()) return;
    const changed = (key: string) => changes[pk(key)];
    if (changed(LAST_SPEED_KEY)?.newValue !== undefined) lastSpeed = changed(LAST_SPEED_KEY).newValue as number;
    if (changed(SITE_SPEEDS_KEY)) siteSpeeds = (changed(SITE_SPEEDS_KEY).newValue as Record<string, number> | undefined) ?? {};
    if (changed(RAMP_PAUSED_UNTIL_KEY)) {
      rampTimedUntil = (changed(RAMP_PAUSED_UNTIL_KEY).newValue as number | undefined) ?? 0;
      for (const x of recent) stateOf(x).controller?.update();
    }
    if (changed(RAMP_PAUSED_KEY)) {
      rampPaused = changed(RAMP_PAUSED_KEY).newValue === true;
      for (const x of recent) stateOf(x).controller?.update();
    }
  });

  // The popup asks the top frame what's going on in this tab.
  if (window === window.top) {
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (msg?.type !== 'speed:status') return;
      const m = targetMedia();
      reply({
        ready,
        active,
        vscDetected: vscPresent(),
        media: recent.filter((x) => x.isConnected).length,
        rate: m?.playbackRate ?? null,
        site,
        siteSpeed: siteSpeeds[site] ?? null,
        incognito: INCOGNITO,
        perSite: settings.perSiteSpeed,
      });
    });
  }
}

void start();
