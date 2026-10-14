import { STORAGE_KEY, withDefaults, type Settings } from '../shared/settings';
import {
  DAY_PREFIX,
  dayKey,
  emptyDay,
  fmtDuration,
  isCompleted,
  isWatched,
  type DayStats,
  type VideoStat,
} from '../shared/stats';

type Range = 'today' | '7' | '30' | '90' | 'all';

const $ = (id: string) => document.getElementById(id)!;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.setAttribute('style', v);
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

let days = new Map<string, DayStats>();
let settings: Settings;
let range: Range = 'today';

async function load() {
  const all = await chrome.storage.local.get(null);
  days = new Map(
    Object.entries(all)
      .filter(([k]) => k.startsWith(DAY_PREFIX))
      .map(([k, v]) => [k.slice(DAY_PREFIX.length), v as DayStats]),
  );
  settings = withDefaults((await chrome.storage.sync.get(STORAGE_KEY))[STORAGE_KEY] as Partial<Settings> | undefined);
}

// ---------- dates ----------

const DAY_MS = 86_400_000;

function lastNDates(n: number): string[] {
  const out: string[] = [];
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  for (let i = n - 1; i >= 0; i--) out.push(dayKey(today.getTime() - i * DAY_MS));
  return out;
}

function datesFor(r: Range): string[] {
  if (r === 'today') return lastNDates(1);
  if (r === 'all') {
    const first = [...days.keys()].sort()[0];
    if (!first) return lastNDates(1);
    const span = Math.round((Date.parse(dayKey()) - Date.parse(first)) / DAY_MS) + 1;
    return lastNDates(Math.max(1, span));
  }
  return lastNDates(Number(r));
}

const shortDate = (d: string, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }) =>
  new Date(`${d}T12:00:00`).toLocaleDateString(undefined, opts);

// ---------- aggregation ----------

interface VideoRow extends VideoStat {
  id: string;
  date: string;
}

function aggregate(dates: string[]) {
  const t = emptyDay('range');
  const videos: VideoRow[] = [];
  const channels = new Map<string, { name: string; channelId: string; ms: number; count: number }>();
  for (const date of dates) {
    const d = days.get(date);
    if (!d) continue;
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
    d.hourlyWatchMs.forEach((ms, h) => (t.hourlyWatchMs[h] += ms));
    for (const [k, ms] of Object.entries(d.resolutionMs)) t.resolutionMs[k] = (t.resolutionMs[k] ?? 0) + ms;
    for (const [k, ms] of Object.entries(d.codecMs)) t.codecMs[k] = (t.codecMs[k] ?? 0) + ms;
    for (const [id, v] of Object.entries(d.videos)) {
      videos.push({ ...v, id, date });
      if (!isWatched(v)) continue;
      const key = v.channelId || v.author;
      const c = channels.get(key) ?? { name: v.author || 'Unknown', channelId: v.channelId, ms: 0, count: 0 };
      c.ms += v.watchMs;
      c.count++;
      channels.set(key, c);
    }
  }
  const watched = videos.filter(isWatched);
  const videoWatchMs = videos.reduce((a, v) => a + v.watchMs, 0);
  return {
    totals: t,
    videos: videos.sort((a, b) => b.lastAt - a.lastAt),
    watched,
    completed: watched.filter(isCompleted).length,
    channels: [...channels.values()].sort((a, b) => b.ms - a.ms),
    savedMs: Math.max(0, t.contentSec * 1000 - videoWatchMs),
    /** Video covered (at 1× this is how long it would have taken). */
    contentMs: t.contentSec * 1000,
    /** Real time those videos actually played. */
    videoWatchMs,
    avgSpeed: videoWatchMs > 0 ? (t.contentSec * 1000) / videoWatchMs : 1,
  };
}

// ---------- tooltip ----------

const tooltip = $('tooltip');
function bindTip(target: HTMLElement, text: string) {
  target.tabIndex = 0;
  target.setAttribute('aria-label', text.replace(/\n/g, ', '));
  const show = (x: number, y: number) => {
    tooltip.textContent = text;
    tooltip.hidden = false;
    const r = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.min(window.innerWidth - r.width - 8, Math.max(8, x - r.width / 2))}px`;
    tooltip.style.top = `${Math.max(8, y - r.height - 12)}px`;
  };
  target.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
  target.addEventListener('pointerleave', () => (tooltip.hidden = true));
  target.addEventListener('focus', () => {
    const r = target.getBoundingClientRect();
    show(r.left + r.width / 2, r.top);
  });
  target.addEventListener('blur', () => (tooltip.hidden = true));
}

// ---------- charts ----------

/** A "nice" axis max and step for durations (ms). */
function timeScale(maxMs: number) {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720].map((m) => m * 60_000);
  const step = steps.find((s) => maxMs / s <= 4) ?? steps.at(-1)!;
  const max = Math.max(step, Math.ceil(maxMs / step) * step);
  return { max, step };
}

const axisTime = (ms: number) => (ms === 0 ? '0' : ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : `${Math.round(ms / 60_000)}m`);

interface Point {
  label: string;
  value: number;
  tip: string;
  highlight?: boolean;
}

function columnChart(points: Point[], { height = 180, labelEvery = 1 } = {}) {
  const { max, step } = timeScale(Math.max(0, ...points.map((p) => p.value)));
  const root = el('div', { class: 'colchart', style: `--h:${height}px` });
  const yaxis = el('div', { class: 'yaxis', 'aria-hidden': 'true' });
  const plot = el('div', { class: 'plot' });
  for (let v = 0; v <= max; v += step) {
    const pct = (v / max) * 100;
    yaxis.append(el('span', { style: `bottom:${pct}%` }, axisTime(v)));
    if (v > 0) plot.append(el('div', { class: 'gridline', style: `bottom:${pct}%` }));
  }
  const cols = el('div', { class: 'cols' });
  const xlabels = el('div', { class: 'xlabels', 'aria-hidden': 'true' });
  points.forEach((p, i) => {
    const col = el('div', { class: `col${p.highlight ? ' today' : ''}` });
    col.append(el('div', { class: 'bar', style: `height:${(p.value / max) * 100}%` }));
    bindTip(col, p.tip);
    cols.append(col);
    xlabels.append(el('span', {}, i % labelEvery === 0 ? p.label : ''));
  });
  plot.append(cols);
  root.append(yaxis, plot, xlabels);
  return root;
}

function barList(rows: { name: string | Node; value: number; text: string; tip: string }[], empty = 'Nothing yet') {
  if (!rows.length) return el('p', { class: 'muted' }, empty);
  const max = Math.max(...rows.map((r) => r.value)) || 1;
  const list = el('div', { class: 'hbars' });
  for (const r of rows) {
    const track = el('div', { class: 'track' }, el('div', { class: 'fill', style: `width:${(r.value / max) * 100}%` }));
    const row = el('div', { class: 'hbar' }, el('div', { class: 'name' }, r.name), track, el('div', { class: 'val' }, r.text));
    bindTip(row, r.tip);
    list.append(row);
  }
  return list;
}

// ---------- sections ----------

function tile(label: string, value: string, sub = '', cls = '') {
  return el('div', { class: `tile ${cls}` }, el('div', { class: 'label' }, label), el('div', { class: 'value' }, value), ...(sub ? [el('div', { class: 'sub' }, sub)] : []));
}

function renderTiles(a: ReturnType<typeof aggregate>, dates: string[]) {
  const t = a.totals;
  const n = dates.length;
  const hero = tile('Watch time', fmtDuration(t.watchMs), n > 1 ? `${fmtDuration(t.watchMs / n)} a day on average` : 'videos actually playing', 'hero');

  const limitMs = settings.dailyLimitMinutes * 60_000;
  if (range === 'today' && limitMs) {
    const ratio = t.watchMs / limitMs;
    const [color, text] =
      ratio >= 1 ? ['var(--critical)', '✕ Over your daily limit'] : ratio >= 0.8 ? ['var(--warning)', '▲ Close to your daily limit'] : ['var(--good)', '● Within your daily limit'];
    hero.append(
      el(
        'div',
        { class: 'limit' },
        el('div', { class: 'bar' }, el('div', { class: 'fill', style: `width:${Math.min(100, ratio * 100)}%;background:${color}` })),
        el('div', { class: 'status' }, `${text} · ${Math.round(ratio * 100)}% of ${fmtDuration(limitMs)}`),
      ),
    );
  }

  const completion = a.watched.length ? Math.round((a.completed / a.watched.length) * 100) : 0;
  $('tiles').replaceChildren(
    hero,
    tile('Videos watched', String(a.watched.length), `${a.videos.length} opened`),
    tile('Time on YouTube', fmtDuration(t.activeMs), 'tab in front of you'),
    tile(
      'Saved by speed',
      fmtDuration(a.savedMs),
      `${fmtDuration(a.contentMs)} of video in ${fmtDuration(a.videoWatchMs)} · average ${a.avgSpeed.toFixed(2)}×`,
    ),
    tile('Finished', `${completion}%`, `${a.completed} of ${a.watched.length} watched to the end`),
    tile('Sessions', String(t.sessions), `longest ${fmtDuration(t.longestSessionMs)}`),
    tile('Ads', fmtDuration(t.adMs), t.watchMs ? `${((t.adMs / (t.watchMs + t.adMs)) * 100).toFixed(1)}% of playback` : ''),
    tile('Searches', String(t.searches)),
  );
}

function renderDaily() {
  const dates = range === 'today' ? lastNDates(14) : datesFor(range).slice(-90);
  $('daily-caption').textContent = range === 'today' ? 'last 14 days' : `${dates.length} days`;
  const today = dayKey();
  const points = dates.map((d) => {
    const day = days.get(d);
    const videos = day ? Object.values(day.videos).filter(isWatched).length : 0;
    const ms = day?.watchMs ?? 0;
    return {
      label: shortDate(d, dates.length > 31 ? { month: 'short', day: 'numeric' } : { day: 'numeric' }),
      value: ms,
      tip: `${shortDate(d, { weekday: 'short', month: 'short', day: 'numeric' })}\nWatch time ${fmtDuration(ms)}\n${videos} videos`,
      highlight: d === today,
    };
  });
  const every = points.length > 45 ? 14 : points.length > 20 ? 7 : points.length > 10 ? 2 : 1;
  $('daily-chart').replaceChildren(columnChart(points, { labelEvery: every }));

  const table = el('table', {}, el('tr', {}, el('th', {}, 'Date'), el('th', { class: 'num' }, 'Watch time'), el('th', { class: 'num' }, 'Time on YouTube'), el('th', { class: 'num' }, 'Videos')));
  for (const d of [...dates].reverse()) {
    const day = days.get(d);
    if (!day) continue;
    table.append(
      el(
        'tr',
        {},
        el('td', {}, shortDate(d, { weekday: 'short', month: 'short', day: 'numeric' })),
        el('td', { class: 'num' }, fmtDuration(day.watchMs)),
        el('td', { class: 'num' }, fmtDuration(day.activeMs)),
        el('td', { class: 'num' }, String(Object.values(day.videos).filter(isWatched).length)),
      ),
    );
  }
  $('daily-table').replaceChildren(table);
}

function renderHourly(a: ReturnType<typeof aggregate>) {
  const fmtHour = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });
  const points = a.totals.hourlyWatchMs.map((ms, h) => ({
    label: fmtHour(h).replace(/\s?(AM|PM)/i, (m) => m.trim()[0].toLowerCase()),
    value: ms,
    tip: `${fmtHour(h)}–${fmtHour((h + 1) % 24)}\n${fmtDuration(ms)}`,
  }));
  $('hourly-chart').replaceChildren(columnChart(points, { height: 140, labelEvery: 3 }));
}

function renderChannels(a: ReturnType<typeof aggregate>) {
  const rows = a.channels.slice(0, 10).map((c) => {
    const name = c.channelId
      ? el('a', { href: `https://www.youtube.com/channel/${c.channelId}`, target: '_blank', rel: 'noopener' }, c.name)
      : c.name;
    return { name, value: c.ms, text: fmtDuration(c.ms), tip: `${c.name}\n${fmtDuration(c.ms)} · ${c.count} video${c.count === 1 ? '' : 's'}` };
  });
  $('channels').replaceChildren(barList(rows, 'No channels yet'));
}

function kv(k: string, v: string, s = '') {
  return el('div', {}, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v), ...(s ? [el('div', { class: 's' }, s)] : []));
}

function streak() {
  let count = 0;
  const cursor = new Date();
  cursor.setHours(12, 0, 0, 0);
  // Today counts if you've watched; otherwise the streak runs through yesterday.
  if ((days.get(dayKey(cursor))?.watchMs ?? 0) < 60_000) cursor.setDate(cursor.getDate() - 1);
  while ((days.get(dayKey(cursor))?.watchMs ?? 0) >= 60_000) {
    count++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return count;
}

function renderHabits(a: ReturnType<typeof aggregate>, dates: string[]) {
  const withData = dates.filter((d) => (days.get(d)?.watchMs ?? 0) > 0);
  const busiest = withData.sort((x, y) => days.get(y)!.watchMs - days.get(x)!.watchMs)[0];
  const peakHour = a.totals.hourlyWatchMs.indexOf(Math.max(...a.totals.hourlyWatchMs));
  const avgVideo = a.watched.length ? a.watched.reduce((s, v) => s + v.watchMs, 0) / a.watched.length : 0;
  $('habits').replaceChildren(
    kv('Current streak', `${streak()} day${streak() === 1 ? '' : 's'}`, 'days in a row with 1m+ watched'),
    kv('Days active', `${withData.length} / ${dates.length}`),
    kv('Busiest day', busiest ? fmtDuration(days.get(busiest)!.watchMs) : '—', busiest ? shortDate(busiest, { weekday: 'short', month: 'short', day: 'numeric' }) : ''),
    kv('Peak hour', a.totals.watchMs ? new Date(2000, 0, 1, peakHour).toLocaleTimeString(undefined, { hour: 'numeric' }) : '—'),
    kv('Avg time per video', fmtDuration(avgVideo)),
    kv('Channels watched', String(a.channels.length)),
  );
}

function renderHealth(a: ReturnType<typeof aggregate>) {
  const t = a.totals;
  const hours = t.watchMs / 3_600_000;
  const droppedPct = t.totalFrames ? (t.droppedFrames / t.totalFrames) * 100 : 0;
  const avgKbps = t.bandwidthSamples ? t.bandwidthKbpsSum / t.bandwidthSamples : 0;
  $('health').replaceChildren(
    kv('Buffering events', String(t.stalls), hours > 0.1 ? `${(t.stalls / hours).toFixed(1)} per hour watched` : ''),
    kv('Time buffering', fmtDuration(t.stallMs)),
    kv('Dropped frames', `${droppedPct.toFixed(2)}%`, `${t.droppedFrames.toLocaleString()} of ${t.totalFrames.toLocaleString()}`),
    kv('Avg connection', avgKbps ? `${(avgKbps / 1000).toFixed(1)} Mbps` : '—', 'as measured by the player'),
  );
  const share = (map: Record<string, number>, sort: (a: string, b: string) => number) => {
    const total = Object.values(map).reduce((x, y) => x + y, 0) || 1;
    return Object.entries(map)
      .sort(([x], [y]) => sort(x, y))
      .map(([k, ms]) => ({ name: k, value: ms, text: `${Math.round((ms / total) * 100)}%`, tip: `${k}\n${fmtDuration(ms)} watched` }));
  };
  $('resolutions').replaceChildren(barList(share(t.resolutionMs, (x, y) => parseInt(y) - parseInt(x)), 'No data yet'));
  $('codecs').replaceChildren(barList(share(t.codecMs, (x, y) => (t.codecMs[y] ?? 0) - (t.codecMs[x] ?? 0)), 'No data yet'));
}

function renderVideos(a: ReturnType<typeof aggregate>) {
  const rows = a.videos.slice(0, 300);
  $('videos-caption').textContent = `${a.watched.length} watched · ${a.videos.length} opened${a.videos.length > 300 ? ' · showing latest 300' : ''}`;
  const table = $('videos') as HTMLTableElement;
  table.replaceChildren(
    el('tr', {}, el('th', {}, 'Video'), el('th', {}, 'When'), el('th', { class: 'num' }, 'Watched'), el('th', { class: 'num' }, 'Progress'), el('th', { class: 'num' }, 'Speed')),
  );
  for (const v of rows) {
    const pct = v.durationSec ? Math.min(100, Math.round((v.maxPosSec / v.durationSec) * 100)) : 0;
    const speed = v.watchMs > 5000 ? (v.contentSec * 1000) / v.watchMs : 0;
    const link = el('a', { href: `https://www.youtube.com/watch?v=${v.id}&t=${Math.floor(v.maxPosSec)}s`, target: '_blank', rel: 'noopener' }, v.title || v.id);
    const when = new Date(v.lastAt);
    table.append(
      el(
        'tr',
        {},
        el('td', {}, link, el('div', { class: 'sub' }, v.author)),
        el('td', {}, el('div', {}, when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })), el('div', { class: 'sub' }, shortDate(v.date))),
        el('td', { class: 'num' }, fmtDuration(v.watchMs)),
        el('td', { class: 'num' }, el('span', { class: 'pct' }, el('i', { style: `width:${pct}%` })), `${pct}%`),
        el('td', { class: 'num' }, speed ? `${speed.toFixed(2)}×` : '—'),
      ),
    );
  }
  if (!rows.length) table.append(el('tr', {}, el('td', { colspan: '5', class: 'muted' }, 'No videos in this range')));
}

function render() {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#range button')) {
    b.setAttribute('aria-selected', String(b.dataset.range === range));
  }
  const dates = datesFor(range);
  $('range-caption').textContent =
    range === 'today' ? shortDate(dates[0], { weekday: 'long', month: 'long', day: 'numeric' }) : `${shortDate(dates[0])} – ${shortDate(dates.at(-1)!)}`;
  const empty = days.size === 0;
  $('empty').hidden = !empty;
  $('content').hidden = empty;
  if (empty) return;
  const a = aggregate(dates);
  renderTiles(a, dates);
  renderDaily();
  renderHourly(a);
  renderChannels(a);
  renderHabits(a, dates);
  renderHealth(a);
  renderVideos(a);
}

async function main() {
  await load();
  try {
    range = (localStorage.getItem('bt-range') as Range) || 'today';
  } catch {
    // ignore
  }
  render();

  $('range').addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button[data-range]');
    if (!b) return;
    range = b.dataset.range as Range;
    try {
      localStorage.setItem('bt-range', range);
    } catch {
      // ignore
    }
    render();
  });

  $('export').addEventListener('click', () => {
    const data = Object.fromEntries([...days.entries()].sort());
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    el('a', { href: url, download: `bettertube-stats-${dayKey()}.json` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  $('clear').addEventListener('click', async () => {
    if (!confirm('Delete all BetterTube watch stats? This cannot be undone.')) return;
    await chrome.storage.local.remove([...days.keys()].map((d) => DAY_PREFIX + d));
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
    }, 1000);
  });
}

void main();
