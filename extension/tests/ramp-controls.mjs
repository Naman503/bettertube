// Gradual speed-up controls: R pauses (across videos), H/G/D resume, a quiet
// zone (no climb between two speeds), and per-shortcut effects you choose.
// Usage: npm run build && node tests/ramp-controls.mjs
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
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'bt-rc-')), {
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' }),
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required'],
});
const ORIGIN = 'https://bettertube-test.example';
await context.route(`${ORIGIN}/**`, (route) => {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith('.webm')) return route.fulfill({ status: 200, contentType: 'video/webm', body: readFileSync(FIXTURE) });
  return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><body style="margin:0"><video src="/long.webm?${url.pathname}" width="960" height="540" muted></video></body>` });
});

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const setSpeed = (patch) =>
  worker.evaluate(async (patch) => {
    const cur = (await chrome.storage.sync.get('speedController')).speedController ?? {};
    await chrome.storage.sync.set({ speedController: { ...cur, ...patch } });
  }, patch);
const paused = () => worker.evaluate(async () => (await chrome.storage.local.get('rampPaused')).rampPaused === true);

let page;
const rate = () => page.evaluate(() => document.querySelector('video').playbackRate);
const label = () => page.evaluate(() => document.querySelector('.bt-speed-controller')?.shadowRoot?.querySelector('.speed')?.textContent);
const watch = (seconds) =>
  page.evaluate((seconds) => new Promise((done, fail) => {
    const v = document.querySelector('video');
    let watched = 0, last = v.currentTime;
    const deadline = Date.now() + seconds * 1000 + 60_000;
    const t = setInterval(() => {
      const d = v.currentTime - last; last = v.currentTime;
      if (d > 0 && d < 5) watched += d / v.playbackRate;
      if (watched >= seconds) { clearInterval(t); done(); }
      else if (Date.now() > deadline) { clearInterval(t); fail(new Error(`only ${watched.toFixed(1)} s played`)); }
    }, 200);
  }), seconds);
const open = async (path) => {
  page = await context.newPage();
  await page.goto(`${ORIGIN}${path}`);
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 3, null, { timeout: 30_000 });
  await page.evaluate(() => document.querySelector('video').play());
  await page.mouse.click(1100, 700); // focus the page, away from the video
};
const press = async (key) => {
  await page.keyboard.press(key);
  await page.waitForTimeout(300);
};

// +0.05× every 2 s up to 4×, no short-video skip, R/G/H/U/D defaults.
await setSpeed({ ramp: true, rampStep: 0.05, rampEverySec: 2, rampMax: 4, rampMinVideoMin: 0, rampEaseOnRewind: false, rampOnManual: 'continue' });

try {
  await open('/one');
  // (Right at start a speed change counts as the site resetting it; wait a moment.)
  await page.waitForTimeout(2000);
  await page.evaluate(() => (document.querySelector('video').playbackRate = 1.2));
  await watch(5);
  check('climbing', (await rate()) > 1.2, `1.2× → ${await rate()}×`);

  await press('r');
  const flashed = await label();
  check('R → 1× and speed-up paused', (await rate()) === 1 && (await paused()), `${await rate()}× · paused=${await paused()} · overlay "${flashed}"`);
  await watch(6);
  check('stays at 1× while paused', (await rate()) === 1, `${await rate()}×`);

  await page.close();
  await open('/two');
  await watch(6);
  check('still paused on the next video (music playlist)', (await rate()) === 1 && (await paused()), `${await rate()}× · paused=${await paused()}`);

  await press('h'); // preferred 2.95, resumes
  check('H → 2.95× and resumes', (await rate()) === 2.95 && !(await paused()), `${await rate()}× · paused=${await paused()}`);
  await watch(5);
  check('climbing again after H', (await rate()) > 2.95, `${await rate()}×`);

  // Quiet zone 1×–2.5×.
  await setSpeed({ rampQuiet: true, rampQuietFrom: 1, rampQuietTo: 2.5 });
  await press('u'); // preferred 2.35 (inside the zone)
  await watch(6);
  check('no climb inside the quiet zone (2.35× in 1–2.5×)', (await rate()) === 2.35, `${await rate()}×`);
  await press('g'); // preferred 3.1 (above the zone)
  await watch(5);
  check('climbs again above the zone (from 3.1×)', (await rate()) > 3.1, `${await rate()}×`);

  // Your own choice per key: make D (faster) pause instead.
  const shortcuts = (await worker.evaluate(async () => (await chrome.storage.sync.get('speedController')).speedController.shortcuts))
    ?? null;
  const list = shortcuts ?? [
    { action: 'display', code: 'KeyV', value: 0 }, { action: 'slower', code: 'KeyS', value: 0.05 },
    { action: 'faster', code: 'KeyD', value: 0.05 }, { action: 'reset', code: 'KeyR', value: 1 },
    { action: 'preferred', code: 'KeyG', value: 3.1 }, { action: 'preferred', code: 'KeyH', value: 2.95 },
    { action: 'preferred', code: 'KeyU', value: 2.35 }, { action: 'ramp', code: 'KeyA', value: 0 },
  ];
  await setSpeed({ shortcuts: list.map((s) => (s.action === 'faster' ? { ...s, ramp: 'pause' } : s)) });
  await page.waitForTimeout(300);
  await press('d');
  check('custom: D set to "Pause" pauses', await paused(), `paused=${await paused()}`);

  await press('a'); // off
  await press('a'); // on again: clears the pause
  check('turning speed-up off and on clears the pause', !(await paused()), `paused=${await paused()}`);
} finally {
  await context.close();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
