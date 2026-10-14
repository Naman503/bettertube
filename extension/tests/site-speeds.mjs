// Per-site speed memory: each site keeps its own last speed; a new site starts
// at your last speed anywhere (without saving it for that site); an embedded
// video follows the page it's on. Local fake sites, generated test video.
// Usage: npm run build && node tests/site-speeds.mjs
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const FIXTURE = 'test-results/fixtures/long.webm';
if (!existsSync(FIXTURE)) {
  mkdirSync('test-results/fixtures', { recursive: true });
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15', '-t', '600',
    '-c:v', 'libvpx-vp9', '-b:v', '40k', '-deadline', 'realtime', '-cpu-used', '8', FIXTURE]);
}
const ext = resolve('dist');
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'bt-site-')), {
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' }),
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required'],
});
// Any https://<name>.example/ serves a page with a video; /embed?src=… wraps another site in an iframe.
await context.route(/^https:\/\/[a-z-]+\.example\//, (route) => {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith('.webm')) return route.fulfill({ status: 200, contentType: 'video/webm', body: readFileSync(FIXTURE) });
  if (url.pathname === '/embed') {
    return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><body style="margin:0"><iframe src="${url.searchParams.get('src')}" width="1000" height="600" allow="autoplay"></iframe></body>` });
  }
  return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><body style="margin:0"><video src="/v.webm" width="960" height="540" muted></video></body>` });
});

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const saved = () => worker.evaluate(async () => (await chrome.storage.local.get('siteSpeeds')).siteSpeeds ?? {});

/** Open a page, play its video (in the page or its iframe), return { page, frame }. */
const open = async (url) => {
  const page = await context.newPage();
  await page.goto(url);
  const frame = url.includes('/embed') ? page.frames().find((f) => f !== page.mainFrame()) ?? (await page.waitForEvent('frameattached')) : page.mainFrame();
  await frame.waitForFunction(() => document.querySelector('video')?.readyState >= 3, null, { timeout: 30_000 });
  await frame.evaluate(() => document.querySelector('video').play());
  await page.waitForTimeout(1500);
  return { page, frame, rate: () => frame.evaluate(() => document.querySelector('video').playbackRate) };
};
const press = async (page, key) => {
  await page.mouse.click(1200, 750);
  await page.keyboard.press(key);
  await page.waitForTimeout(800); // speeds are saved ~0.4 s after a change
};

try {
  const a = await open('https://site-a.example/');
  await press(a.page, 'g'); // 3.1
  check('site A: set 3.1× and it is saved for A', (await a.rate()) === 3.1 && (await saved())['site-a.example'] === 3.1, JSON.stringify(await saved()));
  await a.page.close();

  const b = await open('https://site-b.example/');
  check('new site B starts at your last speed (3.1×)…', (await b.rate()) === 3.1, `${await b.rate()}×`);
  check('…without saving it for B until you change it', !('site-b.example' in (await saved())), JSON.stringify(await saved()));
  await press(b.page, 'u'); // 2.35
  check('site B: set 2.35× and it is saved for B', (await saved())['site-b.example'] === 2.35, JSON.stringify(await saved()));
  await b.page.close();

  const a2 = await open('https://site-a.example/');
  check('back on A: its own 3.1×', (await a2.rate()) === 3.1, `${await a2.rate()}×`);
  await a2.page.close();

  const c = await open('https://site-c.example/');
  check('another new site C: your last speed (2.35×)', (await c.rate()) === 2.35, `${await c.rate()}×`);
  await c.page.close();

  const d = await open('https://site-d.example/embed?src=https://site-a.example/');
  check('site A embedded in new site D follows D (2.35×), not A (3.1×)', (await d.rate()) === 2.35, `${await d.rate()}×`);
  await d.page.close();

  await worker.evaluate(async () => {
    const cur = (await chrome.storage.sync.get('speedController')).speedController ?? {};
    await chrome.storage.sync.set({ speedController: { ...cur, perSiteSpeed: false } });
  });
  const a3 = await open('https://site-a.example/');
  check('per-site off: A uses your one global last speed (2.35×)', (await a3.rate()) === 2.35, `${await a3.rate()}×`);
} finally {
  await context.close();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
