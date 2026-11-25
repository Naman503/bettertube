import { easepick, LockPlugin, PresetPlugin, RangePlugin } from '@easepick/bundle';
import { LIMIT_ICONS, limitStatus } from '../shared/limit';
import { STORAGE_KEY, withDefaults, type Settings } from '../shared/settings';
import { DAY_PREFIX, dayKey, fmtDuration, isCompleted, isWatched } from '../shared/stats';
import { installErrorCapture, track } from '../shared/track';
import { $, bindTip, el, fmtAxis, fmtValue, svgIcon, type Kind } from './charts';
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
import { chart, disposeAll, esc, tokens, tooltipBase, type EChartsOption, type Tokens } from './echarts';

installErrorCapture('dashboard', ['dashboard.js']);

type Metric = 'watchMs' | 'savedMs' | 'videos' | 'speed';
const METRICS: Record<Metric, { title: string; kind: Kind; caption: string; color: number }> = {
  watchMs: { title: 'Watch time', kind: 'time', caption: 'time videos were actually playing', color: 0 },
  savedMs: { title: 'Time saved by speed', kind: 'time', caption: 'video covered minus the real time it took', color: 2 },
  videos: { title: 'Videos watched', kind: 'count', caption: 'videos that played at all', color: 1 },
  speed: { title: 'Average speed', kind: 'speed', caption: 'video covered per minute watched', color: 3 },
};

/** Speed bands are ordered, so one hue light → dark (dark mode: dark → light). */
const SPEED_RAMP = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
const SPEED_RAMP_DARK = ['#184f95', '#1c5cab', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'];

let store: Store = buildStore({}, DAY_PREFIX);
let settings: Settings;
let sel: RangeSel = { preset: 'today' };
let metric: Metric = 'watchMs';
let videoSort: { key: 'when' | 'watched' | 'progress' | 'speed' | 'title'; dir: 1 | -1 } = { key: 'when', dir: -1 };
let videoQuery = '';
let videoLimit = 25;

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
const shortHour = (h: number) => fmtHour(h).replace(/\s?(AM|PM)/i, (m) => m.trim()[0].toLowerCase());
const isDark = () => matchMedia('(prefers-color-scheme: dark)').matches;
/** Monday-first; values are JS getDay() (0 = Sunday). */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const weekdayName = (wd: number, style: 'short' | 'long' = 'short') => new Date(2024, 0, 7 + wd).toLocaleDateString(undefined, { weekday: style });
/** Heat level thresholds (share of max) on a square-root scale: one huge day doesn't wash out the rest. */
const HEAT_STEPS = [0.04, 0.16, 0.36, 0.64, 1];

function heatPieces(t: Tokens, max: number) {
  const pieces: { min?: number; max?: number; value?: number; color: string }[] = [{ value: 0, color: t.seq[0] }];
  let lo = 0;
  HEAT_STEPS.forEach((s, i) => {
    pieces.push({ min: lo + 1e-9, max: Math.max(max * s, lo + 2e-9), color: t.seq[i + 1] });
    lo = max * s;
  });
  return pieces;
}

function heatLegend(host: HTMLElement, t: Tokens) {
  host.replaceChildren(el('span', {}, 'Less'), ...t.seq.map((c) => el('i', { style: `background:${c}` })), el('span', {}, 'More'));
}

const axisTooltip = (t: Tokens) => ({
  ...tooltipBase(t),
  trigger: 'axis' as const,
  axisPointer: { type: 'shadow' as const, shadowStyle: { color: t.grid, opacity: 0.7 } },
});

/** Round time-axis steps (5m, 15m, 30m, 1h, 2h…) so labels read 1h, 2h, not 50m, 150m. */
const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720, 1440, 2880, 7200].map((m) => m * 60_000);
function timeAxis(maxValue: number) {
  const interval = TIME_STEPS.find((s) => maxValue / s <= 4) ?? TIME_STEPS.at(-1)!;
  return { interval, max: Math.max(interval, Math.ceil(maxValue / interval) * interval) };
}

const barGradient = (c: string) => ({ type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: c }, { offset: 1, color: `${c}99` }] });

// ---------- periods ----------

interface Bucket {
  dates: string[];
  label: string;
  heading: string;
}

/** One column per day, or per week (Monday start) past ~3 months. */
function bucketsFor(dates: string[]): Bucket[] {
  if (dates.length <= 92) {
    return dates.map((d) => ({
      dates: [d],
      label: shortDate(d, { month: 'short', day: 'numeric' }),
      heading: shortDate(d, { weekday: 'short', month: 'short', day: 'numeric', year: d.slice(0, 4) === dayKey().slice(0, 4) ? undefined : 'numeric' }),
    }));
  }
  const out: Bucket[] = [];
  for (const d of dates) {
    if (!out.length || noon(d).getDay() === 1) out.push({ dates: [], label: shortDate(d), heading: `Week of ${shortDate(d, { month: 'short', day: 'numeric', year: 'numeric' })}` });
    out.at(-1)!.dates.push(d);
  }
  return out;
}

function metricsOf(dates: string[]) {
  let watchMs = 0;
  let savedMs = 0;
  let videos = 0;
  let contentMs = 0;
  let videoMs = 0;
  for (const d of dates) {
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

/** Dates for sparklines and the trend: a single day gets the two weeks up to it. */
const trendDates = (r: Range) => (r.dates.length === 1 ? dateSpan(addDays(r.to, -13), r.to) : r.dates);

// ---------- KPI cards ----------

function deltaPill(now: number, before: number | null, kind: Kind, r: Range) {
  if (before === null || !r.previous || (!before && !now)) return null;
  const span = r.dates.length === 1 ? 'the day before' : `the previous ${r.dates.length} days`;
  if (kind === 'speed') {
    if (!now || !before) return null;
    const d = now - before;
    return el('span', { class: 'pill', title: `${before.toFixed(2)}× in ${span}` }, `${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(2)}×`);
  }
  if (!before) return el('span', { class: 'pill', title: `nothing in ${span}` }, 'new');
  const change = ((now - before) / before) * 100;
  const arrow = Math.abs(change) < 0.5 ? '→' : change > 0 ? '▲' : '▼';
  return el('span', { class: 'pill', title: `${fmtValue(before, kind)} in ${span}` }, `${arrow} ${Math.abs(change).toFixed(0)}%`);
}

function sparkOption(t: Tokens, buckets: Bucket[], values: (number | null)[], color: string, kind: Kind): EChartsOption {
  return {
    grid: { left: 0, right: 0, top: 6, bottom: 0 },
    xAxis: { type: 'category', show: false, data: buckets.map((b) => b.heading), boundaryGap: false },
    yAxis: { type: 'value', show: false, min: 0 },
    tooltip: {
      ...tooltipBase(t),
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: t.baseline } },
      formatter: (p: unknown) => {
        const x = (p as { name: string; value: number }[])[0];
        return `<b>${esc(fmtValue(x.value ?? 0, kind))}</b><br><span style="opacity:.75">${esc(x.name)}</span>`;
      },
    },
    series: [
      {
        type: 'line',
        data: values,
        smooth: 0.35,
        symbol: 'none',
        connectNulls: true,
        lineStyle: { width: 2, color },
        areaStyle: {
          color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: `${color}55` }, { offset: 1, color: `${color}00` }] },
        },
      },
    ],
  };
}

function renderKpis(t: Tokens, a: Agg, p: Agg | null, r: Range) {
  const buckets = bucketsFor(trendDates(r));
  const series = buckets.map((b) => metricsOf(b.dates));
  const n = r.dates.length;
  const cards: { label: string; color: string; value: string; sub: string; delta: HTMLElement | null; values: (number | null)[]; kind: Kind; extra?: HTMLElement; cls?: string }[] = [
    {
      label: 'Watch time',
      color: t.series[0],
      value: fmtDuration(a.totals.watchMs),
      sub: n > 1 ? `${fmtDuration(a.totals.watchMs / n)} a day on average` : 'videos actually playing',
      delta: deltaPill(a.totals.watchMs, p?.totals.watchMs ?? null, 'time', r),
      values: series.map((m) => m.watchMs),
      kind: 'time',
    },
    {
      label: 'Saved by speed',
      color: t.series[2],
      value: fmtDuration(a.savedMs),
      sub: `${fmtDuration(a.contentMs)} of video in ${fmtDuration(a.videoWatchMs)}`,
      delta: deltaPill(a.savedMs, p?.savedMs ?? null, 'time', r),
      values: series.map((m) => m.savedMs),
      kind: 'time',
    },
    {
      label: 'Videos watched',
      color: t.series[1],
      value: a.watched.length.toLocaleString(),
      sub: n > 1 ? `${(a.watched.length / n).toFixed(1)} a day · ${a.videos.length.toLocaleString()} opened` : `${a.videos.length.toLocaleString()} opened`,
      delta: deltaPill(a.watched.length, p ? p.watched.length : null, 'count', r),
      values: series.map((m) => m.videos),
      kind: 'count',
    },
    {
      label: 'Average speed',
      color: t.series[3],
      value: a.avgSpeed ? `${a.avgSpeed.toFixed(2)}×` : '—',
      sub: 'video covered per minute watched',
      delta: deltaPill(a.avgSpeed, p ? p.avgSpeed : null, 'speed', r),
      values: series.map((m) => m.speed || null),
      kind: 'speed',
    },
  ];

  // Daily limit: progress for one day, days over for a range.
  const limitMin = settings.dailyLimitMinutes;
  if (limitMin) {
    if (n === 1) {
      const limit = limitStatus(a.totals.watchMs, limitMin);
      const level = limit.level === 'none' ? 'ok' : limit.level;
      cards[0].cls = `limit-${level}`;
      cards[0].extra = el(
        'div',
        { class: `limit ${level}` },
        el('div', { class: 'bar' }, el('div', { class: 'fill', style: `width:${Math.min(100, limit.ratio * 100)}%` })),
        el('div', { class: 'status', role: level === 'over' ? 'alert' : 'status' }, svgIcon(LIMIT_ICONS[level]), `${limit.headline} · ${limit.detail}`),
      );
    } else {
      const counted = r.dates.filter((d) => d <= dayKey());
      const over = counted.filter((d) => (store.days.get(d)?.watchMs ?? 0) >= limitMin * 60_000).length;
      const level = over === 0 ? 'ok' : over / counted.length > 0.25 ? 'over' : 'near';
      cards[0].extra = el(
        'div',
        { class: `limit ${level}` },
        el('div', { class: 'status' }, svgIcon(LIMIT_ICONS[level]), over ? `Over your ${fmtDuration(limitMin * 60_000)} limit on ${over} of ${counted.length} days` : `Within your ${fmtDuration(limitMin * 60_000)} limit every day`),
      );
    }
  }

  const host = $('kpis');
  host.replaceChildren();
  for (const c of cards) {
    const spark = el('div', { class: 'spark' });
    const card = el(
      'div',
      { class: `kpi ${c.cls ?? ''}`, style: `--c:${c.color}` },
      el('div', { class: 'kpi-head' }, el('span', { class: 'kpi-label' }, el('i'), c.label), ...(c.delta ? [c.delta] : [])),
      el('div', { class: 'kpi-value' }, c.value),
      el('div', { class: 'kpi-sub' }, c.sub),
    );
    if (c.extra) card.append(c.extra);
    card.append(spark);
    host.append(card);
    chart(spark, sparkOption(t, buckets, c.values, c.color, c.kind));
  }
}

function renderStats(a: Agg, r: Range) {
  const t = a.totals;
  const s = streaks(store);
  const avgSession = t.sessions ? t.watchMs / t.sessions : 0;
  const stat = (k: string, v: string, sub: string, tip = '') => {
    const node = el('div', { class: 'stat' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v), el('div', { class: 's' }, sub));
    if (tip) bindTip(node, tip);
    return node;
  };
  const active = r.dates.filter((d) => (store.days.get(d)?.watchMs ?? 0) >= 60_000).length;
  $('stats').replaceChildren(
    stat('Time on YouTube', fmtDuration(t.activeMs), 'tab in front of you'),
    stat('Finished', `${pct(a.completed, a.watched.length)}%`, `${a.completed} of ${a.watched.length} to the end`),
    stat('Sessions', t.sessions.toLocaleString(), avgSession ? `${fmtDuration(avgSession)} on average` : '—', `Sessions\nLongest: ${fmtDuration(t.longestSessionMs)}`),
    stat('Channels', a.channels.length.toLocaleString(), a.channels[0] ? `most: ${a.channels[0].name}` : '—'),
    stat('Days you watched', `${active} / ${r.dates.length}`, `${pct(active, r.dates.length)}% of days`),
    stat('Streak', plural(s.current, 'day'), `longest ${plural(s.longest, 'day')}`),
  );
}

// ---------- trend ----------

function renderTrend(t: Tokens, r: Range, a: Agg) {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#trend-metric button')) b.setAttribute('aria-selected', String(b.dataset.metric === metric));
  const buckets = bucketsFor(trendDates(r));
  const weekly = buckets.some((b) => b.dates.length > 1);
  const { kind, title, caption } = METRICS[metric];
  $('trend-title').textContent = `${title} ${weekly ? 'per week' : 'per day'}`;
  const rows = buckets.map((b) => ({ b, m: metricsOf(b.dates) }));
  const pick = (m: ReturnType<typeof metricsOf>) => (kind === 'speed' ? m.speed || null : m[metric]);

  // The same stretch just before, for comparison (same length, same columns).
  const prevRows = r.previous && r.dates.length > 1 ? bucketsFor(r.previous.dates).map((b) => metricsOf(b.dates)) : null;
  const showPrev = !!prevRows && prevRows.length === rows.length && prevRows.some((m) => m.watchMs > 0);
  $('trend-caption').textContent = `${caption}${showPrev ? ' · dashed line: the period before' : ''}`;

  const avg =
    rows.filter(({ m }) => m.watchMs > 0).length > 1 ? (metric === 'speed' ? a.avgSpeed : rows.reduce((s, { m }) => s + m[metric], 0) / rows.length) : 0;
  const marks: object[] = [];
  if (avg) marks.push({ yAxis: avg, name: 'Average', lineStyle: { color: t.muted, type: 'dashed', width: 1 }, label: { formatter: `Avg ${fmtValue(avg, kind)}`, position: 'insideStartTop', color: t.muted, fontSize: 11 } });
  if (metric === 'watchMs' && settings.dailyLimitMinutes && !weekly) {
    marks.push({ yAxis: settings.dailyLimitMinutes * 60_000, name: 'Daily limit', lineStyle: { color: t.critical, type: 'dashed', width: 1 }, label: { formatter: `Limit ${fmtDuration(settings.dailyLimitMinutes * 60_000)}`, position: 'insideEndTop', color: t.critical, fontSize: 11 } });
  }
  const today = dayKey();
  const c = t.series[METRICS[metric].color];
  const zoom = rows.length > 60;
  const top = Math.max(0, ...rows.map(({ m }) => (kind === 'speed' ? m.speed : m[metric])), ...(showPrev ? prevRows!.map((m) => (kind === 'speed' ? m.speed : m[metric])) : []), ...marks.map((x) => (x as { yAxis: number }).yAxis));

  chart($('trend-chart'), {
    grid: { left: 8, right: 8, top: 24, bottom: zoom ? 44 : 8, containLabel: true },
    tooltip: {
      ...axisTooltip(t),
      formatter: (params: unknown) => {
        const i = (params as { dataIndex: number }[])[0].dataIndex;
        const { b, m } = rows[i];
        const prev = showPrev ? prevRows![i] : null;
        const line = (label: string, v: string, strong: boolean) =>
          `<div style="display:flex;justify-content:space-between;gap:18px"><span style="opacity:.7">${label}</span><span style="font-weight:${strong ? 700 : 500}">${esc(v)}</span></div>`;
        return [
          `<div style="font-weight:600;margin-bottom:4px">${esc(b.heading)}</div>`,
          line('Watch time', fmtDuration(m.watchMs), metric === 'watchMs'),
          line('Time saved', fmtDuration(m.savedMs), metric === 'savedMs'),
          line('Videos', String(m.videos), metric === 'videos'),
          line('Speed', fmtValue(m.speed, 'speed'), metric === 'speed'),
          prev ? `<div style="margin-top:4px;opacity:.7">Period before: ${esc(fmtValue(kind === 'speed' ? prev.speed : prev[metric], kind))}</div>` : '',
        ].join('');
      },
    },
    xAxis: {
      type: 'category',
      data: buckets.map((b) => b.label),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: t.baseline } },
      axisLabel: { color: t.muted, fontSize: 11, hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      min: 0,
      splitNumber: 4,
      splitLine: { lineStyle: { color: t.grid } },
      axisLabel: { color: t.muted, fontSize: 11, formatter: (v: number) => fmtAxis(kind === 'time' ? Math.round(v) : v, kind) },
      ...(kind === 'time' ? timeAxis(top) : kind === 'count' ? { minInterval: 1 } : {}),
    },
    dataZoom: zoom
      ? [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 6, borderColor: 'transparent', backgroundColor: t.grid, fillerColor: `${c}33`, showDetail: false, brushSelect: false }]
      : [],
    series: [
      {
        name: title,
        type: 'bar',
        barMaxWidth: 28,
        data: rows.map(({ b, m }) => ({
          value: pick(m),
          itemStyle: m.watchMs > 0 && (b.dates.includes(today) || (r.dates.length === 1 && b.dates.includes(r.to))) ? { borderWidth: 2, borderColor: t.fg } : {},
        })),
        itemStyle: { borderRadius: [5, 5, 0, 0], color: barGradient(c) },
        emphasis: { itemStyle: { color: c } },
        markLine: marks.length ? { symbol: 'none', silent: true, data: marks } : undefined,
      },
      ...(showPrev
        ? [{ name: 'Period before', type: 'line', data: prevRows!.map(pick), symbol: 'none', smooth: true, smoothMonotone: 'x', lineStyle: { color: t.muted, width: 1.5, type: 'dashed' }, itemStyle: { color: t.muted }, z: 3 }]
        : []),
    ],
  });

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

function renderCalendar(t: Tokens, r: Range) {
  // Short selections get context: back to your first week of data (up to ~6
  // months, at least 12 weeks); the selection stays bright.
  const sinceFirst = store.firstDay ? dateSpan(store.firstDay, r.to).length : 0;
  const span = Math.max(r.dates.length, Math.min(182, Math.max(84, sinceFirst + 7)));
  const from = r.dates.length >= span ? r.from : addDays(r.to, -(span - 1));
  const dates = dateSpan(from, r.to);
  const max = Math.max(0, ...dates.map((d) => store.days.get(d)?.watchMs ?? 0));
  $('calendar-caption').textContent = r.dates.length >= span ? 'watch time per day' : `watch time per day · last ${Math.round(span / 7)} weeks, your selection highlighted`;
  heatLegend($('calendar-legend'), t);
  const weeks = Math.ceil(dates.length / 7) + 1;
  const host = $('calendar');
  // Square cells sized to the space left of the summary (or the full card on narrow screens).
  const card = host.parentElement!.clientWidth || 1000;
  const narrow = card < 860;
  const room = narrow ? card : card - 320;
  const cell = Math.max(10, Math.min(26, Math.floor((room - 50) / weeks)));
  host.style.width = narrow ? '100%' : `${cell * weeks + 50}px`;
  host.style.height = `${cell * 7 + 34}px`;

  // Beside it: the selection in four numbers.
  const inSel = r.dates.map((d) => store.days.get(d)?.watchMs ?? 0);
  const watchedDays = inSel.filter((ms) => ms >= 60_000);
  let run = 0;
  let bestRun = 0;
  for (const ms of inSel) {
    run = ms >= 60_000 ? run + 1 : 0;
    bestRun = Math.max(bestRun, run);
  }
  const bestIdx = inSel.indexOf(Math.max(0, ...inSel));
  $('calendar-summary').replaceChildren(
    habit('Days watched', `${watchedDays.length} of ${r.dates.length}`, `${pct(watchedDays.length, r.dates.length)}% of days`),
    habit('Best day', inSel[bestIdx] ? fmtDuration(inSel[bestIdx]) : '—', inSel[bestIdx] ? shortDate(r.dates[bestIdx], { weekday: 'short', month: 'short', day: 'numeric' }) : ''),
    habit('On days you watch', watchedDays.length ? fmtDuration(watchedDays.reduce((x, y) => x + y, 0) / watchedDays.length) : '—', 'average'),
    habit('Longest run', plural(bestRun, 'day'), 'in a row, in this range'),
  );
  chart(host, {
    tooltip: {
      ...tooltipBase(t),
      formatter: (p: unknown) => {
        const [d, ms] = (p as { value: [string, number] }).value;
        const day = store.days.get(d);
        const vids = day ? Object.values(day.videos).filter(isWatched).length : 0;
        return `<b>${esc(ms ? fmtDuration(ms) : 'Nothing watched')}</b>${vids ? ` · ${esc(plural(vids, 'video'))}` : ''}<br><span style="opacity:.75">${esc(shortDate(d, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }))}</span>`;
      },
    },
    visualMap: { type: 'piecewise', show: false, dimension: 1, pieces: heatPieces(t, max), outOfRange: { color: t.seq[0] } },
    calendar: {
      range: [from, r.to],
      top: 22,
      left: 40,
      cellSize: [cell, cell],
      splitLine: { show: false },
      yearLabel: { show: false },
      // nameMap is Sunday-first whatever the first day is; label Mon, Wed, Fri.
      dayLabel: { firstDay: 1, nameMap: [0, 1, 2, 3, 4, 5, 6].map((wd) => (wd % 2 === 1 ? weekdayName(wd) : '')), color: t.muted, fontSize: 11 },
      monthLabel: { color: t.muted, fontSize: 11, nameMap: Array.from({ length: 12 }, (_, m) => new Date(2024, m, 1).toLocaleDateString(undefined, { month: 'short' })) },
      itemStyle: { color: t.seq[0], borderColor: t.surface, borderWidth: 3 },
    },
    series: [
      {
        type: 'heatmap',
        coordinateSystem: 'calendar',
        data: dates.map((d) => ({ value: [d, store.days.get(d)?.watchMs ?? 0], itemStyle: { opacity: d >= r.from && d <= r.to ? 1 : 0.35, borderRadius: 4 } })),
      },
    ],
  });
}

// ---------- weekday × hour, weekdays ----------

function renderWeekHour(t: Tokens, a: Agg) {
  const max = Math.max(0, ...a.weekHour.flat());
  heatLegend($('weekhour-legend'), t);
  const rows = [...WEEK_ORDER].reverse(); // Monday on top
  const data: [number, number, number][] = [];
  rows.forEach((wd, y) => {
    for (let h = 0; h < 24; h++) data.push([h, y, a.weekHour[wd][h]]);
  });
  chart($('weekhour'), {
    grid: { left: 4, right: 4, top: 4, bottom: 4, containLabel: true },
    tooltip: {
      ...tooltipBase(t),
      formatter: (p: unknown) => {
        const [h, y, ms] = (p as { value: [number, number, number] }).value;
        const wd = rows[y];
        const perDay = a.weekdayCount[wd] ? ms / a.weekdayCount[wd] : 0;
        return `<b>${esc(fmtDuration(ms))}</b> in total${perDay >= 1000 ? `<br>${esc(fmtDuration(perDay))} on an average ${esc(weekdayName(wd, 'long'))}` : ''}<br><span style="opacity:.75">${esc(weekdayName(wd, 'long'))} · ${esc(fmtHour(h))}–${esc(fmtHour((h + 1) % 24))}</span>`;
      },
    },
    xAxis: { type: 'category', data: Array.from({ length: 24 }, (_, h) => shortHour(h)), axisTick: { show: false }, axisLine: { show: false }, axisLabel: { color: t.muted, fontSize: 11, interval: 2 } },
    yAxis: { type: 'category', data: rows.map((wd) => weekdayName(wd)), axisTick: { show: false }, axisLine: { show: false }, axisLabel: { color: t.muted, fontSize: 11 } },
    visualMap: { type: 'piecewise', show: false, dimension: 2, pieces: heatPieces(t, max) },
    series: [{ type: 'heatmap', data, itemStyle: { borderColor: t.surface, borderWidth: 3, borderRadius: 5 }, emphasis: { itemStyle: { borderColor: t.fg, borderWidth: 1 } } }],
  });
}

function renderWeekdays(t: Tokens, a: Agg) {
  chart($('weekdays'), {
    grid: { left: 4, right: 4, top: 12, bottom: 4, containLabel: true },
    tooltip: {
      ...axisTooltip(t),
      formatter: (p: unknown) => {
        const wd = WEEK_ORDER[(p as { dataIndex: number }[])[0].dataIndex];
        return `<b>${esc(fmtDuration(a.weekdayAvgMs[wd]))}</b> on average<br><span style="opacity:.75">${esc(weekdayName(wd, 'long'))} · over ${esc(plural(a.weekdayCount[wd], 'day'))}</span>`;
      },
    },
    xAxis: { type: 'category', data: WEEK_ORDER.map((wd) => weekdayName(wd)), axisTick: { show: false }, axisLine: { lineStyle: { color: t.baseline } }, axisLabel: { color: t.muted, fontSize: 11 } },
    yAxis: { type: 'value', min: 0, ...timeAxis(Math.max(0, ...a.weekdayAvgMs)), splitLine: { lineStyle: { color: t.grid } }, axisLabel: { color: t.muted, fontSize: 11, formatter: (v: number) => fmtAxis(Math.round(v), 'time') } },
    series: [{ type: 'bar', barMaxWidth: 26, data: WEEK_ORDER.map((wd) => a.weekdayAvgMs[wd]), itemStyle: { borderRadius: [5, 5, 0, 0], color: barGradient(t.series[0]) } }],
  });
}

// ---------- speed, length ----------

function renderSpeeds(t: Tokens, a: Agg) {
  const total = a.speedMs.reduce((x, y) => x + y, 0);
  const ramp = isDark() ? SPEED_RAMP_DARK : SPEED_RAMP;
  const items = SPEED_BANDS.map(([label], i) => ({ name: label, value: a.speedMs[i], itemStyle: { color: ramp[i] } })).filter((x) => x.value > 0);
  chart($('speeds'), {
    tooltip: {
      ...tooltipBase(t),
      formatter: (p: unknown) => {
        const x = p as { name: string; value: number; percent: number };
        return `<b>${Math.round(x.percent)}%</b> of watch time<br><span style="opacity:.75">${esc(x.name)} · ${esc(fmtDuration(x.value))}</span>`;
      },
    },
    series: [
      {
        type: 'pie',
        radius: ['64%', '90%'],
        padAngle: 2,
        itemStyle: { borderRadius: 6 },
        label: { show: false },
        emphasis: { scale: true, scaleSize: 4 },
        data: items.length ? items : [{ name: 'No data', value: 1, itemStyle: { color: t.seq[0] } }],
      },
    ],
  });
  $('speeds-center').replaceChildren(el('b', {}, a.avgSpeed ? `${a.avgSpeed.toFixed(2)}×` : '—'), el('span', {}, 'average'));
  $('speeds-legend').replaceChildren(
    ...SPEED_BANDS.map(([label], i) => el('li', {}, el('i', { style: `background:${ramp[i]}` }), el('span', {}, label), el('b', {}, `${pct(a.speedMs[i], total)}%`))),
  );
}

function renderLengths(t: Tokens, a: Agg) {
  chart($('lengths'), {
    grid: { left: 4, right: 16, top: 30, bottom: 4, containLabel: true },
    legend: { top: 0, left: 0, itemWidth: 10, itemHeight: 10, icon: 'roundRect', textStyle: { color: t.muted, fontSize: 12 }, data: ['Finished', 'Not finished'] },
    tooltip: {
      ...axisTooltip(t),
      formatter: (p: unknown) => {
        const i = (p as { dataIndex: number }[])[0].dataIndex;
        const b = a.lengths[i];
        return `<b>${esc(plural(b.count, 'video'))}</b> · ${pct(b.completed, b.count)}% finished<br><span style="opacity:.75">${esc(LENGTH_BANDS[i][0])} · ${esc(fmtDuration(b.ms))} watched</span>`;
      },
    },
    xAxis: { type: 'value', minInterval: 1, splitLine: { lineStyle: { color: t.grid } }, axisLabel: { color: t.muted, fontSize: 11 } },
    yAxis: { type: 'category', inverse: true, data: LENGTH_BANDS.map(([l]) => l), axisTick: { show: false }, axisLine: { show: false }, axisLabel: { color: t.fg, fontSize: 12 } },
    series: [
      { name: 'Finished', type: 'bar', stack: 'n', data: a.lengths.map((b) => b.completed), barMaxWidth: 22, itemStyle: { color: t.series[2], borderRadius: [4, 0, 0, 4] } },
      { name: 'Not finished', type: 'bar', stack: 'n', data: a.lengths.map((b) => b.count - b.completed), barMaxWidth: 22, itemStyle: { color: t.baseline, borderRadius: [0, 4, 4, 0] } },
    ],
  });
}

// ---------- habits, lists ----------

function habit(k: string, v: string, s = '') {
  return el('div', { class: 'habit' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v), el('div', { class: 's' }, s || ' '));
}

function renderHabits(a: Agg, r: Range) {
  const t = a.totals;
  const active = r.dates.filter((d) => (store.days.get(d)?.watchMs ?? 0) >= 60_000);
  const busiest = [...active].sort((x, y) => store.days.get(y)!.watchMs - store.days.get(x)!.watchMs)[0];
  const peakHour = t.hourlyWatchMs.indexOf(Math.max(...t.hourlyWatchMs));
  const weekendMs = [0, 6].reduce((s, wd) => s + a.weekHour[wd].reduce((x, y) => x + y, 0), 0);
  const lateMs = a.weekHour.reduce((s, row) => s + row.slice(0, 5).reduce((x, y) => x + y, 0), 0);
  const avgVideo = a.watched.length ? a.watched.reduce((s, v) => s + v.watchMs, 0) / a.watched.length : 0;
  $('habits').replaceChildren(
    habit('Busiest day', busiest ? fmtDuration(store.days.get(busiest)!.watchMs) : '—', busiest ? shortDate(busiest, { weekday: 'short', month: 'short', day: 'numeric' }) : ''),
    habit('Peak hour', t.watchMs ? shortHour(peakHour) : '—', t.watchMs ? `${fmtHour(peakHour)}–${fmtHour((peakHour + 1) % 24)}` : ''),
    habit('Weekends', t.watchMs ? `${pct(weekendMs, t.watchMs)}%` : '—', 'of watch time'),
    habit('Late night', t.watchMs ? `${pct(lateMs, t.watchMs)}%` : '—', `midnight–5am · ${fmtDuration(lateMs)}`),
    habit('Time per video', fmtDuration(avgVideo), 'average'),
    habit('Searches', t.searches.toLocaleString(), t.adMs ? `ads: ${fmtDuration(t.adMs)}` : 'no ads played'),
  );
}

function rankList(host: HTMLElement, items: { name: Node; meta: string; value: number; text: string; tip: string }[], empty: string) {
  if (!items.length) {
    host.replaceChildren(el('li', { class: 'rank-empty' }, empty));
    return;
  }
  const max = Math.max(...items.map((i) => i.value)) || 1;
  host.replaceChildren(
    ...items.map((it, i) => {
      const li = el(
        'li',
        {},
        el('span', { class: 'n' }, String(i + 1)),
        el('div', { class: 'body' }, it.name, el('div', { class: 'meta' }, it.meta), el('div', { class: 'track' }, el('i', { style: `width:${(it.value / max) * 100}%` }))),
        el('span', { class: 'val' }, it.text),
      );
      bindTip(li, it.tip);
      return li;
    }),
  );
}

function renderChannels(a: Agg) {
  rankList(
    $('channels'),
    a.channels.slice(0, 8).map((c) => {
      const speed = c.ms > 60_000 ? `${((c.contentSec * 1000) / c.ms).toFixed(2)}×` : '—';
      return {
        name: c.channelId ? el('a', { class: 'name', href: `https://www.youtube.com/channel/${c.channelId}`, target: '_blank', rel: 'noopener' }, c.name) : el('span', { class: 'name' }, c.name),
        meta: `${plural(c.videos, 'video')} · ${speed} · ${pct(c.completed, c.videos)}% finished`,
        value: c.ms,
        text: fmtDuration(c.ms),
        tip: `${c.name}\n${fmtDuration(c.ms)} watched\n${plural(c.videos, 'video')}, ${c.completed} finished · ${speed} average`,
      };
    }),
    'No channels in this range',
  );
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
  rankList(
    $('top-videos'),
    [...merged.values()]
      .sort((x, y) => y.watchMs - x.watchMs)
      .slice(0, 8)
      .map((v) => ({
        name: el('a', { class: 'name', href: `https://www.youtube.com/watch?v=${v.id}`, target: '_blank', rel: 'noopener' }, v.title || v.id),
        meta: `${v.author}${v.days > 1 ? ` · over ${v.days} days` : ''}`,
        value: v.watchMs,
        text: fmtDuration(v.watchMs),
        tip: `${v.title || v.id}\n${v.author}\n${fmtDuration(v.watchMs)} watched`,
      })),
    'No videos in this range',
  );
}

function barList(host: HTMLElement, map: Record<string, number>, sort: (x: string, y: string) => number) {
  const total = Object.values(map).reduce((x, y) => x + y, 0);
  if (!total) {
    host.replaceChildren(el('p', { class: 'rank-empty' }, 'No data yet'));
    return;
  }
  const max = Math.max(...Object.values(map));
  host.replaceChildren(
    el(
      'div',
      { class: 'hbars' },
      ...Object.entries(map)
        .sort(([x], [y]) => sort(x, y))
        .map(([k, ms]) => {
          const row = el('div', { class: 'hbar' }, el('div', { class: 'name' }, k), el('div', { class: 'track' }, el('div', { class: 'fill', style: `width:${(ms / max) * 100}%` })), el('div', { class: 'val' }, `${pct(ms, total)}%`));
          bindTip(row, `${k}\n${fmtDuration(ms)} watched`);
          return row;
        }),
    ),
  );
}

function renderHealth(a: Agg) {
  const t = a.totals;
  const hours = t.watchMs / 3_600_000;
  const droppedPct = t.totalFrames ? (t.droppedFrames / t.totalFrames) * 100 : 0;
  const avgKbps = t.bandwidthSamples ? t.bandwidthKbpsSum / t.bandwidthSamples : 0;
  $('health').replaceChildren(
    habit('Buffering', t.stalls.toLocaleString(), hours > 0.1 ? `${(t.stalls / hours).toFixed(1)} per hour watched` : ''),
    habit('Time buffering', fmtDuration(t.stallMs)),
    habit('Dropped frames', `${droppedPct.toFixed(2)}%`, `${t.droppedFrames.toLocaleString()} of ${t.totalFrames.toLocaleString()}`),
    habit('Connection', avgKbps ? `${(avgKbps / 1000).toFixed(1)} Mbps` : '—', 'as measured by the player'),
  );
  // Players report odd window-fitted heights (1364p, 1152p…): group into the usual tiers.
  const tiers: [string, number][] = [['4K', 2160], ['1440p', 1440], ['1080p', 1080], ['720p', 720], ['480p', 480], ['360p', 360], ['Lower', 0]];
  const byTier: Record<string, number> = {};
  for (const [k, ms] of Object.entries(t.resolutionMs)) {
    const h = parseInt(k) || 0;
    const tier = tiers.find(([, min]) => h >= min * 0.9)![0];
    byTier[tier] = (byTier[tier] ?? 0) + ms;
  }
  const order = tiers.map(([n]) => n);
  barList($('resolutions'), byTier, (x, y) => order.indexOf(x) - order.indexOf(y));
  barList($('codecs'), t.codecMs, (x, y) => (t.codecMs[y] ?? 0) - (t.codecMs[x] ?? 0));
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
    const when = new Date(v.lastAt);
    table.append(
      el(
        'tr',
        {},
        el('td', {}, el('a', { href: `https://www.youtube.com/watch?v=${v.id}&t=${Math.floor(v.maxPosSec)}s`, target: '_blank', rel: 'noopener' }, v.title || v.id), el('div', { class: 'sub' }, v.author)),
        el('td', {}, el('div', {}, when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })), el('div', { class: 'sub' }, shortDate(v.date))),
        el('td', { class: 'num' }, fmtDuration(v.watchMs)),
        el('td', { class: 'num' }, el('span', { class: `prog${isCompleted(v) ? ' done' : ''}` }, el('i', {}, el('b', { style: `width:${p}%` })), `${p}%`)),
        el('td', { class: 'num' }, s ? `${s.toFixed(2)}×` : '—'),
      ),
    );
  }
  if (!rows.length) table.append(el('tr', {}, el('td', { colspan: '5', class: 'sub' }, q ? 'No videos match' : 'No videos in this range')));
  const more = $('videos-more');
  more.hidden = list.length <= videoLimit;
  more.textContent = `Show more (${(list.length - videoLimit).toLocaleString()} left)`;
}

// ---------- date range ----------

let picker: InstanceType<typeof easepick.create> | null = null;

function setRange(next: RangeSel) {
  sel = next;
  remember('bt-range-v2', sel);
  track('dashboard_range', { range: sel.preset });
  videoLimit = 25;
  render();
}

/** Back/forward by the selection's own length (by month for month presets). */
function shift(dir: 1 | -1) {
  const r = resolveRange(sel, store.firstDay);
  const wholeMonth = r.from.endsWith('-01') && addDays(r.to, 1).endsWith('-01');
  if (sel.preset === 'month' || sel.preset === 'lastmonth' || (sel.preset === 'custom' && wholeMonth)) {
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

function renderRangeControls(r: Range) {
  const one = r.dates.length === 1;
  $('range-label').textContent = sel.preset === 'custom' ? (one ? shortDate(r.from, { weekday: 'short', month: 'short', day: 'numeric' }) : 'Custom') : r.label;
  $('range-dates').textContent = one ? (sel.preset === 'custom' ? '' : shortDate(r.from, { month: 'short', day: 'numeric' })) : fmtRangeDates(r.from, r.to);
  ($('range-next') as HTMLButtonElement).disabled = r.to >= dayKey() || sel.preset === 'all';
  ($('range-prev') as HTMLButtonElement).disabled = sel.preset === 'all' || (!!store.firstDay && r.from <= store.firstDay);
  picker?.setDateRange(noon(r.from), noon(r.to));
}

function initPicker() {
  const presetRanges = Object.fromEntries(
    PRESETS.map(([p, label]) => {
      const r = resolveRange({ preset: p }, store.firstDay);
      return [label, [noon(r.from), noon(r.to)]];
    }),
  );
  picker = new easepick.create({
    element: $('range-anchor'),
    css: ['vendor/easepick.css', 'easepick-theme.css'],
    plugins: [RangePlugin, PresetPlugin, LockPlugin],
    calendars: matchMedia('(max-width: 760px)').matches ? 1 : 2,
    grid: 2,
    firstDay: 1,
    zIndex: 40,
    format: 'D MMM YYYY',
    RangePlugin: { tooltip: true, delimiter: ' – ' },
    PresetPlugin: { customPreset: presetRanges, position: 'left' },
    LockPlugin: { maxDate: new Date() },
    setup(p) {
      // Right-align the calendar under the date button and keep it on screen.
      p.on('show', () =>
        requestAnimationFrame(() => {
          const c = p.ui.container;
          const btn = $('range-btn').getBoundingClientRect();
          const box = c.getBoundingClientRect();
          const left = Math.max(8, btn.right - box.width) - box.left;
          c.style.left = `${(parseFloat(c.style.left) || 0) + left}px`;
          c.style.top = `${(parseFloat(c.style.top) || 0) + btn.bottom + 8 - box.top}px`;
        }),
      );
      p.on('select', (e: Event) => {
        const { start, end } = (e as CustomEvent<{ start: Date; end: Date }>).detail;
        const from = dayKey(start);
        const to = dayKey(end);
        // A preset's dates: remember the preset itself so it keeps rolling.
        const match = PRESETS.find(([p2]) => {
          const r = resolveRange({ preset: p2 }, store.firstDay);
          return r.from === from && r.to === to;
        });
        setRange(match ? { preset: match[0] } : { preset: 'custom', from, to });
      });
    },
  });
  // Opens under the date button (the anchor sits at its bottom-right corner).
  $('range-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (picker!.isShown()) picker!.hide();
    else picker!.show();
  });
  $('range-prev').addEventListener('click', () => shift(-1));
  $('range-next').addEventListener('click', () => shift(1));
}

// ---------- page ----------

function render() {
  const r = resolveRange(sel, store.firstDay);
  renderRangeControls(r);
  $('range-caption').textContent = `${fmtRangeDates(r.from, r.to)}${r.dates.length > 1 ? ` · ${plural(r.dates.length, 'day')}` : ''}`;
  const empty = store.days.size === 0;
  $('empty').hidden = !empty;
  $('content').hidden = empty;
  if (empty) return;
  const t = tokens();
  const a = aggregate(store, r.dates);
  const p = r.previous ? aggregate(store, r.previous.dates) : null;

  $('stuck-note').hidden = a.stuckMs < 60_000;
  $('stuck-text').textContent = `Left out ${fmtDuration(a.stuckMs)} from ${plural(a.stuckVideos, 'video')} that YouTube reported as playing but that never moved (a frozen or forgotten tab). Older BetterTube versions counted that as watched; it's no longer counted.`;

  renderKpis(t, a, p, r);
  renderStats(a, r);
  renderTrend(t, r, a);
  renderCalendar(t, r);
  renderWeekHour(t, a);
  renderWeekdays(t, a);
  renderSpeeds(t, a);
  renderLengths(t, a);
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
  initPicker();
  render();
  track('dashboard_view', { range: sel.preset });

  // Light/dark switch: charts are drawn in the theme's colours, so redraw.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    disposeAll();
    render();
  });
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderCalendar(tokens(), resolveRange(sel, store.firstDay)), 200);
  });

  $('trend-metric').addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button[data-metric]');
    if (!b) return;
    metric = b.dataset.metric as Metric;
    remember('bt-metric', metric);
    const r = resolveRange(sel, store.firstDay);
    renderTrend(tokens(), r, aggregate(store, r.dates));
  });
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  $('video-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      videoQuery = (e.target as HTMLInputElement).value;
      videoLimit = 25;
      renderVideos(aggregate(store, resolveRange(sel, store.firstDay).dates));
    }, 150);
  });
  $('videos-more').addEventListener('click', () => {
    videoLimit += 50;
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

  // Live updates while a video plays in another tab.
  let pending: ReturnType<typeof setTimeout> | undefined;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !Object.keys(changes).some((k) => k.startsWith(DAY_PREFIX))) return;
    clearTimeout(pending);
    pending = setTimeout(async () => {
      await load();
      render();
    }, 2000);
  });
}

void main();
