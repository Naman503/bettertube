// Dashboard: date picker (presets, custom range, ‹ ›), stuck playback left
// out of the numbers, the new charts, and the videos table.
// Usage: npm run build && node tests/dashboard.mjs [--data stats.json] [--shots dir]
//   --data: an "Export JSON" file (or a storage dump); synthetic data otherwise.
import { chromium } from 'playwright';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const SHOTS = arg('--shots');
const DATA = arg('--data');
const ext = resolve('dist');

const pad = (n) => String(n).padStart(2, '0');
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAgo = (n) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
};
const MIN = 60_000;

/** 60 days: ~1–2 h a day at ~2.2×, nothing on two days, a stuck tab 3 days ago. */
function synthetic() {
  const out = {};
  for (let n = 59; n >= 0; n--) {
    if (n === 10 || n === 20) continue;
    const d = daysAgo(n);
    const videos = {};
    let watch = 0;
    let content = 0;
    const count = 3 + (n % 4);
    for (let i = 0; i < count; i++) {
      const w = (12 + ((n * 7 + i * 5) % 25)) * MIN;
      const speed = [1, 1.75, 2.2, 2.6, 3.1][(n + i) % 5];
      const dur = (w / 1000) * speed * (i % 3 === 0 ? 1 : 1.4);
      const at = d.getTime() - (count - i) * 40 * MIN;
      videos[`v${n}_${i}`] = { title: `Video ${n}-${i} about ${['homelabs', 'cooking', 'chess', 'music'][i % 4]}`, author: ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'][i % 5], channelId: `UC${i % 5}`, durationSec: dur, watchMs: w, contentSec: (w / 1000) * speed, maxPosSec: (w / 1000) * speed, firstAt: at, lastAt: at + w };
      watch += w;
      content += (w / 1000) * speed;
    }
    const hourly = Array(24).fill(0);
    hourly[21] = watch * 0.6;
    hourly[22] = watch * 0.4;
    out[key(d)] = { date: key(d), activeMs: watch * 1.2, watchMs: watch, adMs: 0, contentSec: content, hourlyWatchMs: hourly, videos, sessions: 2, longestSessionMs: watch / 2, stalls: 1, stallMs: 4000, droppedFrames: 10, totalFrames: 90000, resolutionMs: { '1080p': watch }, codecMs: { vp9: watch }, bandwidthKbpsSum: 50000, bandwidthSamples: 5, searches: 2 };
  }
  // A frozen tab: 10 h "playing", nothing moved.
  const s = out[key(daysAgo(3))];
  const at = daysAgo(3).getTime();
  s.videos.stuck = { title: 'Stuck video', author: 'Zeta', channelId: 'UCz', durationSec: 2100, watchMs: 600 * MIN, contentSec: 0, maxPosSec: 240, firstAt: at, lastAt: at + 600 * MIN };
  s.watchMs += 600 * MIN;
  s.hourlyWatchMs = s.hourlyWatchMs.map((ms) => ms + (600 * MIN) / 24);
  return out;
}

function fromFile(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return Object.fromEntries(Object.entries(raw).filter(([k]) => /^(stats:day:)?\d{4}-\d{2}-\d{2}$/.test(k)).map(([k, v]) => [k.startsWith('stats:day:') ? k.slice(10) : k, v]));
}

const days = DATA ? fromFile(DATA) : synthetic();
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'bt-dash-')), {
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' }),
  headless: true,
  viewport: { width: 1280, height: 900 },
  colorScheme: process.env.LIGHT ? 'light' : 'dark',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const extId = new URL(worker.url()).host;
await worker.evaluate((d) => chrome.storage.local.set(Object.fromEntries(Object.entries(d).map(([k, v]) => [`stats:day:${k}`, v]))), days);
await worker.evaluate(() => chrome.storage.sync.set({ settings: { dailyLimitMinutes: 90 } }));

const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`chrome-extension://${extId}/dashboard.html`);
await page.waitForSelector('.tile.hero');
const text = (sel) => page.locator(sel).first().innerText().then((t) => t.replace(/\s+/g, ' ').trim());
const pick = async (label) => {
  await page.click('#range-btn');
  await page.locator('.preset', { hasText: label }).first().click();
  await page.waitForTimeout(250);
};

try {
  await pick('Last 30 days');
  check('preset: Last 30 days', (await text('#range-label')) === 'Last 30 days' && /30 days/.test(await text('#range-caption')), await text('#range-caption'));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/dash-30.png`, fullPage: true });

  if (!DATA) {
    const saved = await text('.tile.accent .value');
    check('saved by speed is real time saved, not 0', saved !== '0s' && !/^\d+s$/.test(saved), saved);
    const note = await text('#stuck-note');
    check('stuck playback is left out, with a note', /Left out 10h 00m from 1 video/.test(note), note.slice(0, 80));
    const hero = await text('.tile.hero .value');
    const heroMin = (() => { const m = /(\d+)h (\d+)m/.exec(hero); return m ? +m[1] * 60 + +m[2] : 0; })();
    check('watch time excludes the stuck 10 h', heroMin > 0 && heroMin < 30 * 2 * 60, hero);
    check('tiles compare with the previous period', (await page.locator('.tile .delta').count()) >= 4, await text('.tile.hero .delta'));
    check('hero shows days over the daily limit', /limit on \d+ of 30 days|Within your/.test(await text('.tile.hero')));
  }

  // Trend metric switch
  for (const [metricLabel, title] of [['Time saved', 'Time saved by speed per day'], ['Videos', 'Videos watched per day'], ['Speed', 'Average speed per day'], ['Watch time', 'Watch time per day']]) {
    await page.click(`#trend-metric button:text-is("${metricLabel}")`);
    await page.waitForTimeout(100);
    check(`trend: ${metricLabel}`, (await text('#trend-title')) === title && (await page.locator('#trend-chart .col').count()) === 30);
  }
  check('trend has an average line and the limit line', (await page.locator('#trend-chart .refline.avg').count()) === 1 && (await page.locator('#trend-chart .refline.limit').count()) === 1);

  check('activity calendar covers 12+ weeks', (await page.locator('#calendar .calendar .cell').count()) >= 84);
  check('weekday × hour heatmap: 7 × 24 cells', (await page.locator('#weekhour .cell').count()) === 168);
  check('speed, length, channels, top videos filled', (await page.locator('#speeds .hbar').count()) === 7 && (await page.locator('#lengths .hbar').count()) === 4 && (await page.locator('#channels .hbar').count()) > 0 && (await page.locator('#top-videos .hbar').count()) > 0);

  // Custom range
  await page.click('#range-btn');
  const from = key(daysAgo(13));
  const to = key(daysAgo(7));
  await page.fill('#range-from', from);
  await page.fill('#range-to', to);
  await page.click('#range-custom button[type=submit]');
  await page.waitForTimeout(250);
  check('custom range: 7 days', /7 days/.test(await text('#range-caption')) && (await page.locator('#trend-chart .col').count()) === 7, await text('#range-caption'));
  await page.click('#range-prev');
  await page.waitForTimeout(250);
  const shifted = await page.inputValue('#range-from');
  check('‹ moves back by the same length', shifted === key(daysAgo(20)), shifted);
  await page.click('#range-next');
  await page.click('#range-next');
  await page.waitForTimeout(250);
  check('› moves forward', (await page.inputValue('#range-from')) === key(daysAgo(6)));
  await page.click('#range-btn');
  await page.fill('#range-from', key(daysAgo(2)));
  await page.fill('#range-to', key(daysAgo(5)));
  await page.click('#range-custom button[type=submit]');
  check('from after to: refused with a message', await page.locator('#range-error').isVisible());
  await page.keyboard.press('Escape');

  await pick('Today');
  check('today: › disabled', await page.locator('#range-next').isDisabled());
  await pick('All time');
  check('all time: no comparison arrows', await page.locator('#range-prev').isDisabled());
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/dash-all.png`, fullPage: true });

  // Videos table
  const before = await page.locator('#videos tr').count();
  await page.fill('#video-search', DATA ? 'a' : 'chess');
  await page.waitForTimeout(400);
  const after = await page.locator('#videos tr').count();
  check('search filters the videos table', after > 1 && after < before, `${before - 1} → ${after - 1}`);
  await page.click('#videos th .sort:text("Watched")');
  const first = await page.locator('#videos tr:nth-child(2) td:nth-child(3)').innerText();
  const second = await page.locator('#videos tr:nth-child(3) td:nth-child(3)').innerText();
  check('sort by watched time', !!first && !!second, `${first} ≥ ${second}`);

  await pick('Last 30 days');
  await page.click('#range-btn');
  if (SHOTS) await page.locator('.picker').screenshot({ path: `${SHOTS}/dash-picker.png` }).catch(() => {});
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/dash-picker-page.png` });
  await page.keyboard.press('Escape');

  check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await context.close();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
