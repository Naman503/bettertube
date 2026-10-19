// Settings for the speed controller that runs on every site (a faster,
// lighter take on Video Speed Controller). Stored separately from the
// YouTube settings under SPEED_KEY in chrome.storage.sync.

export type SpeedAction =
  | 'display'
  | 'slower'
  | 'faster'
  | 'rewind'
  | 'advance'
  | 'reset'
  | 'preferred'
  | 'pause'
  | 'mute'
  | 'mark'
  | 'jump'
  | 'ramp'
  | 'rampHoldVideo'
  | 'rampPauseFor';

export type SpeedDecimals = 'auto' | 0 | 1 | 2 | 3;

/** What a shortcut does to gradual speed-up, besides its own action. */
export type RampEffect = 'none' | 'pause' | 'resume';

export interface Shortcut {
  action: SpeedAction;
  /** KeyboardEvent.code, e.g. "KeyS", so it works on any keyboard layout. */
  code: string;
  value: number;
  /** Unset = the action's default (see rampEffectOf). */
  ramp?: RampEffect;
}

/** R (back to 1×) pauses the climb; speeding up again resumes it. */
const DEFAULT_RAMP_EFFECT: Partial<Record<SpeedAction, RampEffect>> = {
  reset: 'pause',
  preferred: 'resume',
  faster: 'resume',
};

export const rampEffectOf = (sc: Pick<Shortcut, 'action' | 'ramp'>): RampEffect =>
  sc.ramp ?? DEFAULT_RAMP_EFFECT[sc.action] ?? 'none';

/** chrome.storage.local: gradual speed-up paused by a shortcut (shared by all tabs, survives videos). */
export const RAMP_PAUSED_KEY = 'rampPaused';
/** chrome.storage.local: timestamp until which gradual speed-up is paused ("pause for N min"). */
export const RAMP_PAUSED_UNTIL_KEY = 'rampPausedUntil';

export interface SpeedSettings {
  enabled: boolean;
  /** Apply your last speed to every new video. */
  rememberSpeed: boolean;
  /** Remember the last speed separately for each site (new sites start at your last speed anywhere). */
  perSiteSpeed: boolean;
  /** Ignore speed changes made by the site itself (e.g. its own speed menu). */
  forceSpeed: boolean;
  workOnAudio: boolean;
  startHidden: boolean;
  /** Controller opacity when not hovered. */
  opacity: number;
  /** Decimal places for the speed on the video: 'auto' = 2, or 3 when needed. Display only. */
  speedDecimals: SpeedDecimals;
  shortcuts: Shortcut[];
  /** One per line; plain text matches anywhere in the URL, /regex/ for patterns. */
  blacklist: string;
  /** Which default shortcuts a saved list has been offered (see withSpeedDefaults). */
  shortcutsVersion: number;

  // ---- Gradual speed-up ("ramp") ----
  /** Raise the speed a little at a time while you watch. */
  ramp: boolean;
  /** How much each step adds, e.g. 0.01×. */
  rampStep: number;
  /** Seconds of actual playback between steps. */
  rampEverySec: number;
  /** Never ramp above this. */
  rampMax: number;
  /** Next video starts at the speed this one reached (otherwise at your own last speed). */
  rampCarryOver: boolean;
  /** After you change the speed yourself: keep ramping from there, or stop for this video. */
  rampOnManual: 'continue' | 'hold';
  /** Don't ramp videos shorter than this many minutes (clips, most ads). 0 = ramp everything. */
  rampMinVideoMin: number;
  /** Jumping back means it got too fast: drop a little and pause the climb for a minute. */
  rampEaseOnRewind: boolean;
  /** No speed-up while the speed is inside [rampQuietFrom, rampQuietTo] (e.g. music at 1–2×). */
  rampQuiet: boolean;
  rampQuietFrom: number;
  rampQuietTo: number;
}

/** Inside the quiet zone, the climb waits. */
export const inQuietZone = (rate: number, s: SpeedSettings) =>
  s.rampQuiet && rate >= s.rampQuietFrom - 1e-9 && rate <= s.rampQuietTo + 1e-9;

/** 3.1 → "3.10", 3.015 → "3.015" (speeds keep up to 3 decimals). */
export function fmtRate(r: number) {
  const three = (Math.round(r * 1000) / 1000).toFixed(3);
  return three.endsWith('0') ? three.slice(0, -1) : three;
}

/** The speed as shown on the video: fixed decimals, or fmtRate's "auto". */
export function fmtRateDisplay(r: number, decimals: SpeedDecimals) {
  if (decimals === 'auto') return fmtRate(r);
  // Round halves up despite floating point (3.05 is stored as 3.04999…).
  const f = 10 ** decimals;
  return (Math.round(r * f + 1e-7) / f).toFixed(decimals);
}

/** 45 → "45 s", 90 → "1 min 30 s", 7500 → "2 h 5 min". */
export function fmtInterval(totalSec: number) {
  const sec = Math.round(totalSec * 10) / 10;
  if (sec < 60) return `${sec} s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return [h && `${h} h`, m && `${m} min`, s && `${s} s`].filter(Boolean).join(' ');
}

/** Limits for the editable gradual speed-up values. */
export const RAMP_LIMITS = {
  everySec: { min: 1, max: 6 * 3600 },
  step: { min: 0.001, max: 1 },
  minVideoMin: { min: 0, max: 600 },
};

/** Minutes of playback to climb from `from` to the ramp's max. */
export function rampMinutesToMax(from: number, s: SpeedSettings) {
  if (s.rampStep <= 0 || from >= s.rampMax) return 0;
  return (Math.ceil((s.rampMax - from) / s.rampStep - 1e-9) * s.rampEverySec) / 60;
}

export const SPEED_KEY = 'speedController';
/** chrome.storage.local: the last speed you chose, shared by all tabs. */
export const LAST_SPEED_KEY = 'lastSpeed';
/** chrome.storage.local: { [site]: last speed you used there }. */
export const SITE_SPEEDS_KEY = 'siteSpeeds';

/** "www.youtube.com" → "youtube.com" (the key a speed is remembered under). */
export const siteKey = (hostname: string) => hostname.replace(/^www\./, '').toLowerCase();
export const MIN_RATE = 0.07;
export const MAX_RATE = 16;

export const ACTIONS: Record<SpeedAction, { label: string; title: string; hasValue: boolean; unit?: string }> = {
  display: { label: 'Show/hide', hasValue: false, title: 'Show or hide the on-video controller' },
  slower: { label: 'Slower', hasValue: true, unit: '×', title: 'Decrease speed by this much' },
  faster: { label: 'Faster', hasValue: true, unit: '×', title: 'Increase speed by this much' },
  rewind: { label: 'Rewind', hasValue: true, unit: 's', title: 'Jump back this many seconds' },
  advance: { label: 'Advance', hasValue: true, unit: 's', title: 'Jump forward this many seconds' },
  reset: { label: 'Reset 1×', hasValue: false, title: 'Go to 1×; press again to return to your previous speed' },
  preferred: { label: 'Preferred', hasValue: true, unit: '×', title: 'Go to this speed; press again to return' },
  pause: { label: 'Play/pause', hasValue: false, title: 'Play or pause' },
  mute: { label: 'Mute', hasValue: false, title: 'Mute or unmute' },
  mark: { label: 'Set marker', hasValue: false, title: 'Remember the current time' },
  jump: { label: 'Jump to marker', hasValue: false, title: 'Go back to the remembered time' },
  ramp: { label: 'Speed-up', hasValue: false, title: 'Turn gradual speed-up on or off' },
  rampHoldVideo: { label: 'Stop this video', hasValue: false, title: 'Stop gradual speed-up for this video only; press again to resume' },
  rampPauseFor: { label: 'Pause for', hasValue: true, unit: 'min', title: 'Pause gradual speed-up for this many minutes (all videos and tabs)' },
};

export const DEFAULT_SPEED_SETTINGS: SpeedSettings = {
  enabled: true,
  rememberSpeed: true,
  perSiteSpeed: true,
  forceSpeed: false,
  workOnAudio: true,
  startHidden: false,
  opacity: 0.55,
  speedDecimals: 'auto',
  shortcuts: [
    { action: 'display', code: 'KeyV', value: 0 },
    { action: 'slower', code: 'KeyS', value: 0.05 },
    { action: 'faster', code: 'KeyD', value: 0.05 },
    { action: 'rewind', code: 'KeyZ', value: 10 },
    { action: 'advance', code: 'KeyX', value: 10 },
    { action: 'reset', code: 'KeyR', value: 1 },
    { action: 'preferred', code: 'KeyG', value: 3.1 },
    { action: 'preferred', code: 'KeyH', value: 2.95 },
    { action: 'preferred', code: 'KeyY', value: 3.6 },
    { action: 'preferred', code: 'KeyP', value: 16 },
    { action: 'preferred', code: 'KeyU', value: 2.35 },
    { action: 'ramp', code: 'KeyA', value: 0 },
    { action: 'rampHoldVideo', code: 'KeyQ', value: 0 },
    { action: 'rampPauseFor', code: 'KeyW', value: 10 },
  ],
  blacklist: '',
  shortcutsVersion: 3,
  ramp: false,
  rampStep: 0.01,
  rampEverySec: 30,
  rampMax: 2.5,
  rampCarryOver: true,
  rampOnManual: 'continue',
  rampMinVideoMin: 2,
  rampEaseOnRewind: true,
  rampQuiet: false,
  rampQuietFrom: 1,
  rampQuietTo: 2,
};

export function withSpeedDefaults(partial: Partial<SpeedSettings> | undefined): SpeedSettings {
  const s = { ...DEFAULT_SPEED_SETTINGS, ...(partial ?? {}) };
  // A saved shortcut list replaces the defaults, so new default keys never
  // appear for existing users. Offer each once: v2 added "A" for gradual
  // speed-up. Deleting it afterwards sticks, because the saved list then
  // carries shortcutsVersion 2.
  if (partial?.shortcuts && (partial.shortcutsVersion ?? 1) < 2) {
    const hasRamp = s.shortcuts.some((x) => x.action === 'ramp');
    const aTaken = s.shortcuts.some((x) => x.code === 'KeyA');
    if (!hasRamp && !aTaken) s.shortcuts = [...s.shortcuts, { action: 'ramp', code: 'KeyA', value: 0 }];
    s.shortcutsVersion = 2;
  }
  // v3 added Q (stop speed-up for this video) and W (pause it for 10 min).
  if (partial?.shortcuts && (partial.shortcutsVersion ?? 1) < 3) {
    const add = (action: SpeedAction, code: string, value: number) => {
      if (!s.shortcuts.some((x) => x.action === action) && !s.shortcuts.some((x) => x.code === code)) {
        s.shortcuts = [...s.shortcuts, { action, code, value }];
      }
    };
    add('rampHoldVideo', 'KeyQ', 0);
    add('rampPauseFor', 'KeyW', 10);
    s.shortcutsVersion = 3;
  }
  return s;
}

/** "KeyS" → "S", "Digit1" → "1", "BracketLeft" → "BracketLeft". */
export const keyLabel = (code: string) => code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ');

export function isBlacklisted(blacklist: string, url: string) {
  return blacklist
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .some((rule) => {
      const m = /^\/(.+)\/([a-z]*)$/.exec(rule);
      if (!m) return url.includes(rule);
      try {
        return new RegExp(m[1], m[2].replace('g', '')).test(url);
      } catch {
        return false;
      }
    });
}
