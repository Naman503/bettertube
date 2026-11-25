// Dashboard data: loading, date ranges, and the numbers every chart reads.
import { cleanDay, dayKey, emptyDay, isCompleted, isWatched, type DayStats, type VideoStat } from '../shared/stats';

export const DAY_MS = 86_400_000;

// ---------- dates ----------

/** Noon of a YYYY-MM-DD day, so DST shifts never land on another date. */
export const noon = (d: string) => new Date(`${d}T12:00:00`);
export const addDays = (d: string, n: number) => dayKey(noon(d).getTime() + n * DAY_MS);
export const daysBetween = (from: string, to: string) => Math.round((noon(to).getTime() - noon(from).getTime()) / DAY_MS);

/** Every date from `from` to `to`, inclusive. */
export function dateSpan(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export const shortDate = (d: string, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }) =>
  noon(d).toLocaleDateString(undefined, opts);

export type Preset = 'today' | 'yesterday' | '7' | '30' | '90' | 'month' | 'lastmonth' | 'year' | 'all' | 'custom';

export interface RangeSel {
  preset: Preset;
  /** custom only */
  from?: string;
  to?: string;
}

export const PRESETS: [Preset, string][] = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['7', 'Last 7 days'],
  ['30', 'Last 30 days'],
  ['90', 'Last 90 days'],
  ['month', 'This month'],
  ['lastmonth', 'Last month'],
  ['year', 'This year'],
  ['all', 'All time'],
];

export interface Range {
  from: string;
  to: string;
  dates: string[];
  label: string;
  /** Same length, just before; null for "All time". */
  previous: { from: string; to: string; dates: string[] } | null;
}

export function resolveRange(sel: RangeSel, firstDay: string | undefined): Range {
  const today = dayKey();
  const first = firstDay && firstDay < today ? firstDay : today;
  let from = today;
  let to = today;
  const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
  switch (sel.preset) {
    case 'yesterday':
      from = to = addDays(today, -1);
      break;
    case '7':
    case '30':
    case '90':
      from = addDays(today, -(Number(sel.preset) - 1));
      break;
    case 'month':
      from = monthStart(today);
      break;
    case 'lastmonth':
      to = addDays(monthStart(today), -1);
      from = monthStart(to);
      break;
    case 'year':
      from = `${today.slice(0, 4)}-01-01`;
      break;
    case 'all':
      from = first;
      break;
    case 'custom':
      from = sel.from ?? today;
      to = sel.to ?? today;
      if (from > to) [from, to] = [to, from];
      if (to > today) to = today;
      break;
  }
  const dates = dateSpan(from, to);
  const label = PRESETS.find(([p]) => p === sel.preset)?.[1] ?? (from === to ? shortDate(from, { weekday: 'short', month: 'short', day: 'numeric' }) : 'Custom range');
  let previous: Range['previous'] = null;
  if (sel.preset !== 'all') {
    const pTo = addDays(from, -1);
    const pFrom = addDays(pTo, -(dates.length - 1));
    previous = { from: pFrom, to: pTo, dates: dateSpan(pFrom, pTo) };
  }
  return { from, to, dates, label, previous };
}

export const fmtRangeDates = (from: string, to: string) => {
  const sameYear = from.slice(0, 4) === to.slice(0, 4) && from.slice(0, 4) === dayKey().slice(0, 4);
  const opts: Intl.DateTimeFormatOptions = sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' };
  return from === to ? shortDate(from, { weekday: 'long', month: 'long', day: 'numeric' }) : `${shortDate(from, opts)} – ${shortDate(to, opts)}`;
};

// ---------- loading ----------

export interface Store {
  /** Cleaned days (stuck playback taken out). */
  days: Map<string, DayStats>;
  /** Raw days as stored, for export. */
  raw: Map<string, DayStats>;
  /** Stuck playback taken out, per day. */
  stuck: Map<string, { ms: number; videos: number }>;
  firstDay: string | undefined;
}

export function buildStore(all: Record<string, unknown>, prefix: string): Store {
  const raw = new Map<string, DayStats>();
  for (const [k, v] of Object.entries(all)) if (k.startsWith(prefix)) raw.set(k.slice(prefix.length), v as DayStats);
  const days = new Map<string, DayStats>();
  const stuck = new Map<string, { ms: number; videos: number }>();
  for (const [d, day] of raw) {
    const c = cleanDay(day);
    days.set(d, c.day);
    if (c.stuckMs > 0) stuck.set(d, { ms: c.stuckMs, videos: c.stuckVideos });
  }
  return { days, raw, stuck, firstDay: [...raw.keys()].sort()[0] };
}

// ---------- aggregation ----------

export interface VideoRow extends VideoStat {
  id: string;
  date: string;
}

export interface Channel {
  name: string;
  channelId: string;
  ms: number;
  contentSec: number;
  videos: number;
  completed: number;
}

export const SPEED_BANDS: [label: string, max: number][] = [
  ['Under 1×', 0.95],
  ['1×', 1.05],
  ['1–1.5×', 1.5],
  ['1.5–2×', 2],
  ['2–2.5×', 2.5],
  ['2.5–3×', 3],
  ['3× and up', Infinity],
];

export const LENGTH_BANDS: [label: string, maxSec: number][] = [
  ['Under 5 min', 5 * 60],
  ['5–20 min', 20 * 60],
  ['20–60 min', 60 * 60],
  ['1 hour +', Infinity],
];

export function aggregate(store: Store, dates: string[]) {
  const t = emptyDay('range');
  const videos: VideoRow[] = [];
  const channels = new Map<string, Channel>();
  /** [weekday 0=Sun][hour] watch ms */
  const weekHour = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
  const weekdayMs = Array(7).fill(0) as number[];
  const weekdayCount = Array(7).fill(0) as number[];
  let stuckMs = 0;
  let stuckVideos = 0;
  for (const date of dates) {
    const wd = noon(date).getDay();
    weekdayCount[wd]++;
    const d = store.days.get(date);
    const st = store.stuck.get(date);
    if (st) {
      stuckMs += st.ms;
      stuckVideos += st.videos;
    }
    if (!d) continue;
    weekdayMs[wd] += d.watchMs;
    t.activeMs += d.activeMs;
    t.watchMs += d.watchMs;
    t.adMs += d.adMs;
    t.contentSec += d.contentSec;
    t.sessions += d.sessions;
    t.longestSessionMs = Math.max(t.longestSessionMs, d.longestSessionMs);
    t.stalls += d.stalls;
    t.stallMs += d.stallMs;
    t.droppedFrames += d.droppedFrames;
    t.totalFrames += d.totalFrames;
    t.bandwidthKbpsSum += d.bandwidthKbpsSum;
    t.bandwidthSamples += d.bandwidthSamples;
    t.searches += d.searches;
    d.hourlyWatchMs.forEach((ms, h) => {
      t.hourlyWatchMs[h] += ms;
      weekHour[wd][h] += ms;
    });
    for (const [k, ms] of Object.entries(d.resolutionMs)) t.resolutionMs[k] = (t.resolutionMs[k] ?? 0) + ms;
    for (const [k, ms] of Object.entries(d.codecMs)) t.codecMs[k] = (t.codecMs[k] ?? 0) + ms;
    for (const [id, v] of Object.entries(d.videos)) {
      videos.push({ ...v, id, date });
      if (!isWatched(v)) continue;
      const key = v.channelId || v.author;
      const c = channels.get(key) ?? { name: v.author || 'Unknown', channelId: v.channelId, ms: 0, contentSec: 0, videos: 0, completed: 0 };
      c.ms += v.watchMs;
      c.contentSec += v.contentSec;
      c.videos++;
      if (isCompleted(v)) c.completed++;
      channels.set(key, c);
    }
  }
  const watched = videos.filter(isWatched);
  const videoWatchMs = videos.reduce((a, v) => a + v.watchMs, 0);
  const contentMs = t.contentSec * 1000;

  // Time spent at each speed (real time), from each video's average speed.
  const speedMs = SPEED_BANDS.map(() => 0);
  for (const v of watched) {
    if (v.watchMs < 5000) continue;
    const speed = (v.contentSec * 1000) / v.watchMs;
    speedMs[SPEED_BANDS.findIndex(([, max]) => speed < max)] += v.watchMs;
  }
  const lengths = LENGTH_BANDS.map(() => ({ count: 0, ms: 0, completed: 0 }));
  for (const v of watched) {
    if (!v.durationSec) continue;
    const b = lengths[LENGTH_BANDS.findIndex(([, max]) => v.durationSec < max)];
    b.count++;
    b.ms += v.watchMs;
    if (isCompleted(v)) b.completed++;
  }

  return {
    totals: t,
    videos: videos.sort((a, b) => b.lastAt - a.lastAt),
    watched,
    completed: watched.filter(isCompleted).length,
    channels: [...channels.values()].sort((a, b) => b.ms - a.ms),
    /** Real time saved: video covered minus the time it took. */
    savedMs: Math.max(0, contentMs - videoWatchMs),
    contentMs,
    videoWatchMs,
    avgSpeed: videoWatchMs > 0 ? contentMs / videoWatchMs : 0,
    weekHour,
    weekdayAvgMs: weekdayMs.map((ms, i) => (weekdayCount[i] ? ms / weekdayCount[i] : 0)),
    weekdayCount,
    speedMs,
    lengths,
    stuckMs,
    stuckVideos,
  };
}

export type Agg = ReturnType<typeof aggregate>;

/** Per-day numbers for the trend chart. */
export function dayMetrics(d: DayStats | undefined) {
  if (!d) return { watchMs: 0, savedMs: 0, videos: 0, speed: 0 };
  const vids = Object.values(d.videos);
  const videoMs = vids.reduce((a, v) => a + v.watchMs, 0);
  return {
    watchMs: d.watchMs,
    savedMs: Math.max(0, d.contentSec * 1000 - videoMs),
    videos: vids.filter(isWatched).length,
    speed: videoMs > 60_000 ? (d.contentSec * 1000) / videoMs : 0,
  };
}

/** Days in a row with 1m+ watched, ending today (or yesterday). */
export function streaks(store: Store) {
  const watchedOn = (d: string) => (store.days.get(d)?.watchMs ?? 0) >= 60_000;
  let current = 0;
  let d = dayKey();
  if (!watchedOn(d)) d = addDays(d, -1);
  while (watchedOn(d)) {
    current++;
    d = addDays(d, -1);
  }
  let longest = 0;
  let run = 0;
  if (store.firstDay) {
    for (const day of dateSpan(store.firstDay, dayKey())) {
      run = watchedOn(day) ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
  }
  return { current, longest };
}
