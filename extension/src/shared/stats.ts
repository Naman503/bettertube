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
/**
 * Before 0.8.0 a video YouTube reported as playing but that never moved (a
 * frozen or stuck tab) counted as watched, sometimes for 10+ hours a day.
 * Such a video has lots of watch time and almost no video covered.
 */
export const isStuck = (v: VideoStat) => v.watchMs >= 5 * 60_000 && v.contentSec * 1000 < v.watchMs * 0.1;

/** A day with stuck playback taken out, plus how much was taken out. */
export function cleanDay(day: DayStats): { day: DayStats; stuckMs: number; stuckVideos: number } {
  const stuck = Object.entries(day.videos).filter(([, v]) => isStuck(v));
  if (!stuck.length) return { day, stuckMs: 0, stuckVideos: 0 };
  const videos = { ...day.videos };
  let stuckMs = 0;
  for (const [id, v] of stuck) {
    // Keep whatever really played (counted at 1×), drop the frozen time.
    const kept = Math.min(v.watchMs, v.contentSec * 1000);
    stuckMs += v.watchMs - kept;
    videos[id] = { ...v, watchMs: kept };
  }
  // Day watch time is the union across tabs; it can't exceed what the
  // remaining videos played.
  const videoMs = Object.values(videos).reduce((a, v) => a + v.watchMs, 0);
  const watchMs = Math.min(day.watchMs, videoMs);
  const scale = day.watchMs ? watchMs / day.watchMs : 0;
  return {
    day: {
      ...day,
      videos,
      watchMs,
      hourlyWatchMs: day.hourlyWatchMs.map((ms) => ms * scale),
      longestSessionMs: Math.min(day.longestSessionMs, Math.max(watchMs, day.activeMs)),
    },
    stuckMs: day.watchMs - watchMs,
    stuckVideos: stuck.length,
  };
}

export function summarize(raw: DayStats | undefined) {
  const day = raw && cleanDay(raw).day;
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
