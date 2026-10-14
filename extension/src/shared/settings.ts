export type ViewMode = 'default' | 'theater' | 'remember';
export type CodecMode = 'auto' | 'off' | 'no-av1' | 'h264';
export type Quality = 'auto' | '2160' | '1440' | '1080' | '720' | '480' | '360';


export interface Settings {
  // Watch page layout
  viewMode: ViewMode;
  classicLayout: boolean;
  compactSidebar: boolean;
  sidebarWidth: number; // px; 0 = YouTube default (drag the divider on the watch page)
  theaterHeight: number; // % of window height; 0 = YouTube default
  restoreDescription: boolean;
  noBigTheater: boolean;
  revertPlayerControls: boolean;
  squareCorners: boolean;
  // Declutter
  hideShorts: boolean;
  redirectShorts: boolean;
  hideAI: boolean;
  hideEndscreen: boolean;
  disableHoverPreviews: boolean;
  disableAmbient: boolean;
  autoplayOff: boolean;
  autoContinue: boolean;
  hideRelated: boolean;
  hideComments: boolean;
  // Home
  gridItemsPerRow: number; // 0 = YouTube default
  // Playback
  defaultQuality: Quality;
  // Performance
  codecMode: CodecMode;
  /** Step quality down when a video keeps buffering. */
  antiBuffer: boolean;
  // Watch stats
  statsEnabled: boolean;
  statsBadge: boolean;
  dailyLimitMinutes: number; // 0 = no limit
  chip: string; // GPU renderer string detected by the popup, e.g. "Apple M1 Pro"
}

export const DEFAULTS: Settings = {
  viewMode: 'default',
  classicLayout: true,
  compactSidebar: true,
  sidebarWidth: 0,
  theaterHeight: 0,
  restoreDescription: true,
  noBigTheater: false,
  revertPlayerControls: false,
  squareCorners: false,
  hideShorts: true,
  redirectShorts: true,
  hideAI: true,
  hideEndscreen: true,
  disableHoverPreviews: false,
  disableAmbient: true,
  autoplayOff: false,
  autoContinue: true,
  hideRelated: false,
  hideComments: false,
  gridItemsPerRow: 0,
  defaultQuality: 'auto',
  codecMode: 'auto',
  antiBuffer: true,
  statsEnabled: true,
  statsBadge: true,
  dailyLimitMinutes: 0,
  chip: '',
};

/** chrome.storage.sync key holding the Settings object. */
export const STORAGE_KEY = 'settings';

/**
 * youtube.com localStorage key the isolated script mirrors settings into, so the
 * MAIN-world script can read them synchronously at document_start.
 */
export const MIRROR_KEY = 'bettertube:settings';

export function withDefaults(partial: Partial<Settings> | undefined): Settings {
  return { ...DEFAULTS, ...(partial ?? {}) };
}

/** Turns codecMode 'auto' into a concrete mode based on the detected chip. */
export function resolveCodecMode(s: Settings): Exclude<CodecMode, 'auto'> {
  if (s.codecMode !== 'auto') return s.codecMode;
  // AV1 is hardware-decoded only on Apple M3 and later; elsewhere it burns CPU.
  const m = /Apple M(\d+)/i.exec(s.chip);
  if (m && Number(m[1]) >= 3) return 'off';
  return 'no-av1';
}

export interface Preset {
  label: string;
  description: string;
  values: Partial<Settings>;
}

export const PRESETS: Record<string, Preset> = {
  classic: {
    label: 'Classic',
    description: 'Old watch layout, normal view, less clutter',
    values: {
      viewMode: 'default',
      classicLayout: true,
      compactSidebar: true,
      hideRelated: false,
      hideComments: false,
      hideShorts: true,
      hideAI: true,
      hideEndscreen: true,
    },
  },
  focus: {
    label: 'Focus',
    description: 'No recommendations, Shorts, comments or autoplay',
    values: {
      hideRelated: true,
      hideComments: true,
      hideShorts: true,
      redirectShorts: true,
      hideAI: true,
      hideEndscreen: true,
      autoplayOff: true,
      disableHoverPreviews: true,
    },
  },
  lowPower: {
    label: 'Low power',
    description: 'H.264 only, ≤1080p, no ambient mode or previews',
    values: {
      codecMode: 'h264',
      defaultQuality: '1080',
      disableAmbient: true,
      disableHoverPreviews: true,
    },
  },
};

/** Reads the settings copy mirrored into youtube.com's localStorage (sync). */
export function readMirror(): Settings {
  try {
    return withDefaults(JSON.parse(localStorage.getItem(MIRROR_KEY) ?? '{}'));
  } catch {
    return withDefaults(undefined);
  }
}
