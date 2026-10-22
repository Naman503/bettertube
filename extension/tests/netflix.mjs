// Netflix: BetterTube stays out entirely (its player went black), and on
// other sites a video played before being attached stays where the page puts it.
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
// A player that creates its video, plays it, and only then attaches it.
const PAGE = `<!doctype html><body style="margin:0"><div id="player" style="width:960px;height:540px"></div><script>
  const v = document.createElement('video'); v.src = '/v.webm'; v.muted = true; v.width = 960; v.height = 540;
  v.play().catch(() => {});
  setTimeout(() => document.getElementById('player').append(v), 300);
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
const state = (page) => page.evaluate(() => ({
  inPlayer: document.querySelector('video')?.parentElement?.id === 'player',
  holder: !!document.querySelector('bt-media-holder'),
  overlay: !!document.querySelector('.bt-speed-controller'),
  rate: document.querySelector('video')?.playbackRate,
}));
const visit = async (url) => {
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 3, null, { timeout: 30_000 });
  await page.waitForTimeout(1500);
  await page.mouse.click(1200, 750);
  await page.keyboard.press('d');
  await page.waitForTimeout(600);
  return page;
};
try {
  const nf = await visit('https://www.netflix.com/watch/1');
  const n = await state(nf);
  check('Netflix: video stays in its player', n.inPlayer, JSON.stringify(n));
  check('Netflix: no BetterTube overlay or holder', !n.overlay && !n.holder);
  check('Netflix: shortcuts left to Netflix (speed untouched)', n.rate === 1, `${n.rate}×`);

  const other = await visit('https://site-a.example/');
  const o = await state(other);
  check('other sites: video played before attaching stays in its player', o.inPlayer && !o.holder, JSON.stringify(o));
  check('other sites: speed controller still works', o.overlay && o.rate > 1, `${o.rate}×`);
} finally {
  await context.close();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
