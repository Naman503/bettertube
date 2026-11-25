// Watch time only counts while the video actually moves. A player that says
// "playing" but is frozen (stuck or forgotten tab) once logged 10+ hours a day.
// Uses a stand-in YouTube watch page (only what the stats code reads).
// Usage: npm run build && node tests/stats-frozen.mjs
import { chromium } from 'playwright';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const FIXTURE = 'test-results/fixtures/long.webm';
if (!existsSync(FIXTURE)) throw new Error(`run tests/ramp.mjs once to generate ${FIXTURE}`);
const ext = resolve('dist');
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'bt-frozen-')), {
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' }),
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required'],
});
const PAGE = `<!doctype html><body><div id="movie_player"><video class="html5-main-video" src="/v.webm" muted width="640" height="360"></video></div><script>
  const p = document.getElementById('movie_player');
  p.getVideoData = () => ({ video_id: 'frozen01', author: 'Test', title: 'Frozen test' });
  p.getPlayerResponse = () => ({ videoDetails: { videoId: 'frozen01', channelId: 'UCtest', lengthSeconds: '600' } });
  // Freeze: still "playing" (not paused, data loaded) but the position stops moving.
  window.freeze = (on) => { document.querySelector('video').playbackRate = on ? 0 : 1; };
</script></body>`;
await context.route(/^https:\/\/www\.youtube\.com\//, (route) => {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith('.webm')) return route.fulfill({ status: 200, contentType: 'video/webm', body: readFileSync(FIXTURE) });
  if (url.pathname === '/watch') return route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
  return route.fulfill({ status: 404, body: '' });
});
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
// Keep the speed controller out of it (it would undo a 0× rate).
await worker.evaluate(() => chrome.storage.sync.set({ speedController: { blacklist: 'youtube.com' } }));
const watched = () =>
  worker.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const day = Object.entries(all).find(([k]) => k.startsWith('stats:day:'))?.[1];
    return { day: day?.watchMs ?? 0, video: day?.videos?.frozen01?.watchMs ?? 0, content: day?.videos?.frozen01?.contentSec ?? 0 };
  });

try {
  const page = await context.newPage();
  await page.goto('https://www.youtube.com/watch?v=frozen01');
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 3, null, { timeout: 20_000 });
  await page.evaluate(() => void document.querySelector('video').play());
  await page.waitForTimeout(16_000);
  const a = await watched();
  check('normal playback counts', a.video >= 9000 && a.content >= 9, JSON.stringify(a));

  await page.evaluate(() => window.freeze(true));
  await page.waitForTimeout(26_000);
  const b = await watched();
  // At most the one tick that was already under way when it froze.
  check('frozen player is not counted as watching', b.video - a.video <= 6000 && b.day - a.day <= 6000, `+${Math.round((b.video - a.video) / 1000)} s in 26 s frozen`);
  check('…and nothing counted as video covered', b.content - a.content <= 6, `+${(b.content - a.content).toFixed(1)} s`);

  await page.evaluate(() => window.freeze(false));
  await page.waitForTimeout(16_000);
  const c = await watched();
  check('counting resumes once it moves again', c.video - b.video >= 9000, `+${Math.round((c.video - b.video) / 1000)} s`);
} finally {
  await context.close();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
