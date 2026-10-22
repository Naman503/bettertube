// Netflix works (no black screen, seeks go through Netflix's player), videos
// played before being attached stay put, and the per-site off switch in the
// popup leaves a site completely alone.
// Usage: npm run build && node tests/netflix.mjs
import { chromium } from 'playwright';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const FIXTURE = 'test-results/fixtures/long.webm';
if (!existsSync(FIXTURE)) throw new Error(`run tests/ramp.mjs once to generate ${FIXTURE}`);
const ext = resolve('dist');
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'bt-nf-')), {
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' }),
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required'],
});
// Like Netflix: creates its video, plays it, only then attaches it. On
// netflix.com it also fakes Netflix's player API and records seeks.
const PAGE = `<!doctype html><body style="margin:0"><div id="player" style="width:960px;height:540px"></div><script>
  const v = document.createElement('video'); v.src = '/v.webm'; v.muted = true; v.width = 960; v.height = 540;
  v.play().catch(() => {});
  setTimeout(() => document.getElementById('player').append(v), 300);
  window.seeks = []; window.directSeeks = 0;
  if (location.hostname.endsWith('netflix.com')) {
    v.addEventListener('seeking', () => window.directSeeks++);
    const player = { seek: (ms) => window.seeks.push(ms) };
    window.netflix = { appContext: { state: { playerApp: { getAPI: () => ({ videoPlayer: {
      getAllPlayerSessionIds: () => ['watch-1'], getVideoPlayerBySessionId: () => player } }) } } } };
  }
  window.playOffPage = () => { const a = new Audio('/v.webm'); a.muted = true; a.play().catch(() => {}); };
</script></body>`;
await context.route(/^https:\/\/(www\.netflix\.com|[a-z-]+\.example)\//, (route) => {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith('.webm')) return route.fulfill({ status: 200, contentType: 'video/webm', body: readFileSync(FIXTURE) });
  return route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
});
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const state = (page) => page.evaluate(() => ({
  inPlayer: document.querySelector('video')?.parentElement?.id === 'player',
  holder: !!document.querySelector('bt-media-holder'),
  overlay: !!document.querySelector('.bt-speed-controller'),
  rate: document.querySelector('video')?.playbackRate,
}));
const press = async (page, key) => {
  await page.mouse.click(1200, 750);
  await page.keyboard.press(key);
  await page.waitForTimeout(600);
};
const visit = async (url) => {
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 3, null, { timeout: 30_000 });
  await page.waitForTimeout(1500);
  return page;
};
try {
  const nf = await visit('https://www.netflix.com/watch/1');
  await press(nf, 'd');
  let n = await state(nf);
  check('Netflix: video stays in its player (no black screen)', n.inPlayer && !n.holder, JSON.stringify(n));
  check('Netflix: speed controller works', n.overlay && n.rate === 1.05, `${n.rate}×`);
  const before = await nf.evaluate(() => document.querySelector('video').currentTime);
  await press(nf, 'x');
  const seek = await nf.evaluate(() => ({ seeks: window.seeks, direct: window.directSeeks }));
  check('Netflix: X seeks through Netflix\'s player, not the video element', seek.seeks.length === 1 && seek.direct === 0 && Math.abs(seek.seeks[0] - (before + 10) * 1000) < 1500, JSON.stringify(seek));
  await nf.close();

  const a = await visit('https://site-a.example/');
  await press(a, 'd');
  const o = await state(a);
  check('other sites: video played before attaching stays in its player', o.inPlayer && !o.holder, JSON.stringify(o));
  check('other sites: speed controller works', o.overlay && o.rate === 1.1, `${o.rate}×`);

  // Popup switch, as if opened on site A.
  const popup = await context.newPage();
  await popup.addInitScript(() => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    // Extension pages can't see other tabs' addresses: use the tab opened just before this one.
    chrome.tabs.query = async (info) => {
      if (!info.active) return query(info);
      const me = await chrome.tabs.getCurrent();
      return (await query({ windowId: me.windowId })).filter((t) => t.index === me.index - 1);
    };
  });
  await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
  await popup.click('.tabs button[data-tab="speed"]');
  await popup.waitForSelector('#speed-now:not([hidden]) .switch');
  const head = await popup.locator('#speed-now').innerText();
  check('popup shows the site with an on switch', /site-a\.example/.test(head) && (await popup.isChecked('#speed-now .switch input')), head.replace(/\s+/g, ' '));
  if (process.env.SHOT) await popup.locator('#speed-now').screenshot({ path: `${process.env.SHOT}-on.png` });
  await popup.click('#speed-now .switch');
  await popup.waitForTimeout(800);
  if (process.env.SHOT) await popup.locator('#speed-now').screenshot({ path: `${process.env.SHOT}-off.png` });
  const list = await popup.inputValue('#blacklist');
  check('switching off adds the site to the off list', list.split('\n').includes('site-a.example'), JSON.stringify(list));
  check('popup says it is turned off here', /turned off here/i.test(await popup.locator('#speed-now').innerText()));

  const off = await state(a);
  check('turned-off site: overlay removed at once', !off.overlay, JSON.stringify(off));
  await press(a, 'd');
  check('turned-off site: shortcuts do nothing', (await state(a)).rate === 1.1, `${(await state(a)).rate}×`);
  await a.reload();
  await a.waitForFunction(() => document.querySelector('video')?.readyState >= 3);
  await a.waitForTimeout(1200);
  await a.evaluate(() => window.playOffPage());
  await a.waitForTimeout(600);
  const r = await state(a);
  check('turned-off site after reload: page left untouched (no overlay, no audio holder)', !r.overlay && !r.holder && r.inPlayer, JSON.stringify(r));

  await popup.click('#speed-now .switch');
  await popup.waitForTimeout(800);
  check('switching back on removes it from the list', !(await popup.inputValue('#blacklist')).includes('site-a.example'));
  await press(a, 'd');
  const back = await state(a);
  check('…and the controller is back on the site', back.overlay && back.rate > 1, `${back.rate}×`);
} finally {
  await context.close();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
