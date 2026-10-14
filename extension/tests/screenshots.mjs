// Regenerates the README screenshots in docs/images/ (dark theme). The
// dashboard uses made-up demo data so no real viewing history is published.
// Usage: npm run build && node tests/screenshots.mjs
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const OUT = resolve('../docs/images');
const ext = resolve('dist');
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'bt-shots-')), {
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' }),
  headless: true,
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required'],
});
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const extUrl = (p) => `chrome-extension://${new URL(worker.url()).host}/${p}`;

// ---- demo data: 14 days of made-up watching ----
await worker.evaluate(() => {
  const channels = ['Systems Explained', 'Frontend Weekly', 'Data Talks', 'Rust in Practice', 'Design Notes', 'Lo-fi Focus'];
  const titles = [
    'Consistent hashing, visually', 'Building a CRDT from scratch', 'Postgres query plans in 20 minutes',
    'Ownership and borrowing, for real', 'Designing a design system', 'Event sourcing without the hype',
    'React Server Components deep dive', 'Rate limiters: four algorithms', 'Two hours of lo-fi for coding',
    'Kafka vs. a log in your database', 'Typography for developers', 'How browsers paint a frame',
  ];
  const pad = (n) => String(n).padStart(2, '0');
  const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  let seed = 7;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const data = {};
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const n = 2 + Math.floor(rnd() * 6);
    const videos = {};
    let watchMs = 0;
    let contentSec = 0;
    const hourly = Array(24).fill(0);
    for (let v = 0; v < n; v++) {
      const dur = 600 + Math.floor(rnd() * 2400);
      const speed = 1.6 + rnd() * 1.4;
      const watched = Math.min(dur, 300 + rnd() * dur);
      const ms = (watched / speed) * 1000;
      watchMs += ms;
      contentSec += watched;
      hourly[[9, 13, 20, 21, 22][Math.floor(rnd() * 5)]] += ms;
      const at = d.getTime() - Math.floor(rnd() * 8) * 3600_000;
      videos[`demo${i}_${v}`] = {
        title: titles[Math.floor(rnd() * titles.length)], author: channels[Math.floor(rnd() * channels.length)], channelId: '',
        durationSec: dur, watchMs: ms, contentSec: watched, maxPosSec: watched, firstAt: at, lastAt: at,
      };
    }
    data[`stats:day:${key(d)}`] = {
      date: key(d), activeMs: watchMs * 1.25, watchMs, adMs: 0, contentSec, hourlyWatchMs: hourly, videos,
      sessions: 1 + Math.floor(rnd() * 3), longestSessionMs: watchMs * 0.6, stalls: Math.floor(rnd() * 3), stallMs: 1800,
      droppedFrames: 40, totalFrames: 90000, resolutionMs: { '1080p': watchMs * 0.7, '1440p': watchMs * 0.3 },
      codecMs: { VP9: watchMs * 0.85, 'H.264': watchMs * 0.15 }, bandwidthKbpsSum: 42000, bandwidthSamples: 1, searches: Math.floor(rnd() * 4),
    };
  }
  return chrome.storage.local.set({ ...data, siteSpeeds: { 'youtube.com': 2.35, 'udemy.com': 1.75, 'coursera.org': 1.5 }, lastSpeed: 2.35 });
});
await worker.evaluate(() => chrome.storage.sync.set({ speedController: { ramp: true, rampQuiet: true, rampMax: 3 } }));

// ---- dashboard ----
const dash = await context.newPage();
await dash.setViewportSize({ width: 1280, height: 1180 });
await dash.goto(extUrl('dashboard.html'));
await dash.click('#range button[data-range="7"]');
await dash.waitForTimeout(600);
await dash.screenshot({ path: `${OUT}/dashboard.png` });
await dash.close();

// ---- popup tabs ----
const pop = await context.newPage();
await pop.setViewportSize({ width: 380, height: 760 });
await pop.goto(extUrl('popup.html'));
for (const tab of ['home', 'speed']) {
  await pop.click(`.tabs button[data-tab="${tab}"]`);
  await pop.waitForTimeout(300);
  await pop.screenshot({ path: `${OUT}/popup-${tab}.png` });
}
await pop.close();

// ---- YouTube watch page with the speed panel open ----
await context.addCookies([{ name: 'PREF', value: 'f6=400', domain: '.youtube.com', path: '/' }]);
const page = await context.newPage();
await page.goto('https://www.youtube.com/watch?v=aircAruvnKk', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#movie_player video', { timeout: 30_000 });
await page.waitForFunction(() => !document.querySelector('#movie_player.ad-showing'), null, { timeout: 120_000 }).catch(() => {});
await page.evaluate(() => { const v = document.querySelector('#movie_player video'); v.muted = true; return v.play(); }).catch(() => {});
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/watch-page.png` });
await page.evaluate(() => {
  const s = document.querySelector('.bt-speed-controller').shadowRoot.querySelector('.speed');
  s.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, pointerId: 1 }));
  s.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true, pointerId: 1 }));
});
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/speed-panel.png`, clip: { x: 0, y: 56, width: 1010, height: 580 } });
await context.close();
console.log('screenshots written to docs/images/');
