// "Saved by speed" while the speed changes constantly (gradual speed-up,
// R → 1×, H → 2.95×): compares BetterTube's stats with ground truth sampled
// from the video itself. Live YouTube, logged out.
// Usage: npm run build && node tests/stats-ramp.mjs
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ext = resolve('dist');
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'bt-sr-')), {
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' }),
  headless: true,
  viewport: { width: 1440, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required'],
});
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
await worker.evaluate(() =>
  chrome.storage.sync.set({
    speedController: { ramp: true, rampStep: 0.1, rampEverySec: 2, rampMax: 3, rampMinVideoMin: 0, rampEaseOnRewind: false },
  }),
);
const stats = () =>
  worker.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const day = Object.entries(all).find(([k]) => k.startsWith('stats:day:'))?.[1];
    if (!day) return { content: 0, real: 0 };
    return { content: day.contentSec, real: Object.values(day.videos).reduce((a, v) => a + v.watchMs, 0) / 1000 };
  });
const page = await context.newPage();
const truth = () => page.evaluate(() => ({ ...window.__truth }));
/** Wait for the next stats write, then read ground truth at that moment. */
const atNextWrite = async () => {
  const before = await stats();
  for (let i = 0; i < 200; i++) {
    const now = await stats();
    if (now.content !== before.content || now.real !== before.real) return { stats: now, truth: await truth() };
    await new Promise((r) => setTimeout(r, 50));
  }
  const v = await page.evaluate(() => { const v = document.querySelector('#movie_player video'); return { paused: v?.paused, t: v?.currentTime, url: location.href }; });
  throw new Error(`no stats write in 10 s · before ${JSON.stringify(before)} · video ${JSON.stringify(v)}`);
};

let ok = false;
try {
  await page.goto('https://www.youtube.com/watch?v=aircAruvnKk', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#movie_player video', { timeout: 30_000 });
  // Wait out pre-roll ads and make sure the real video is playing.
  await page.waitForFunction(
    () => {
      const v = document.querySelector('#movie_player video');
      if (document.querySelector('#movie_player.ad-showing')) return false;
      if (v.paused) { v.muted = true; void v.play().catch(() => {}); return false; }
      return v.currentTime > 1;
    },
    null,
    { timeout: 150_000, polling: 500 },
  );
  // Start from 1× so the climb is visible in the short window.
  await page.evaluate(() => (document.querySelector('#movie_player video').playbackRate = 1));
  // Ground truth: continuous playback only (seeks excluded), sampled 5×/s.
  await page.evaluate(() => {
    const v = document.querySelector('#movie_player video');
    v.muted = true;
    window.__truth = { content: 0, real: 0, maxRate: 1 };
    let last = v.currentTime;
    let lastAt = performance.now();
    setInterval(() => {
      const now = performance.now();
      const d = v.currentTime - last;
      const elapsed = (now - lastAt) / 1000;
      last = v.currentTime;
      lastAt = now;
      if (!v.paused && d > 0 && d < elapsed * 16 && !document.querySelector('#movie_player.ad-showing')) {
        window.__truth.content += d;
        window.__truth.real += elapsed;
        window.__truth.maxRate = Math.max(window.__truth.maxRate, v.playbackRate);
      }
    }, 200);
    return v.play();
  }).catch(() => {});
  await page.waitForTimeout(1000);

  // Logged-out headless YouTube stops playback ~45–60 s into a video, so the
  // whole scenario fits in ~25 s of real time (the speed climbs fast here).
  const a = await atNextWrite();
  await page.waitForTimeout(7_000); // climbing from 1×
  await page.keyboard.press('r'); // → 1×, pauses the climb
  await page.waitForTimeout(5_000);
  await page.keyboard.press('h'); // → 2.95×, resumes
  await page.waitForTimeout(3_000);
  const b = await atNextWrite();

  const s = { content: b.stats.content - a.stats.content, real: b.stats.real - a.stats.real };
  const t = { content: b.truth.content - a.truth.content, real: b.truth.real - a.truth.real };
  const savedStats = s.content - s.real;
  const savedTruth = t.content - t.real;
  const err = Math.abs(savedStats - savedTruth) / savedTruth;
  ok = err < 0.08;
  console.log(`ground truth: ${t.content.toFixed(1)} s of video in ${t.real.toFixed(1)} s real → saved ${savedTruth.toFixed(1)} s (avg ${(t.content / t.real).toFixed(2)}×, peak ${b.truth.maxRate}×)`);
  console.log(`BetterTube:   ${s.content.toFixed(1)} s of video in ${s.real.toFixed(1)} s real → saved ${savedStats.toFixed(1)} s (avg ${(s.content / s.real).toFixed(2)}×)`);
  console.log(`${ok ? '✅' : '❌'} saved-by-speed matches reality within ${(err * 100).toFixed(1)}% while the speed kept changing`);
} finally {
  await context.close();
}
process.exit(ok ? 0 : 1);
