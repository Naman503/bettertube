// Gradual speed-up with fast settings (+0.05× every 10 s, max 1.20×), on ad-free
// public sample videos (the controller runs on every site; YouTube ads would pause it).
// Usage: npm run build && node tests/ramp.mjs
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ext = resolve('dist');
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'bt-ramp-')), {
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' }),
  headless: true,
  viewport: { width: 1440, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required'],
});
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const setSpeedSettings = (patch) =>
  worker.evaluate(async (patch) => {
    const cur = (await chrome.storage.sync.get('speedController')).speedController ?? {};
    await chrome.storage.sync.set({ speedController: { ...cur, ...patch } });
  }, patch);
await setSpeedSettings({ ramp: true, rampStep: 0.05, rampEverySec: 10, rampMax: 1.2, rampMinVideoMin: 0, rampOnManual: 'hold' });

const page = await context.newPage();
// A 10-minute test-pattern video, generated once with ffmpeg and served from a
// made-up https origin (content scripts run on any https page).
const FIXTURE = 'test-results/fixtures/long.webm';
if (!existsSync(FIXTURE)) {
  mkdirSync('test-results/fixtures', { recursive: true });
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15', '-t', '600',
    '-c:v', 'libvpx-vp9', '-b:v', '40k', '-deadline', 'realtime', '-cpu-used', '8', FIXTURE]);
}
const ORIGIN = 'https://bettertube-test.example';
await context.route(`${ORIGIN}/**`, (route) => {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith('.webm')) {
    return route.fulfill({ status: 200, contentType: 'video/webm', body: readFileSync(FIXTURE) });
  }
  return route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: `<!doctype html><title>${url.pathname}</title><body style="margin:0;background:#111">
      <video src="/long.webm?${url.pathname}" width="960" height="540" muted></video></body>`,
  });
});
const VIDEO_1 = `${ORIGIN}/first`;
const VIDEO_2 = `${ORIGIN}/second`;
const rate = () => page.evaluate(() => document.querySelector('video').playbackRate);
const label = () => page.evaluate(() => document.querySelector('.bt-speed-controller')?.shadowRoot?.querySelector('.speed')?.textContent);
const playing = () => page.evaluate(() => { const v = document.querySelector('video'); v.muted = true; return v.play(); }).catch(() => {});
/** Wait until `seconds` of real playback have happened (stalls and slow loads don't count). */
const watch = (seconds) =>
  page.evaluate(
    (seconds) =>
      new Promise((done, fail) => {
        const v = document.querySelector('video');
        let watched = 0;
        let last = v.currentTime;
        const deadline = Date.now() + seconds * 1000 + 90_000;
        const t = setInterval(() => {
          const d = v.currentTime - last;
          last = v.currentTime;
          if (d > 0 && d < 5) watched += d / v.playbackRate;
          if (watched >= seconds) {
            clearInterval(t);
            done();
          } else if (Date.now() > deadline) {
            clearInterval(t);
            fail(new Error(`only ${watched.toFixed(1)} s played`));
          }
        }, 200);
      }),
    seconds,
  );
const open = async (url) => {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector('video').readyState >= 3, null, { timeout: 30_000 });
  await playing();
};

try {
  await open(VIDEO_1);
  const start = await rate();
  await watch(23);
  const after = await rate();
  check('climbs while playing (2 steps in ~23 s)', Math.abs(after - (start + 0.1)) < 0.001, `${start}× → ${after}×`);
  check('overlay shows just the speed', (await label()) === after.toFixed(2), await label());

  // Steps land at 10/20/30/40 s of playback; wait past the 4th.
  await watch(20);
  check('stops at max 1.20×', (await rate()) === 1.2, `${await rate()}×`);
  check('overlay shows the max speed', (await label()) === '1.20', await label());

  // Carry over: the next video starts where this one got to.
  await open(VIDEO_2);
  await page.waitForTimeout(2000);
  check('next video starts at the carried-over 1.20×', (await rate()) === 1.2, `${await rate()}×`);

  // Raise the max, then rewind: eases down 0.05 and pauses.
  await setSpeedSettings({ rampMax: 2 });
  await watch(12);
  const beforeRewind = await rate();
  check('keeps climbing after max is raised', beforeRewind > 1.2, `${beforeRewind}×`);
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await playing();
  await page.keyboard.press('z'); // rewind 10 s
  await page.waitForTimeout(2000);
  const eased = await rate();
  check('rewind eases speed down by 0.05', Math.abs(eased - (beforeRewind - 0.05)) < 0.001, `${beforeRewind}× → ${eased}×`);
  await watch(12);
  check('climb pauses after a rewind', (await rate()) === eased, `${await rate()}×`);

  // Manual change with "hold": stops ramping for this video. (S has no
  // speed-up effect; D defaults to "Resume", which would override the hold.)
  await page.keyboard.press('s');
  const manual = await rate();
  await watch(12);
  check('your own change holds the ramp for this video', (await rate()) === manual, `${manual}× → ${await rate()}×`);

  // "A" toggles it off.
  await page.keyboard.press('a');
  await page.waitForTimeout(500);
  const stored = await worker.evaluate(async () => (await chrome.storage.sync.get('speedController')).speedController.ramp);
  check('"A" turns gradual speed-up off', stored === false, `ramp=${stored}`);

  // Regression: +0.005× steps used to stick at 3.01 (2-decimal rounding:
  // 3.01 + 0.005 = 3.01499… → 3.01 forever). The user's own settings.
  await setSpeedSettings({ ramp: true, rampStep: 0.005, rampEverySec: 2, rampMax: 3.05, rampOnManual: 'continue', rampEaseOnRewind: false });
  await page.evaluate(() => (document.querySelector('video').playbackRate = 3));
  await page.waitForTimeout(500);
  await watch(26);
  check('+0.005× every 2 s climbs past 3.01 to 3.05', (await rate()) === 3.05, `${await rate()}×`);
  check('overlay shows it', (await label()) === '3.05', await label());

  // Decimal places on the overlay (display only; the real speed stays 3.05).
  for (const [d, want] of [[0, '3'], [1, '3.1'], [3, '3.050'], ['auto', '3.05']]) {
    await setSpeedSettings({ speedDecimals: d });
    await page.waitForTimeout(400);
    check(`decimal places ${d} → "${want}"`, (await label()) === want && (await rate()) === 3.05, `${await label()} (speed ${await rate()})`);
  }
} finally {
  await context.close();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
