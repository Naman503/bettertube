// Watch statistics: one record per local calendar day in chrome.storage.local.
// Content scripts send a Tick every few seconds; the service worker merges
// ticks from all YouTube tabs so two open tabs don't double-count time.

export const DAY_PREFIX = 'stats:day:';
export const RETENTION_DAYS = 400;
/** A gap longer than this starts a new YouTube session. */
export const SESSION_GAP_MS = 30 * 60_000;

export interface VideoStat {
  title: string;
  author: string;
  channelId: string;
  durationSec: number;
  /** Real time spent playing it. */
  watchMs: number;
  /** Video time consumed (exceeds watchMs when sped up). */
  contentSec: number;
  maxPosSec: number;
  firstAt: number;
  lastAt: number;
}

export interface DayStats {
  date: string; // YYYY-MM-DD, local
  /** YouTube tab visible and you active (or a video playing). */
  activeMs: number;
  /** A video playing in any YouTube tab (ads excluded). */
  watchMs: number;
  adMs: number;
  contentSec: number;
  hourlyWatchMs: number[]; // 24 buckets, local hour
  videos: Record<string, VideoStat>;
  sessions: number;
  longestSessionMs: number;
  stalls: number;
  stallMs: number;
  droppedFrames: number;
  totalFrames: number;
  resolutionMs: Record<string, number>;
  codecMs: Record<string, number>;
  bandwidthKbpsSum: number;
  bandwidthSamples: number;
  searches: number;
}

export interface TickVideo {
  id: string;
  title: string;
  author: string;
  channelId: string;
  durationSec: number;
  posSec: number;
  contentDeltaSec: number;
}

export interface Tick {
  type: 'stats:tick';
  at: number;
  /** ms since this tab's previous tick */
  dt: number;
  active: boolean;
  playing: boolean;
  adPlaying: boolean;
  video: TickVideo | null;
  stalls: number;
  stallMs: number;
  droppedFrames: number;
  totalFrames: number;
  resolution: string | null;
  codec: string | null;
  bandwidthKbps: number | null;
  searches: number;
}

export function dayKey(t: number | Date = Date.now()) {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function emptyDay(date: string): DayStats {
  return {
    date,
    activeMs: 0,
    watchMs: 0,
    adMs: 0,
    contentSec: 0,
    hourlyWatchMs: Array(24).fill(0),
    videos: {},
    sessions: 0,
    longestSessionMs: 0,
    stalls: 0,
    stallMs: 0,
    droppedFrames: 0,
    totalFrames: 0,
    resolutionMs: {},
    codecMs: {},
    bandwidthKbpsSum: 0,
    bandwidthSamples: 0,
    searches: 0,
  };
}

/** Counts as watched as soon as it has played at all. */
export const isWatched = (v: VideoStat) => v.watchMs > 0 || v.contentSec > 0;

export const isCompleted = (v: VideoStat) => v.durationSec > 0 && v.maxPosSec >= v.durationSec * 0.9;

/** 1h 42m · 12m · 45s */
export function fmtDuration(ms: number) {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin === 0) return `${Math.round(ms / 1000)}s`;
  // Under 10 min, keep the seconds so small numbers add up (1m 50s, not 1m).
  if (totalMin < 10) {
    const sec = Math.floor((ms % 60_000) / 1000);
    return sec ? `${totalMin}m ${sec}s` : `${totalMin}m`;
  }
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

/** Totals for the in-page badge and popup. */
export function summarize(day: DayStats | undefined) {
  if (!day) return { videos: 0, watchMs: 0, activeMs: 0, savedMs: 0, adMs: 0 };
  const videos = Object.values(day.videos);
  const videoWatchMs = videos.reduce((a, v) => a + v.watchMs, 0);
  return {
    videos: videos.filter(isWatched).length,
    watchMs: day.watchMs,
    activeMs: day.activeMs,
    savedMs: Math.max(0, day.contentSec * 1000 - videoWatchMs),
    adMs: day.adMs,
  };
}
