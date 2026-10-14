// Reproduces the signed-in 2026 "side rail / split scroll" watch layout on
// logged-out YouTube by injecting the account's experiment flags (taken from a
// real diag:auto snapshot), then checks BetterTube's fixes against it.
// Usage: node tests/user-layout-sim.mjs [--no-override]
import { chromium } from 'playwright';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const USER_FLAGS = {
  web_side_rail_dismissible_panels: true,
  web_side_rail_default_dismissed_panels: true,
  disable_theater_mode: true,
  web_watch_split_scroll: true,
  web_watch_fixed_default_panels: true,
  web_fixed_panel_watch_next_grid_swap: true,
  web_watch_use_sidebar_width_percentage: true,
  web_watch_use_secondary_max_width_percent: true,
  web_watch_variable_sidebar_width_buckets: ['0:22.5', '1550:27.5', '1900:32.5'],
  kevlar_watch_sidebar_width_percentage: 0.275,
  web_watch_secondary_max_width_percent: 0.4,
};
const override = !process.argv.includes('--no-override');
const ext = resolve('dist');
const out = 'test-results';
mkdirSync(out, { recursive: true });

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'bt-user-')), {
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' }),
  headless: true,
  viewport: { width: 1600, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required'],
});
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
if (!override) await worker.evaluate(() => chrome.storage.sync.set({ settings: { classicLayout: false } }));

// "Server" flags: injected into ytcfg.set's arguments, before anything reads them.
await context.addInitScript((flags) => {
  let real;
  const inject = (o) => {
    if (o && typeof o === 'object' && o.EXPERIMENT_FLAGS) Object.assign(o.EXPERIMENT_FLAGS, flags);
  };
  Object.defineProperty(window, 'ytcfg', {
    configurable: true,
    get: () => real,
    set(v) {
      real = v;
      if (v?.set && !v.set.__sim) {
        const orig = v.set;
        v.set = function (...a) {
          if (typeof a[0] === 'string' && a[0] === 'EXPERIMENT_FLAGS') Object.assign(a[1], flags);
          else inject(a[0]);
          return orig.apply(this, a);
        };
        v.set.__sim = true;
      }
    },
  });
}, USER_FLAGS);

const page = await context.newPage();
await page.goto('https://www.youtube.com/watch?v=aircAruvnKk', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#movie_player video', { timeout: 30_000 });
await page.waitForTimeout(6000);
const state = () =>
  page.evaluate(() => {
    const flexy = document.querySelector('ytd-watch-flexy');
    const sec = document.querySelector('ytd-watch-flexy #secondary');
    const inner = document.querySelector('ytd-watch-flexy #secondary-inner');
    const spacer = document.querySelector('#secondary-split-scroll-spacer');
    const items = document.querySelector('ytd-watch-next-secondary-results-renderer #contents');
    const player = document.querySelector('#movie_player').getBoundingClientRect();
    const s = sec?.getBoundingClientRect();
    const flags = (window.ytcfg?.data_ ?? window.yt?.config_)?.EXPERIMENT_FLAGS ?? {};
    return {
      flagSplit: flags.web_watch_split_scroll,
      flagRail: flags.web_side_rail_dismissible_panels,
      splitAttr: flexy?.hasAttribute('split-scroll'),
      theaterAttr: flexy?.hasAttribute('theater'),
      secPosition: sec && getComputedStyle(sec).position,
      spacer: spacer ? Math.round(spacer.getBoundingClientRect().width) : null,
      innerWidth: inner ? Math.round(inner.getBoundingClientRect().width) : null,
      cols: items ? getComputedStyle(items).gridTemplateColumns : null,
      player: [Math.round(player.left), Math.round(player.width)],
      secondary: s ? [Math.round(s.left), Math.round(s.width)] : null,
      viewport: document.documentElement.clientWidth,
    };
  });
const before = await state();
console.log(override ? 'WITH BetterTube flag override' : 'WITHOUT override (classicLayout off)');
console.log(JSON.stringify(before, null, 1));
await page.screenshot({ path: `${out}/user-layout-${override ? 'fixed' : 'raw'}.png` });
if (override) {
  // Size button should now be a real theater toggle.
  await page.locator('#movie_player').hover();
  await page.locator('#movie_player .ytp-size-button').click();
  await page.waitForTimeout(1200);
  console.log('after size-button click:', JSON.stringify(await state()));
}
await context.close();
