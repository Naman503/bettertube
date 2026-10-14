// Loads dist/ into Playwright's Chromium and checks the main fixes on live,
// logged-out YouTube. Usage: npm run build && npm run test:smoke [-- --headed]
// Set CHROMIUM_PATH to reuse an already-downloaded Chromium build.
import { chromium } from 'playwright';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ext = resolve('dist');
const outDir = process.env.SMOKE_OUT ?? 'test-results';
mkdirSync(outDir, { recursive: true });
const VIDEO = 'https://www.youtube.com/watch?v=aircAruvnKk';
const VIDEO_2 = 'https://www.youtube.com/watch?v=IHZwWFHWa-w';
const SEARCH = 'https://www.youtube.com/results?search_query=python+tutorial';

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'bt-')), {
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' }),
  headless: !process.argv.includes('--headed'),
  viewport: { width: 1440, height: 900 },
  colorScheme: 'dark',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required'],
});

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const rate = (page) => page.evaluate(() => document.querySelector('#movie_player video').playbackRate);
const isTheater = (page) =>
  page.evaluate(() => {
    const f = document.querySelector('ytd-watch-flexy');
    return !!f && (f.hasAttribute('theater') || f.hasAttribute('full-bleed-player'));
  });

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extId = new URL(worker.url()).host;

  // Simulate a remembered theater mode; the extension should open normal view anyway.
  await context.addCookies([
    { name: 'wide', value: '1', domain: '.youtube.com', path: '/' },
    // SMOKE_DARK=1 → YouTube's dark theme (PREF f6=400).
    ...(process.env.SMOKE_DARK ? [{ name: 'PREF', value: 'f6=400', domain: '.youtube.com', path: '/' }] : []),
  ]);

  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('  page error:', e.message.slice(0, 160)));
  await page.goto(VIDEO, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#movie_player video', { timeout: 30_000 });
  await page.waitForTimeout(4000);

  // ---- view mode ----
  check('opens in normal view despite wide=1', !(await isTheater(page)));
  // YouTube flipping to theater late (a scripted, not user, click) gets corrected.
  await page.evaluate(() => document.querySelector('#movie_player .ytp-size-button').click());
  await page.waitForTimeout(1500);
  check('late switch to theater is reverted', !(await isTheater(page)));
  // A real user toggle sticks.
  await page.locator('#movie_player').hover();
  await page.locator('#movie_player .ytp-size-button').click();
  await page.waitForTimeout(1500);
  check("user's own theater toggle is respected", await isTheater(page));
  await page.locator('#movie_player .ytp-size-button').click();
  await page.waitForTimeout(800);

  // Fullscreen with "f" right after opening a video must stick (regression: the
  // theater guard used to see a window-filling player and switch it back).
  await page.goto(VIDEO_2, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#movie_player video', { timeout: 30_000 });
  await page.waitForTimeout(2500);
  await page.locator('#movie_player').click({ position: { x: 400, y: 300 } }); // focus player (toggles play)
  await page.keyboard.press('k');
  await page.keyboard.press('f');
  await page.waitForTimeout(2500);
  const fs = await page.evaluate(() => ({
    element: !!document.fullscreenElement,
    attr: !!document.querySelector('ytd-watch-flexy[fullscreen]'),
  }));
  check('"f" fullscreen stays fullscreen', fs.element && fs.attr, JSON.stringify(fs));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1200);
  await page.goto(VIDEO, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#movie_player video', { timeout: 30_000 });
  await page.waitForTimeout(3000);

  // ---- MAIN world ----
  const recon = await page.evaluate(
    () =>
      new Promise((done) => {
        document.addEventListener('bettertube:to-isolated', (e) => {
          const msg = JSON.parse(e.detail);
          if (msg.type === 'recon-result' && msg.id === 'smoke') done(msg.data);
        });
        document.dispatchEvent(new CustomEvent('bettertube:to-main', { detail: JSON.stringify({ type: 'recon', id: 'smoke' }) }));
        setTimeout(() => done(null), 2000);
      }),
  );
  check('MAIN-world bridge responds', !!recon);
  check('AV1 not in use', !/av01/.test(recon?.currentCodecs ?? ''), recon?.currentCodecs ?? '');
  check('video info incl. description', !!recon?.video?.description, `${recon?.video?.author} · ${recon?.video?.description?.length} chars`);

  // ---- layout ----
  const layout = await page.evaluate(() => {
    const secondary = document.querySelector('ytd-watch-flexy #secondary');
    const comments = document.querySelector('ytd-watch-flexy ytd-comments#comments');
    return {
      relatedInSidebar: !!secondary?.querySelector('#related'),
      // (YouTube keeps a second, hidden comments copy in a side panel; check the main one.)
      commentsInSidebar: !!comments && !!secondary?.contains(comments),
      sidebarWidth: Math.round(secondary?.getBoundingClientRect().width ?? 0),
    };
  });
  check('up-next videos in right sidebar', layout.relatedInSidebar);
  check('comments not in sidebar', !layout.commentsInSidebar);
  // 402px column + YouTube's 16px gutter.
  check('compact sidebar is 402px', Math.abs(layout.sidebarWidth - 418) <= 2, `${layout.sidebarWidth}px`);

  // ---- resize by dragging the divider ----
  const handle = page.locator('.bt-resize-handle');
  const box = await handle.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 150, box.y + 200, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(600);
  }
  const dragged = await page.evaluate(() => Math.round(document.querySelector('ytd-watch-flexy #secondary').getBoundingClientRect().width));
  check('drag divider resizes up-next column', dragged - layout.sidebarWidth >= 140, `${layout.sidebarWidth}px → ${dragged}px`);
  await handle.dblclick();
  await page.waitForTimeout(800);
  const reset = await page.evaluate(() => Math.round(document.querySelector('ytd-watch-flexy #secondary').getBoundingClientRect().width));
  check('double-click divider resets width', Math.abs(reset - layout.sidebarWidth) <= 2, `${reset}px`);

  // ---- speed controller (VSC-style, every site) ----
  const shadowText = (sel) =>
    page.evaluate((sel) => document.querySelector('.bt-speed-controller')?.shadowRoot?.querySelector(sel)?.textContent ?? null, sel);
  check('speed overlay on the video', (await page.locator('.bt-speed-controller').count()) === 1, `shows ${await shadowText('.speed')}`);
  await page.locator('body').click({ position: { x: 5, y: 600 } }).catch(() => {});
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  const press = async (key, times = 1) => {
    for (let i = 0; i < times; i++) await page.keyboard.press(key);
    await page.waitForTimeout(150);
    return rate(page);
  };
  check('D ×4 → +0.20', (await press('d', 4)) === 1.2, `${await rate(page)}×`);
  check('S → −0.05', (await press('s')) === 1.15, `${await rate(page)}×`);
  check('G → preferred 3.1×', (await press('g')) === 3.1, `${await rate(page)}×`);
  check('G again → back to 1.15×', (await press('g')) === 1.15, `${await rate(page)}×`);
  check('U → preferred 2.35×', (await press('u')) === 2.35, `${await rate(page)}×`);
  check('R → reset 1×', (await press('r')) === 1, `${await rate(page)}×`);
  check('R again → back to 2.35×', (await press('r')) === 2.35, `${await rate(page)}×`);
  check('P → 16×', (await press('p')) === 16, `${await rate(page)}×`);
  const t0 = await page.evaluate(() => document.querySelector('#movie_player video').currentTime);
  await press('x');
  const t1 = await page.evaluate(() => document.querySelector('#movie_player video').currentTime);
  check('X → advance 10s', t1 - t0 >= 9.5, `${t0.toFixed(1)} → ${t1.toFixed(1)}`);
  await press('y'); // 3.6×
  check('overlay shows current speed', (await shadowText('.speed')) === '3.60', String(await shadowText('.speed')));
  check('YouTube shortcuts untouched (k still pauses)', await (async () => {
    await page.keyboard.press('k');
    await page.waitForTimeout(300);
    const paused = await page.evaluate(() => document.querySelector('#movie_player video').paused);
    await page.keyboard.press('k');
    return paused;
  })());
  // Panel: click the speed number.
  await page.locator('#movie_player').hover();
  await page.evaluate(() => document.querySelector('.bt-speed-controller').shadowRoot.querySelector('.speed').dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, clientX: 50, clientY: 50, pointerId: 1 })));
  await page.evaluate(() => document.querySelector('.bt-speed-controller').shadowRoot.querySelector('.speed').dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true, pointerId: 1 })));
  await page.waitForTimeout(200);
  const panelOpen = await page.evaluate(() => !document.querySelector('.bt-speed-controller').shadowRoot.querySelector('.panel').hidden);
  check('click speed → options panel', panelOpen);
  await page.evaluate(() => [...document.querySelector('.bt-speed-controller').shadowRoot.querySelectorAll('.chip')].find((c) => c.textContent === '2.95×').click());
  check('panel preset 2.95×', (await rate(page)) === 2.95, `${await rate(page)}×`);
  await page.screenshot({ path: `${outDir}/speed-panel.png` });
  check('video still playing after overlay clicks', await page.evaluate(() => !document.querySelector('#movie_player video').paused));

  // Let stats accumulate a little, then open another video: remembered speed applies.
  await page.waitForTimeout(8000);
  await page.goto(VIDEO_2, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#movie_player video', { timeout: 30_000 });
  await page.waitForTimeout(5000);
  check('remembered speed on next video', (await rate(page)) === 2.95, `${await rate(page)}×`);
  await page.screenshot({ path: `${outDir}/watch.png` });

  // Another site: a plain video file.
  const other = await context.newPage();
  await other.goto('https://www.w3schools.com/html/mov_bbb.mp4', { waitUntil: 'domcontentloaded' });
  await other.waitForSelector('video', { timeout: 20_000 });
  await other.evaluate(() => { const v = document.querySelector('video'); v.muted = true; return v.play(); }).catch(() => {});
  await other.waitForTimeout(1500);
  const otherStart = await other.evaluate(() => document.querySelector('video').playbackRate);
  await other.keyboard.press('d');
  await other.waitForTimeout(150);
  const otherAfter = await other.evaluate(() => document.querySelector('video').playbackRate);
  check('works on other sites (remembered + D)', otherStart === 2.95 && otherAfter === 3, `${otherStart}× → ${otherAfter}×`);
  await other.close();

  // ---- simulated 2026 layout: 2-column, 625px up-next grid ----
  const sim = await context.newPage();
  await sim.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const st = document.createElement('style');
      st.textContent = `
        ytd-watch-flexy #secondary { width: 625px !important; min-width: 625px !important; }
        ytd-watch-next-secondary-results-renderer #items { display: grid !important; grid-template-columns: 1fr 1fr !important; }`;
      document.head.append(st);
    });
  });
  await sim.goto(VIDEO, { waitUntil: 'domcontentloaded' });
  await sim.waitForSelector('#movie_player video', { timeout: 30_000 });
  await sim.waitForTimeout(5000);
  const simLayout = await sim.evaluate(() => {
    const items = document.querySelector('ytd-watch-next-secondary-results-renderer #items');
    const sec = document.querySelector('ytd-watch-flexy #secondary').getBoundingClientRect();
    const player = document.querySelector('#movie_player').getBoundingClientRect();
    return {
      cols: items ? getComputedStyle(items).gridTemplateColumns.split(' ').length : -1,
      width: Math.round(sec.width),
      overlap: Math.round(player.right - sec.left),
    };
  });
  check('simulated grid collapsed to one column', simLayout.cols === 1, `${simLayout.cols} column(s)`);
  check('simulated wide column resized', simLayout.width <= 420, `${simLayout.width}px`);
  check('player not under up-next', simLayout.overlap <= 0, `overlap ${simLayout.overlap}px`);
  await sim.screenshot({ path: `${outDir}/simulated-grid.png` });
  const snap = await worker.evaluate(async () => (await chrome.storage.local.get('diag:auto'))['diag:auto']);
  check('auto snapshot saved', !!snap?.sidebar?.upNextChain?.length, snap ? `${snap.label} · ${JSON.stringify(snap).length} bytes` : 'none');
  await sim.close();

  // ---- description box when YouTube hides its own ----
  const page2 = await context.newPage();
  await page2.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const s = document.createElement('style');
      s.textContent = 'ytd-watch-metadata #description { display: none !important; }';
      document.head.append(s);
    });
  });
  await page2.goto(VIDEO, { waitUntil: 'domcontentloaded' });
  await page2.waitForSelector('#movie_player video', { timeout: 30_000 });
  await page2.waitForTimeout(5000);
  const desc = await page2.evaluate(() => {
    const box = document.getElementById('bt-description');
    return box ? { text: box.innerText.slice(0, 80), links: box.querySelectorAll('a').length } : null;
  });
  check('description box rendered under video', !!desc, desc ? `${desc.links} links · "${desc.text.replace(/\n/g, ' ')}…"` : 'missing');
  await page2.locator('#bt-description').scrollIntoViewIfNeeded().catch(() => {});
  await page2.screenshot({ path: `${outDir}/description.png` });
  await page2.close();

  // ---- stats ----
  const badge = await page.evaluate(() => document.getElementById('bt-stats-badge')?.innerText.replace(/\s+/g, ' ').trim() ?? null);
  check('stats badge in top bar', !!badge, badge ?? 'missing');
  await page.screenshot({ path: `${outDir}/masthead.png`, clip: { x: 900, y: 0, width: 540, height: 60 } });
  const stats = await worker.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const day = Object.entries(all).find(([k]) => k.startsWith('stats:day:'))?.[1];
    return day ? { watchMs: day.watchMs, activeMs: day.activeMs, videos: Object.keys(day.videos).length, contentSec: day.contentSec } : null;
  });
  check('stats recorded', (stats?.watchMs ?? 0) > 5000, JSON.stringify(stats));

  const dash = await context.newPage();
  dash.on('pageerror', (e) => console.log('  dashboard error:', e.message));
  await dash.setViewportSize({ width: 1280, height: 1400 });
  await dash.goto(`chrome-extension://${extId}/dashboard.html`);
  await dash.waitForTimeout(800);
  const tiles = await dash.locator('.tile').count();
  check('dashboard renders tiles', tiles >= 8, `${tiles} tiles`);
  await dash.screenshot({ path: `${outDir}/dashboard.png`, fullPage: true });

  // ---- shorts ----
  await page.goto(SEARCH, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('ytd-video-renderer, yt-lockup-view-model', { timeout: 30_000 });
  await page.waitForTimeout(4000);
  const shorts = await page.evaluate(() => {
    const all = [...document.querySelectorAll('a[href^="/shorts/"]')];
    return { total: all.length, visible: all.filter((a) => a.getClientRects().length > 0).length };
  });
  check('Shorts hidden in search', shorts.visible === 0, `${shorts.visible} visible of ${shorts.total}`);
} finally {
  await context.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
