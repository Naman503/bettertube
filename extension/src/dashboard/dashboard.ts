import { LIMIT_ICONS, limitStatus } from '../shared/limit';
import { STORAGE_KEY, withDefaults, type Settings } from '../shared/settings';
import { DAY_PREFIX, dayKey, fmtDuration, isCompleted, isWatched } from '../shared/stats';
import { installErrorCapture, track } from '../shared/track';
import { $, barList, bindTip, columnChart, el, fmtValue, heatLegend, heatLevel, svgIcon, type Kind, type Point, type Ref } from './charts';
import {
  LENGTH_BANDS,
  PRESETS,
  SPEED_BANDS,
  addDays,
  aggregate,
  buildStore,
  dateSpan,
  dayMetrics,
  fmtRangeDates,
  noon,
  resolveRange,
  shortDate,
  streaks,
  type Agg,
  type Range,
  type RangeSel,
  type Store,
  type VideoRow,
} from './data';

installErrorCapture('dashboard', ['dashboard.js']);

type Metric = 'watchMs' | 'savedMs' | 'videos' | 'speed';
const METRICS: Record<Metric, { title: string; kind: Kind }> = {
  watchMs: { title: 'Watch time per day', kind: 'time' },
  savedMs: { title: 'Time saved by speed per day', kind: 'time' },
  videos: { title: 'Videos watched per day', kind: 'count' },
  speed: { title: 'Average speed per day', kind: 'speed' },
};

let store: Store = buildStore({}, DAY_PREFIX);
let settings: Settings;
let sel: RangeSel = { preset: 'today' };
let metric: Metric = 'watchMs';
let videoSort: { key: 'when' | 'watched' | 'progress' | 'speed' | 'title'; dir: 1 | -1 } = { key: 'when', dir: -1 };
let videoQuery = '';
let videoLimit = 100;

const remember = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    // ignore
  }
};
const recall = <T>(k: string): T | null => {
  try {
    const raw = localStorage.getItem(k);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};

async function load() {
  store = buildStore(await chrome.storage.local.get(null), DAY_PREFIX);
  settings = withDefaults((await chrome.storage.sync.get(STORAGE_KEY))[STORAGE_KEY] as Partial<Settings> | undefined);
}

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const fmtHour = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });
/** Monday-first weekday names; index is JS getDay() (0 = Sunday). */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const weekdayName = (wd: number, style: 'short' | 'long' = 'short') => new Date(2024, 0, 7 + wd).toLocaleDateString(undefined, { weekday: style });

// ---------- tiles ----------

/** "▲ 12% vs previous 30 days" — neutral ink: more isn't better or worse. */
function delta(now: number, before: number | null, r: Range) {
  if (before === null || !r.previous) return null;
  const span = r.dates.length === 1 ? 'the day before' : `previous ${r.dates.length} days`;
  if (!before && !now) return null;
  if (!before) return el('div', { class: 'delta' }, `new vs ${span}`);
  const change = ((now - before) / before) * 100;
  const arrow = Math.abs(change) < 0.5 ? '→' : change > 0 ? '▲' : '▼';
  return el('div', { class: 'delta', title: `${span}: ${before.toLocaleString()}` }, `${arrow} ${Math.abs(change).toFixed(0)}% vs ${span}`);
}

function tile(label: string, value: string, sub: string, d: HTMLElement | null, cls = '', tip = '') {
  const t = el('div', { class: `tile ${cls}` }, el('div', { class: 'label' }, label), el('div', { class: 'value' }, value));
  if (sub) t.append(el('div', { class: 'sub' }, sub));
  if (d) t.append(d);
  if (tip) bindTip(t, tip);
  return t;
}

function renderTiles(a: Agg, p: Agg | null, r: Range) {
  const t = a.totals;
  const n = r.dates.length;
  const hero = tile('Watch time', fmtDuration(t.watchMs), n > 1 ? `${fmtDuration(t.watchMs / n)} a day on average` : 'videos actually playing', delta(t.watchMs, p?.totals.watchMs ?? null, r), 'hero');

  const limitMin = settings.dailyLimitMinutes;
  if (limitMin && n === 1) {
    const limit = limitStatus(t.watchMs, limitMin);
    hero.classList.add(`limit-${limit.level}`);
    hero.append(
      el(
        'div',
        { class: `limit ${limit.level}` },
        el('div', { class: 'bar' }, el('div', { class: 'fill', style: `width:${Math.min(100, limit.ratio * 100)}%` })),
        el('div', { class: 'status', role: limit.level === 'over' ? 'alert' : 'status' }, svgIcon(LIMIT_ICONS[limit.level === 'none' ? 'ok' : limit.level]), el('b', {}, limit.headline), el('span', {}, limit.detail)),
      ),
    );
  } else if (limitMin && n > 1) {
    const counted = r.dates.filter((d) => d <= dayKey());
    const over = counted.filter((d) => (store.days.get(d)?.watchMs ?? 0) >= limitMin * 60_000).length;
    const level = over === 0 ? 'ok' : over / counted.length > 0.25 ? 'over' : 'near';
    hero.append(
      el(
        'div',
        { class: `limit ${level} days` },
        el('div', { class: 'status' }, svgIcon(LIMIT_ICONS[level]), el('b', {}, over ? `Over your ${fmtDuration(limitMin * 60_000)} limit on ${over} of ${counted.length} days` : `Within your ${fmtDuration(limitMin * 60_000)} limit every day`)),
      ),
    );
  }

  const prevSpeed = p && p.avgSpeed ? p.avgSpeed : null;
  const completion = pct(a.completed, a.watched.length);
  const avgSession = t.sessions ? t.watchMs / t.sessions : 0;
  $('tiles').replaceChildren(
    hero,
    tile('Videos watched', a.watched.length.toLocaleString(), `${a.videos.length.toLocaleString()} opened`, delta(a.watched.length, p ? p.watched.length : null, r)),
    tile(
      'Saved by speed',
      fmtDuration(a.savedMs),
      `${fmtDuration(a.contentMs)} of video in ${fmtDuration(a.videoWatchMs)}`,
      delta(a.savedMs, p?.savedMs ?? null, r),
      'accent',
      'Saved by speed\nVideo you got through, minus the real time it took.\nAt 1× nothing is saved; at 2× an hour of video saves 30 minutes.',
    ),
    tile('Average speed', a.avgSpeed ? `${a.avgSpeed.toFixed(2)}×` : '—', 'video covered per minute watched', prevSpeed && a.avgSpeed ? el('div', { class: 'delta' }, `${a.avgSpeed >= prevSpeed ? '▲' : '▼'} ${Math.abs(a.avgSpeed - prevSpeed).toFixed(2)}× vs before`) : null),
    tile('Finished', `${completion}%`, `${a.completed} of ${a.watched.length} watched to the end`, null),
    tile('Time on YouTube', fmtDuration(t.activeMs), 'tab in front of you', delta(t.activeMs, p?.totals.activeMs ?? null, r)),
    tile('Sessions', t.sessions.toLocaleString(), avgSession ? `${fmtDuration(avgSession)} on average · longest ${fmtDuration(t.longestSessionMs)}` : '', null),
    tile('Channels', a.channels.length.toLocaleString(), a.channels[0] ? `most: ${a.channels[0].name}` : '', null),
  );
}

// ---------- trend ----------

interface Bucket {
  dates: string[];
  label: string;
  heading: string;
}

function trendBuckets(r: Range): Bucket[] {
  // One day selected: show the two weeks around it for context.
  const dates = r.dates.length === 1 ? dateSpan(addDays(r.to, -13), r.to) : r.dates;
  if (dates.length <= 92) {
    return dates.map((d) => ({
      dates: [d],
      label: shortDate(d, dates.length > 31 ? { month: 'short', day: 'numeric' } : { day: 'numeric' }),
      heading: shortDate(d, { weekday: 'short', month: 'short', day: 'numeric', year: d.slice(0, 4) === dayKey().slice(0, 4) ? undefined : 'numeric' }),
    }));
  }
  // Long ranges: one column per week (Monday start).
  const out: Bucket[] = [];
  for (const d of dates) {
    const wd = noon(d).getDay();
    if (!out.length || wd === 1) out.push({ dates: [], label: shortDate(d), heading: `Week of ${shortDate(d, { month: 'short', day: 'numeric', year: 'numeric' })}` });
    out.at(-1)!.dates.push(d);
  }
  return out;
}

function bucketMetrics(b: Bucket) {
  let watchMs = 0;
  let savedMs = 0;
  let videos = 0;
  let contentMs = 0;
  let videoMs = 0;
  for (const d of b.dates) {
    const day = store.days.get(d);
    const m = dayMetrics(day);
    watchMs += m.watchMs;
    savedMs += m.savedMs;
    videos += m.videos;
    if (day) {
      contentMs += day.contentSec * 1000;
      videoMs += Object.values(day.videos).reduce((s, v) => s + v.watchMs, 0);
    }
  }
  return { watchMs, savedMs, videos, speed: videoMs > 60_000 ? contentMs / videoMs : 0 };
}

function renderTrend(r: Range, a: Agg) {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#trend-metric button')) b.setAttribute('aria-selected', String(b.dataset.metric === metric));
  const buckets = trendBuckets(r);
  const weekly = buckets.some((b) => b.dates.length > 1);
  const { kind } = METRICS[metric];
  $('trend-title').textContent = METRICS[metric].title.replace('per day', weekly ? 'per week' : 'per day');
  const today = dayKey();
  const rows = buckets.map((b) => ({ b, m: bucketMetrics(b) }));
  const points: Point[] = rows.map(({ b, m }) => ({
    label: b.label,
    value: m[metric],
    tip: [
      b.heading,
      `${fmtDuration(m.watchMs)} watched`,
      `${fmtDuration(m.savedMs)} saved by speed`,
      `${plural(m.videos, 'video')}`,
      m.speed ? `${m.speed.toFixed(2)}× average speed` : 'no speed data',
    ].join('\n'),
    highlight: b.dates.includes(today) || (r.dates.length === 1 && b.dates.includes(r.to)),
  }));
  const refs: Ref[] = [];
  const withData = rows.filter(({ m }) => m.watchMs > 0);
  if (withData.length > 1) {
    const avg = metric === 'speed' ? a.avgSpeed : withData.reduce((s, { m }) => s + m[metric], 0) / withData.length;
    refs.push({ value: avg, label: 'Avg', cls: 'avg' });
  }
  if (metric === 'watchMs' && settings.dailyLimitMinutes && !weekly) refs.push({ value: settings.dailyLimitMinutes * 60_000, label: 'Limit', cls: 'limit' });
  const every = points.length > 45 ? Math.ceil(points.length / 12) : points.length > 20 ? 7 : points.length > 10 ? 2 : 1;
  $('trend-chart').replaceChildren(columnChart(points, { kind, labelEvery: every, refs, height: 220 }));

  const table = el(
    'table',
    {},
    el('tr', {}, el('th', {}, weekly ? 'Week' : 'Date'), el('th', { class: 'num' }, 'Watch time'), el('th', { class: 'num' }, 'Saved'), el('th', { class: 'num' }, 'Videos'), el('th', { class: 'num' }, 'Speed')),
  );
  for (const { b, m } of [...rows].reverse()) {
    if (!m.watchMs && !m.videos) continue;
    table.append(el('tr', {}, el('td', {}, b.heading), el('td', { class: 'num' }, fmtDuration(m.watchMs)), el('td', { class: 'num' }, fmtDuration(m.savedMs)), el('td', { class: 'num' }, String(m.videos)), el('td', { class: 'num' }, fmtValue(m.speed, 'speed'))));
  }
  $('trend-table').replaceChildren(table);
}

// ---------- calendar ----------

function renderCalendar(r: Range) {
  // At least 12 weeks so the pattern shows; the selected days stand out.
  const from = r.dates.length >= 84 ? r.from : addDays(r.to, -83);
  const start = addDays(from, -((noon(from).getDay() + 6) % 7)); // back to Monday
  const dates = dateSpan(start, r.to);
  const max = Math.max(0, ...dates.map((d) => store.days.get(d)?.watchMs ?? 0));
  $('calendar-caption').textContent = r.dates.length >= 84 ? 'watch time per day' : 'watch time per day · last 12 weeks, your selection highlighted';

  const weeks = Math.ceil(dates.length / 7);
  const grid = el('div', { class: 'calendar', style: `--weeks:${weeks}` });
  const months = el('div', { class: 'cal-months', style: `--weeks:${weeks}`, 'aria-hidden': 'true' });
  let lastMonth = '';
  for (let w = 0; w < weeks; w++) {
    const d = dates[w * 7];
    const m = d.slice(0, 7);
    months.append(el('span', {}, m !== lastMonth ? shortDate(d, { month: 'short' }) : ''));
    lastMonth = m;
  }
  const labels = el('div', { class: 'cal-days', 'aria-hidden': 'true' }, ...WEEK_ORDER.map((wd, i) => el('span', {}, i % 2 === 0 ? weekdayName(wd) : '')));
  for (const d of dates) {
    const day = store.days.get(d);
    const ms = day?.watchMs ?? 0;
    const inRange = d >= r.from && d <= r.to;
    const cell = el('div', { class: `cell l${heatLevel(ms, max)}${inRange ? '' : ' out'}` });
    const vids = day ? Object.values(day.videos).filter(isWatched).length : 0;
    bindTip(cell, `${shortDate(d, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}\n${ms ? `${fmtDuration(ms)} watched` : 'Nothing watched'}${vids ? `\n${plural(vids, 'video')}` : ''}`);
    grid.append(cell);
  }
  $('calendar').replaceChildren(el('div', { class: 'cal-wrap' }, el('div', {}), months, labels, grid), heatLegend());
}

// ---------- weekday × hour ----------

function renderWeekHour(a: Agg) {
  const max = Math.max(0, ...a.weekHour.flat());
  const grid = el('div', { class: 'weekhour' });
  for (const wd of WEEK_ORDER) {
    grid.append(el('div', { class: 'wh-label' }, weekdayName(wd)));
    for (let h = 0; h < 24; h++) {
      const ms = a.weekHour[wd][h];
      const cell = el('div', { class: `cell l${heatLevel(ms, max)}` });
      const perDay = a.weekdayCount[wd] ? ms / a.weekdayCount[wd] : 0;
      bindTip(cell, `${weekdayName(wd, 'long')} · ${fmtHour(h)}–${fmtHour((h + 1) % 24)}\n${fmtDuration(ms)} in total${perDay >= 1000 ? `\n${fmtDuration(perDay)} on an average ${weekdayName(wd, 'long')}` : ''}`);
      grid.append(cell);
    }
  }
  grid.append(el('div', {}));
  for (let h = 0; h < 24; h++) grid.append(el('div', { class: 'wh-hour' }, h % 3 === 0 ? fmtHour(h).replace(/\s?(AM|PM)/i, (m) => m.trim()[0].toLowerCase()) : ''));
  $('weekhour').replaceChildren(grid, heatLegend());
}

// ---------- small cards ----------

function renderWeekdays(a: Agg) {
  const points: Point[] = WEEK_ORDER.map((wd) => ({
    label: weekdayName(wd),
    value: a.weekdayAvgMs[wd],
    tip: `${weekdayName(wd, 'long')}\n${fmtDuration(a.weekdayAvgMs[wd])} on average\nover ${plural(a.weekdayCount[wd], weekdayName(wd, 'long'))}`,
    highlight: wd === 0 || wd === 6,
  }));
  $('weekdays').replaceChildren(columnChart(points, { kind: 'time', height: 160 }));
}

function renderSpeeds(a: Agg) {
  const total = a.speedMs.reduce((x, y) => x + y, 0);
  $('speeds').replaceChildren(
    barList(
      SPEED_BANDS.map(([label], i) => ({
        name: label,
        value: a.speedMs[i],
        text: `${pct(a.speedMs[i], total)}%`,
        tip: `${label}\n${fmtDuration(a.speedMs[i])} of watch time\n${pct(a.speedMs[i], total)}% of the total`,
      })),
      'No speed data in this range',
    ),
  );
}

function renderLengths(a: Agg) {
  $('lengths').replaceChildren(
    barList(
      LENGTH_BANDS.map(([label], i) => {
        const b = a.lengths[i];
        return {
          name: label,
          value: b.count,
          text: b.count ? `${b.count} · ${pct(b.completed, b.count)}% finished` : '0',
          tip: `${label}\n${plural(b.count, 'video')}, ${b.completed} finished\n${fmtDuration(b.ms)} watched`,
        };
      }),
      'No videos in this range',
    ),
  );
}

function kv(k: string, v: string, s = '') {
  return el('div', {}, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v), ...(s ? [el('div', { class: 's' }, s)] : []));
}

function renderHabits(a: Agg, r: Range) {
  const t = a.totals;
  const active = r.dates.filter((d) => (store.days.get(d)?.watchMs ?? 0) >= 60_000);
  const busiest = [...active].sort((x, y) => store.days.get(y)!.watchMs - store.days.get(x)!.watchMs)[0];
  const peakHour = t.hourlyWatchMs.indexOf(Math.max(...t.hourlyWatchMs));
  const weekendMs = [0, 6].reduce((s, wd) => s + a.weekHour[wd].reduce((x, y) => x + y, 0), 0);
  const lateMs = a.weekHour.reduce((s, row) => s + row.slice(0, 5).reduce((x, y) => x + y, 0), 0);
  const avgVideo = a.watched.length ? a.watched.reduce((s, v) => s + v.watchMs, 0) / a.watched.length : 0;
  const s = streaks(store);
  const weekendDays = r.dates.filter((d) => [0, 6].includes(noon(d).getDay())).length;
  $('habits').replaceChildren(
    kv('Current streak', plural(s.current, 'day'), `longest ever: ${plural(s.longest, 'day')}`),
    kv('Days you watched', `${active.length} / ${r.dates.length}`, `${pct(active.length, r.dates.length)}% of days`),
    kv('Busiest day', busiest ? fmtDuration(store.days.get(busiest)!.watchMs) : '—', busiest ? shortDate(busiest, { weekday: 'short', month: 'short', day: 'numeric' }) : ''),
    kv('Peak hour', t.watchMs ? `${fmtHour(peakHour)}–${fmtHour((peakHour + 1) % 24)}` : '—'),
    kv('Weekends', t.watchMs ? `${pct(weekendMs, t.watchMs)}%` : '—', weekendDays && r.dates.length > 6 ? `of watch time, on ${pct(weekendDays, r.dates.length)}% of days` : 'of watch time'),
    kv('Late night', t.watchMs ? `${pct(lateMs, t.watchMs)}%` : '—', `watched midnight–5am (${fmtDuration(lateMs)})`),
    kv('Time per video', fmtDuration(avgVideo), 'average'),
    kv('Searches', t.searches.toLocaleString(), t.adMs ? `ads: ${fmtDuration(t.adMs)}` : 'no ads played'),
  );
}

function renderChannels(a: Agg) {
  const rows = a.channels.slice(0, 10).map((c) => {
    const name = c.channelId ? el('a', { href: `https://www.youtube.com/channel/${c.channelId}`, target: '_blank', rel: 'noopener' }, c.name) : c.name;
    const speed = c.ms > 60_000 ? `${((c.contentSec * 1000) / c.ms).toFixed(2)}×` : '—';
    return {
      name,
      value: c.ms,
      text: fmtDuration(c.ms),
      tip: `${c.name}\n${fmtDuration(c.ms)} · ${plural(c.videos, 'video')}\n${c.completed} finished · ${speed} average`,
    };
  });
  $('channels').replaceChildren(barList(rows, 'No channels yet'));
}

function renderTopVideos(a: Agg) {
  const merged = new Map<string, VideoRow & { days: number }>();
  for (const v of a.watched) {
    const m = merged.get(v.id);
    if (m) {
      m.watchMs += v.watchMs;
      m.contentSec += v.contentSec;
      m.days++;
    } else merged.set(v.id, { ...v, days: 1 });
  }
  const rows = [...merged.values()]
    .sort((x, y) => y.watchMs - x.watchMs)
    .slice(0, 8)
    .map((v) => ({
      name: el('a', { href: `https://www.youtube.com/watch?v=${v.id}`, target: '_blank', rel: 'noopener', title: v.title }, v.title || v.id),
      value: v.watchMs,
      text: fmtDuration(v.watchMs),
      tip: `${v.title || v.id}\n${v.author}\n${fmtDuration(v.watchMs)} watched${v.days > 1 ? ` over ${v.days} days` : ''}`,
    }));
  $('top-videos').replaceChildren(barList(rows, 'No videos yet'));
}

function renderHealth(a: Agg) {
  const t = a.totals;
  const hours = t.watchMs / 3_600_000;
  const droppedPct = t.totalFrames ? (t.droppedFrames / t.totalFrames) * 100 : 0;
  const avgKbps = t.bandwidthSamples ? t.bandwidthKbpsSum / t.bandwidthSamples : 0;
  $('health').replaceChildren(
    kv('Buffering events', t.stalls.toLocaleString(), hours > 0.1 ? `${(t.stalls / hours).toFixed(1)} per hour watched` : ''),
    kv('Time buffering', fmtDuration(t.stallMs)),
    kv('Dropped frames', `${droppedPct.toFixed(2)}%`, `${t.droppedFrames.toLocaleString()} of ${t.totalFrames.toLocaleString()}`),
    kv('Avg connection', avgKbps ? `${(avgKbps / 1000).toFixed(1)} Mbps` : '—', 'as measured by the player'),
  );
  const share = (map: Record<string, number>, sort: (x: string, y: string) => number) => {
    const total = Object.values(map).reduce((x, y) => x + y, 0) || 1;
    return Object.entries(map)
      .sort(([x], [y]) => sort(x, y))
      .map(([k, ms]) => ({ name: k, value: ms, text: `${pct(ms, total)}%`, tip: `${k}\n${fmtDuration(ms)} watched` }));
  };
  $('resolutions').replaceChildren(barList(share(t.resolutionMs, (x, y) => parseInt(y) - parseInt(x)), 'No data yet'));
  $('codecs').replaceChildren(barList(share(t.codecMs, (x, y) => (t.codecMs[y] ?? 0) - (t.codecMs[x] ?? 0)), 'No data yet'));
}

// ---------- videos table ----------

const progressOf = (v: VideoRow) => (v.durationSec ? Math.min(100, Math.round((v.maxPosSec / v.durationSec) * 100)) : 0);
const speedOf = (v: VideoRow) => (v.watchMs > 5000 ? (v.contentSec * 1000) / v.watchMs : 0);

function renderVideos(a: Agg) {
  const q = videoQuery.trim().toLowerCase();
  const list = a.videos.filter((v) => !q || v.title.toLowerCase().includes(q) || v.author.toLowerCase().includes(q));
  const key = {
    when: (v: VideoRow) => v.lastAt,
    watched: (v: VideoRow) => v.watchMs,
    progress: progressOf,
    speed: speedOf,
    title: (v: VideoRow) => v.title.toLowerCase(),
  }[videoSort.key];
  list.sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0) * videoSort.dir);
  const rows = list.slice(0, videoLimit);
  $('videos-caption').textContent = `${a.watched.length.toLocaleString()} watched · ${a.videos.length.toLocaleString()} opened${q ? ` · ${list.length.toLocaleString()} match` : ''}`;

  const head = (label: string, k: typeof videoSort.key, num = false) => {
    const on = videoSort.key === k;
    const b = el('button', { class: 'sort', 'aria-label': `Sort by ${label}` }, label, on ? (videoSort.dir < 0 ? ' ↓' : ' ↑') : '');
    b.addEventListener('click', () => {
      videoSort = on ? { key: k, dir: (videoSort.dir * -1) as 1 | -1 } : { key: k, dir: k === 'title' ? 1 : -1 };
      renderVideos(a);
    });
    const th = el('th', num ? { class: 'num' } : {}, b);
    if (on) th.setAttribute('aria-sort', videoSort.dir < 0 ? 'descending' : 'ascending');
    return th;
  };
  const table = $('videos') as HTMLTableElement;
  table.replaceChildren(el('tr', {}, head('Video', 'title'), head('When', 'when'), head('Watched', 'watched', true), head('Progress', 'progress', true), head('Speed', 'speed', true)));
  for (const v of rows) {
    const p = progressOf(v);
    const s = speedOf(v);
    const link = el('a', { href: `https://www.youtube.com/watch?v=${v.id}&t=${Math.floor(v.maxPosSec)}s`, target: '_blank', rel: 'noopener' }, v.title || v.id);
    const when = new Date(v.lastAt);
    table.append(
      el(
        'tr',
        {},
        el('td', {}, link, el('div', { class: 'sub' }, v.author)),
        el('td', {}, el('div', {}, when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })), el('div', { class: 'sub' }, shortDate(v.date))),
        el('td', { class: 'num' }, fmtDuration(v.watchMs)),
        el('td', { class: 'num' }, el('span', { class: `pct${isCompleted(v) ? ' done' : ''}` }, el('i', { style: `width:${p}%` })), `${p}%`),
        el('td', { class: 'num' }, s ? `${s.toFixed(2)}×` : '—'),
      ),
    );
  }
  if (!rows.length) table.append(el('tr', {}, el('td', { colspan: '5', class: 'muted' }, q ? 'No videos match' : 'No videos in this range')));
  const more = $('videos-more');
  more.hidden = list.length <= videoLimit;
  more.textContent = `Show more (${(list.length - videoLimit).toLocaleString()} left)`;
}

// ---------- range picker ----------

function setRange(next: RangeSel) {
  sel = next;
  remember('bt-range-v2', sel);
  track('dashboard_range', { range: sel.preset });
  videoLimit = 100;
  render();
}

/** ‹ › move by the selection's own length (by month for month presets). */
function shift(dir: 1 | -1) {
  const r = resolveRange(sel, store.firstDay);
  if (sel.preset === 'month' || sel.preset === 'lastmonth' || (sel.preset === 'custom' && r.from.endsWith('-01') && addDays(r.to, 1).endsWith('-01'))) {
    const base = noon(r.from);
    base.setMonth(base.getMonth() + dir, 1);
    const from = dayKey(base);
    base.setMonth(base.getMonth() + 1, 0);
    setRange({ preset: 'custom', from, to: dayKey(base) });
    return;
  }
  const n = r.dates.length;
  setRange({ preset: 'custom', from: addDays(r.from, n * dir), to: addDays(r.to, n * dir) });
}

function renderPicker(r: Range) {
  $('range-label').textContent = sel.preset === 'custom' ? fmtRangeDates(r.from, r.to) : r.label;
  const today = dayKey();
  ($('range-next') as HTMLButtonElement).disabled = r.to >= today || sel.preset === 'all';
  ($('range-prev') as HTMLButtonElement).disabled = sel.preset === 'all' || (!!store.firstDay && r.from <= store.firstDay);
  const presets = $('range-presets');
  presets.replaceChildren(
    ...PRESETS.map(([p, label]) => {
      const preview = resolveRange({ preset: p }, store.firstDay);
      const on = sel.preset === p;
      const b = el(
        'button',
        { class: 'preset', role: 'option', 'aria-selected': String(on) },
        el('span', { class: 'check', 'aria-hidden': 'true' }, on ? '✓' : ''),
        el('span', { class: 'name' }, label),
        el('span', { class: 'when' }, fmtRangeDates(preview.from, preview.to).replace(/^\w+, /, '')),
      );
      b.addEventListener('click', () => {
        closePicker();
        setRange({ preset: p });
      });
      return b;
    }),
  );
  const fromIn = $('range-from') as HTMLInputElement;
  const toIn = $('range-to') as HTMLInputElement;
  fromIn.value = r.from;
  toIn.value = r.to;
  for (const i of [fromIn, toIn]) {
    i.max = today;
    if (store.firstDay) i.min = store.firstDay < today ? store.firstDay : today;
  }
}

function openPicker() {
  $('range-pop').hidden = false;
  $('range-btn').setAttribute('aria-expanded', 'true');
  $('range-presets').querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
}
function closePicker() {
  $('range-pop').hidden = true;
  $('range-btn').setAttribute('aria-expanded', 'false');
}

function bindPicker() {
  $('range-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    if ($('range-pop').hidden) openPicker();
    else closePicker();
  });
  document.addEventListener('click', (e) => {
    if (!$('range-pop').hidden && !(e.target as Element).closest('.picker')) closePicker();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('range-pop').hidden) {
      closePicker();
      $('range-btn').focus();
    }
  });
  $('range-presets').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...$('range-presets').querySelectorAll<HTMLElement>('.preset')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  });
  $('range-custom').addEventListener('submit', (e) => {
    e.preventDefault();
    const from = ($('range-from') as HTMLInputElement).value;
    const to = ($('range-to') as HTMLInputElement).value;
    const err = $('range-error');
    const problem = !from || !to ? 'Pick both dates' : from > to ? '"From" must be on or before "To"' : to > dayKey() ? "Can't pick a future date" : '';
    err.textContent = problem;
    err.hidden = !problem;
    if (problem) return;
    closePicker();
    setRange({ preset: 'custom', from, to });
  });
  $('range-prev').addEventListener('click', () => shift(-1));
  $('range-next').addEventListener('click', () => shift(1));
}

// ---------- page ----------

function render() {
  const r = resolveRange(sel, store.firstDay);
  renderPicker(r);
  $('range-caption').textContent = `${fmtRangeDates(r.from, r.to)}${r.dates.length > 1 ? ` · ${plural(r.dates.length, 'day')}` : ''}`;
  const empty = store.days.size === 0;
  $('empty').hidden = !empty;
  $('content').hidden = empty;
  if (empty) return;
  const a = aggregate(store, r.dates);
  const p = r.previous ? aggregate(store, r.previous.dates) : null;

  const note = $('stuck-note');
  note.hidden = a.stuckMs < 60_000;
  note.textContent = `Left out ${fmtDuration(a.stuckMs)} from ${plural(a.stuckVideos, 'video')} that YouTube reported as playing but that never moved (a frozen or forgotten tab). Older BetterTube versions counted that as watched; it's no longer counted.`;

  renderTiles(a, p, r);
  renderTrend(r, a);
  renderCalendar(r);
  renderWeekHour(a);
  renderWeekdays(a);
  renderSpeeds(a);
  renderLengths(a);
  renderHabits(a, r);
  renderChannels(a);
  renderTopVideos(a);
  renderHealth(a);
  renderVideos(a);
}

async function main() {
  await load();
  const saved = recall<RangeSel>('bt-range-v2');
  if (saved?.preset) sel = saved;
  else {
    // Ranges saved by the old segmented control.
    try {
      const old = localStorage.getItem('bt-range');
      if (old && PRESETS.some(([p]) => p === old)) sel = { preset: old as RangeSel['preset'] };
    } catch {
      // ignore
    }
  }
  const m = recall<Metric>('bt-metric');
  if (m && m in METRICS) metric = m;
  bindPicker();
  render();
  track('dashboard_view', { range: sel.preset });

  $('trend-metric').addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button[data-metric]');
    if (!b) return;
    metric = b.dataset.metric as Metric;
    remember('bt-metric', metric);
    render();
  });
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  $('video-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      videoQuery = (e.target as HTMLInputElement).value;
      videoLimit = 100;
      renderVideos(aggregate(store, resolveRange(sel, store.firstDay).dates));
    }, 150);
  });
  $('videos-more').addEventListener('click', () => {
    videoLimit += 200;
    renderVideos(aggregate(store, resolveRange(sel, store.firstDay).dates));
  });

  $('export').addEventListener('click', () => {
    track('stats_exported');
    const data = Object.fromEntries([...store.raw.entries()].sort());
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    el('a', { href: url, download: `bettertube-stats-${dayKey()}.json` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  $('clear').addEventListener('click', async () => {
    if (!confirm('Delete all BetterTube watch stats? This cannot be undone.')) return;
    track('stats_cleared');
    await chrome.storage.local.remove([...store.raw.keys()].map((d) => DAY_PREFIX + d));
    await load();
    render();
  });

  // Live updates while a video plays in another tab (keeps your scroll spot).
  let pending: ReturnType<typeof setTimeout> | undefined;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !Object.keys(changes).some((k) => k.startsWith(DAY_PREFIX))) return;
    clearTimeout(pending);
    pending = setTimeout(async () => {
      await load();
      render();
    }, 1500);
  });
}

void main();

