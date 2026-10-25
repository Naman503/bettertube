import type { Settings } from '../shared/settings';

type Key = keyof Settings;

interface Base {
  key: Key;
  label: string;
  hint?: string;
  /** Takes effect only after YouTube reloads (experiment flags, codecs). */
  reload?: boolean;
}

export type Field =
  | (Base & { type: 'toggle' })
  | (Base & { type: 'select'; options: [value: string | number, label: string][] })
  | (Base & { type: 'range'; min: number; max: number; step: number; unit: string; zeroLabel: string });

export interface Section {
  title: string;
  fields: Field[];
}

export const SECTIONS: Section[] = [
  {
    title: 'Watch page',
    fields: [
      {
        key: 'viewMode',
        label: 'Open videos in',
        type: 'select',
        options: [
          ['default', 'Normal view'],
          ['theater', 'Theater'],
          ['remember', 'Whatever I used last'],
        ],
      },
      {
        key: 'classicLayout',
        label: 'Classic layout',
        hint: 'Up-next videos on the right; description and comments under the player',
        type: 'toggle',
        reload: true,
      },
      { key: 'restoreDescription', label: 'Description under the video', hint: 'When YouTube moves it into the side panel', type: 'toggle' },
      { key: 'compactSidebar', label: 'Compact up-next list with full titles', type: 'toggle' },
      {
        key: 'sidebarWidth',
        label: 'Up-next column width',
        hint: 'Smaller = bigger video. Or drag the divider next to the video.',
        type: 'range',
        min: 240,
        max: 900,
        step: 10,
        unit: 'px',
        zeroLabel: 'Default',
      },
      {
        key: 'theaterHeight',
        label: 'Theater player height',
        type: 'range',
        min: 40,
        max: 100,
        step: 5,
        unit: '% of window',
        zeroLabel: 'Default',
      },
      { key: 'noBigTheater', label: 'Normal-size controls in theater', type: 'toggle' },
      {
        key: 'revertPlayerControls',
        label: 'Old player controls',
        hint: 'Undo the 2025 bubble-style controls (while YouTube still allows it)',
        type: 'toggle',
        reload: true,
      },
      { key: 'squareCorners', label: 'Square corners', type: 'toggle', reload: true },
    ],
  },
  {
    title: 'Declutter',
    fields: [
      { key: 'hideShorts', label: 'Hide Shorts', type: 'toggle' },
      { key: 'redirectShorts', label: 'Open Shorts in the normal player', type: 'toggle' },
      { key: 'hideAI', label: 'Hide AI "Ask" button and summaries', type: 'toggle' },
      { key: 'hideEndscreen', label: 'Hide end-screen cards', type: 'toggle' },
      { key: 'autoContinue', label: 'Skip "Continue watching?" prompt', type: 'toggle' },
      { key: 'autoplayOff', label: 'Turn autoplay off', type: 'toggle' },
      { key: 'disableHoverPreviews', label: 'No hover previews on thumbnails', type: 'toggle' },
      { key: 'disableAmbient', label: 'No ambient glow', type: 'toggle', reload: true },
      { key: 'hideRelated', label: 'Hide up-next videos', type: 'toggle' },
      { key: 'hideComments', label: 'Hide comments', type: 'toggle' },
    ],
  },
  {
    title: 'Home',
    fields: [
      {
        key: 'gridItemsPerRow',
        label: 'Videos per row',
        type: 'select',
        options: [
          [0, 'YouTube default'],
          [3, '3'],
          [4, '4'],
          [5, '5'],
          [6, '6'],
        ],
      },
    ],
  },
  {
    title: 'Playback',
    fields: [
      {
        key: 'defaultQuality',
        label: 'Default quality',
        type: 'select',
        options: [
          ['auto', 'Auto'],
          ['2160', '2160p'],
          ['1440', '1440p'],
          ['1080', '1080p'],
          ['720', '720p'],
          ['480', '480p'],
          ['360', '360p'],
        ],
      },
      {
        key: 'antiBuffer',
        label: 'Avoid buffering',
        hint: 'If a video buffers twice in 90s, step the quality down one level',
        type: 'toggle',
      },
    ],
  },
  {
    title: 'Performance',
    fields: [
      {
        key: 'codecMode',
        label: 'Video codec',
        hint: 'Auto blocks AV1 unless your Mac has an M3 or newer (older chips decode it in software). H.264 is lightest but caps at 1080p.',
        type: 'select',
        reload: true,
        options: [
          ['auto', 'Auto (recommended)'],
          ['off', 'Let YouTube choose'],
          ['no-av1', 'Block AV1'],
          ['h264', 'H.264 only (max battery)'],
        ],
      },
    ],
  },
  {
    title: 'Watch stats',
    fields: [
      { key: 'statsEnabled', label: 'Track watch time and videos', hint: 'Kept in this browser; only daily totals go into anonymous usage', type: 'toggle' },
      {
        key: 'shareUsage',
        label: 'Share anonymous usage',
        hint: 'Daily counts of features used, speed ranges, your settings (switches only), watch time ranges and BetterTube errors, with a random id. Never videos, titles, channels, sites, what you type or incognito. Turning it off deletes what was sent.',
        type: 'toggle',
      },
      { key: 'statsBadge', label: "Show today's numbers in YouTube's top bar", type: 'toggle' },
      {
        key: 'dailyLimitMinutes',
        label: 'Daily watch goal / limit',
        type: 'select',
        options: [
          [0, 'None'],
          [30, '30 min'],
          [60, '1 hour'],
          [90, '1.5 hours'],
          [120, '2 hours'],
          [180, '3 hours'],
          [240, '4 hours'],
        ],
      },
    ],
  },
];
