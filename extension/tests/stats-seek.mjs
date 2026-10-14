// "Saved by speed" counts only continuous playback: jumping ahead with X
// (+10 s) must not add to "video covered". Live YouTube, logged out.
// Usage: npm run build && node tests/stats-seek.mjs
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ext = resolve('dist');
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'bt-seek-')), {
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' }),
  headless: true,
  viewport: { width: 1440, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required'],
});
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const stats = () =>
  worker.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const day = Object.entries(all).find(([k]) => k.startsWith('stats:day:'))?.[1];
    if (!day) return { content: 0, real: 0 };
    const real = Object.values(day.videos).reduce((a, v) => a + v.watchMs, 0) / 1000;
    return { content: day.contentSec, real };
  });
const page = await context.newPage();
let ok = true;
try {
  await page.goto('https://www.youtube.com/watch?v=aircAruvnKk', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#movie_player video', { timeout: 30_000 });
  await page.waitForFunction(() => !document.querySelector('#movie_player.ad-showing'), null, { timeout: 120_000 }).catch(() => {});
  await page.evaluate(() => { const v = document.querySelector('#movie_player video'); v.muted = true; return v.play(); }).catch(() => {});
  // Change speed after the start (as you would); right at load the speed
  // controller treats a change as the site resetting it and restores yours.
  await page.waitForTimeout(3000);
  await page.evaluate(() => (document.querySelector('#movie_player video').playbackRate = 2));
  await page.waitForTimeout(12_000);
  const a = await stats();
  const rateNow = await page.evaluate(() => document.querySelector('#movie_player video').playbackRate);
  console.log(`   playing at ${rateNow}×`);
  // Five jumps of +10 s inside one tick window.
  await page.locator('body').click({ position: { x: 5, y: 600 } }).catch(() => {});
  for (let i = 0; i < 5; i++) await page.keyboard.press('x');
  await page.waitForTimeout(11_000);
  const b = await stats();
  const addedContent = b.content - a.content;
  const addedReal = b.real - a.real;
  // At 2×: covered must be ≈ 2 × real. Before the fix the five +10 s jumps
  // were added on top (≈ +50 s), which would push the ratio far above 2.
  const ratio = addedContent / addedReal;
  ok = addedReal > 5 && Math.abs(ratio - 2) < 0.25;
  console.log(`${ok ? '✅' : '❌'} jumps not counted, 2× counted as 2× — +${addedContent.toFixed(1)} s covered in +${addedReal.toFixed(1)} s real = ${ratio.toFixed(2)}× (50 s of jumps excluded)`);
} finally {
  await context.close();
}
process.exit(ok ? 0 : 1);
