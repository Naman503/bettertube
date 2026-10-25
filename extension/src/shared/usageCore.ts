// Pure helpers for anonymous usage (no chrome.* here, so tests can run them in Node).
// Everything that leaves the browser is a fixed name, a fixed enum value, a bucket,
// a count or a boolean. Nothing typed, nothing from the page.

export type PropValue = string | number | boolean;
export type Props = Record<string, PropValue>;

/** Every counter name the background accepts from content scripts and pages. */
export const CLIENT_COUNTERS = new Set([
  // speed controller (every site)
  'speed_changed',
  'shortcut_used',
  'shortcut_relayed',
  'overlay_panel_opened',
  'overlay_moved',
  'overlay_action',
  'ramp_control',
  'ramp_step',
  'ramp_reached_max',
  'ramp_eased',
  'speed_restored',
  'site_speed_overridden',
  'media_found',
  'controller_conflict',
  // YouTube page
  'shorts_redirected',
  'autoplay_turned_off',
  'idle_dialog_dismissed',
  'quality_lowered',
  'default_quality_applied',
  'layout_flags_applied',
  'layout_detected',
  'view_corrected',
  'view_user_changed',
  'player_resized',
  'player_size_reset',
  'description_shown',
  'description_expanded',
  'description_timestamp',
  'daily_limit_reached',
  'module_error',
  // popup / options / dashboard
  'popup_opened',
  'popup_tab',
  'quick_toggle',
  'preset_applied',
  'settings_reset',
  'settings_searched',
  'site_speed_toggle',
  'shortcut_edited',
  'blacklist_edited',
  'site_speeds_forgotten',
  'alert_shown',
  'alert_action',
  'diagnostics_run',
  'diagnostics_copied',
  'dashboard_opened',
  'dashboard_view',
  'dashboard_range',
  'stats_exported',
  'stats_cleared',
]);

/** Counted at most once per day, however many tabs report it. */
export const ONCE_A_DAY = new Set(['daily_limit_reached', 'settings_searched']);

const NAME = /^[a-z][a-z0-9_]{0,47}$/;
const KEY = /^[a-z][a-z0-9_]{0,31}$/;
/** Enum-looking values only: letters, digits and _ . - (no spaces, slashes, colons). */
const ENUM = /^[A-Za-z0-9_.-]{1,32}$/;

export const validName = (n: unknown): n is string => typeof n === 'string' && NAME.test(n);

/** Keeps ≤8 well-formed keys whose values are enums, finite numbers or booleans. */
export function sanitizeProps(p: unknown): Props | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const out: Props = {};
  let n = 0;
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
    if (n >= 8 || !KEY.test(k)) continue;
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
    else if (typeof v === 'string' && ENUM.test(v)) out[k] = v;
    else continue;
    n++;
  }
  return n ? out : undefined;
}

/** A speed as a range, never the exact value per video. */
export function speedBucket(rate: number): string {
  if (rate < 1) return 'slow';
  if (rate <= 1.5) return 'normal';
  if (rate <= 2.5) return 'fast';
  return 'faster';
}

/** Minutes → a coarse range label. */
export function minutesBucket(min: number): string {
  if (min <= 0) return '0';
  if (min < 15) return 'lt15';
  if (min < 30) return '15_30';
  if (min < 60) return '30_60';
  if (min < 120) return '60_120';
  if (min < 240) return '120_240';
  return 'gte240';
}

export function countBucket(n: number): string {
  if (n <= 0) return '0';
  if (n === 1) return '1';
  if (n <= 3) return '2_3';
  if (n <= 10) return '4_10';
  if (n <= 30) return '11_30';
  return 'gt30';
}

/** The setting value as a safe enum: booleans, enum strings, small numbers. Else undefined. */
export function settingValue(v: unknown): PropValue | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 1000) / 1000;
  if (typeof v === 'string' && ENUM.test(v)) return v;
  return undefined;
}

// ---------- crashes ----------

export interface CrashReport {
  fp: string;
  m: string;
  st?: string;
  t: number;
  fatal?: boolean;
}

/** djb2, hex. Stable across runs, short. */
export function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Error text with anything page- or user-derived removed: URLs, quoted strings,
 * long numbers and ids. Leaves the error class and our own wording.
 */
export function scrubMessage(msg: string): string {
  return msg
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '<str>')
    .replace(/\b[\w-]{11,}\b/g, (w) => (/^[A-Za-z]+$/.test(w) ? w : '<id>'))
    .replace(/\d{3,}/g, '<n>')
    .slice(0, 300);
}

/**
 * Keeps only the frames in our own bundles ("background.js:12:345"), with the
 * extension id dropped. Page frames are removed entirely.
 */
export function scrubStack(stack: string | undefined, extBase: string): string | undefined {
  if (!stack) return undefined;
  const frames = stack
    .split('\n')
    .slice(1)
    .filter((l) => l.includes(extBase))
    .map((l) => {
      const fn = /at\s+([\w$.<>]+)\s+\(/.exec(l)?.[1] ?? '';
      const loc = l.slice(l.indexOf(extBase) + extBase.length).replace(/\)?\s*$/, '');
      return `at ${fn ? `${fn} ` : ''}${loc}`.slice(0, 120);
    })
    .slice(0, 12);
  return frames.length ? frames.join('\n').slice(0, 1500) : undefined;
}

/** True when the stack or file shows the error came from one of our files. */
export function isOurs(file: string | undefined, stack: string | undefined, extBase: string, files: string[]): boolean {
  const mine = (s: string) => files.some((f) => s.includes(`${extBase}${f}`));
  if (file && mine(file)) return true;
  const first = stack?.split('\n').find((l) => l.includes('://'));
  return !!first && mine(first);
}

export function buildCrash(
  surface: string,
  err: { name?: string; message?: string; stack?: string } | string,
  extBase: string,
  fatal = false,
  t = Date.now(),
): CrashReport {
  const e = typeof err === 'string' ? { name: 'Error', message: err } : err;
  const name = String(e.name || 'Error').replace(/[^\w]/g, '').slice(0, 40) || 'Error';
  const message = scrubMessage(String(e.message ?? ''));
  const st = scrubStack(e.stack, extBase);
  const top = st?.split('\n')[0]?.replace(/:\d+(?=\D*$)/, '') ?? '';
  return {
    fp: `${surface}:${name}:${hash(`${name}|${message.slice(0, 80)}|${top}`)}`.slice(0, 64),
    m: `[${surface}] ${name}: ${message}`.slice(0, 500),
    ...(st ? { st } : {}),
    t,
    ...(fatal ? { fatal } : {}),
  };
}
