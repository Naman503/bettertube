// Incognito: works as usual, records nothing permanently; incognito speeds
// last only for the session. Real incognito needs a manual "Allow in
// incognito" toggle, so this uses the unpacked-only simulation flag.
// Usage: npm run build && node tests/incognito.mjs
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
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'bt-incog-')), {
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' }),
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required'],
});
await context.route(/^https:\/\/[a-z-]+\.example\//, (route) => {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith('.webm')) return route.fulfill({ status: 200, contentType: 'video/webm', body: readFileSync(FIXTURE) });
  return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><body style="margin:0"><video src="/v.webm" width="960" height="540" muted></video></body>` });
});
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const local = () => worker.evaluate(() => chrome.storage.local.get(null));
const session = () => worker.evaluate(async () => Object.fromEntries(Object.entries(await chrome.storage.session.get(null)).filter(([k]) => k.startsWith('incognito:'))));
const open = async (url) => {
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 3, null, { timeout: 30_000 });
  await page.evaluate(() => document.querySelector('video').play());
  await page.waitForTimeout(1500);
  return { page, rate: () => page.evaluate(() => document.querySelector('video').playbackRate) };
};
const press = async (page, key) => {
  await page.mouse.click(1200, 750);
  await page.keyboard.press(key);
  await page.waitForTimeout(800);
};

// Normal browsing history: site A at 2×, last speed 1.5×.
await worker.evaluate(() => chrome.storage.local.set({ siteSpeeds: { 'site-a.example': 2 }, lastSpeed: 1.5, 'dev:simulateIncognito': true }));
await worker.evaluate(() => chrome.storage.sync.set({ speedController: { ramp: true } }));

try {
  let a = await open('https://site-a.example/');
  check('incognito starts from your normal saved speed for the site (2×)', (await a.rate()) === 2, `${await a.rate()}×`);
  await press(a.page, 'd'); // 2.05
  const l1 = await local();
  check('changing speed in incognito does not touch normal memory', l1.siteSpeeds['site-a.example'] === 2 && l1.lastSpeed === 1.5, JSON.stringify({ siteSpeeds: l1.siteSpeeds, lastSpeed: l1.lastSpeed }));
  check('…it is kept in session memory instead', (await session())['incognito:siteSpeeds']?.['site-a.example'] === 2.05, JSON.stringify(await session()));
  await press(a.page, 'r'); // pause (R) in incognito
  check('a pause in incognito does not leak into normal browsing', (await local()).rampPaused !== true && (await session())['incognito:rampPaused'] === true, `normal rampPaused=${(await local()).rampPaused}`);
  await press(a.page, 'r'); // back to 2.05
  await a.page.close();

  const b = await open('https://site-b.example/');
  check('new incognito site starts at your incognito last speed (2.05×)', (await b.rate()) === 2.05, `${await b.rate()}×`);
  await b.page.close();
  a = await open('https://site-a.example/');
  check('incognito remembers site A across tabs (2.05×)', (await a.rate()) === 2.05, `${await a.rate()}×`);
  await a.page.close();

  // YouTube: no stats, no snapshot, badge says so.
  const yt = await context.newPage();
  await yt.goto('https://www.youtube.com/watch?v=aircAruvnKk', { waitUntil: 'domcontentloaded' });
  await yt.waitForSelector('#movie_player video', { timeout: 30_000 });
  await yt.evaluate(() => { const v = document.querySelector('#movie_player video'); v.muted = true; return v.play(); }).catch(() => {});
  await yt.waitForTimeout(12_000);
  const l2 = await local();
  const recorded = Object.keys(l2).filter((k) => k.startsWith('stats:day:') || k === 'diag:auto');
  check('YouTube in incognito records no stats or snapshots', recorded.length === 0, recorded.join(', ') || 'nothing recorded');
  const badge = await yt.evaluate(() => document.getElementById('bt-stats-badge')?.innerText.replace(/\s+/g, ' ').trim());
  check('top-bar badge says incognito / not recorded', /incognito/i.test(badge ?? '') && /not recorded/i.test(badge ?? ''), badge);
  await yt.close();

  // Last incognito tab closed → wipe (real trigger: tabs.onRemoved with no incognito tabs left).
  await worker.evaluate(() => globalThis.btForgetIncognito());
  check('closing incognito forgets its speeds and pauses', Object.keys(await session()).length === 0, JSON.stringify(await session()));
  a = await open('https://site-a.example/');
  check('next incognito session starts fresh from normal memory (2×)', (await a.rate()) === 2, `${await a.rate()}×`);
  await a.page.close();

  await worker.evaluate(() => chrome.storage.local.set({ 'dev:simulateIncognito': false }));
  a = await open('https://site-a.example/');
  check('normal browsing is unaffected (site A still 2×)', (await a.rate()) === 2, `${await a.rate()}×`);
} finally {
  await context.close();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
