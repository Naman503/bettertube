// The speed controller must reach every audio/video: detached `new Audio()`,
// audio in a cross-origin iframe (keys pressed on the main page), audio inside
// a web component's shadow DOM, and the main video when a muted preview video
// starts later. Local fake sites, generated test media.
// Usage: npm run build && node tests/media-everywhere.mjs
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

mkdirSync('test-results/fixtures', { recursive: true });
const VIDEO = 'test-results/fixtures/long.webm';
const AUDIO = 'test-results/fixtures/tone.webm';
if (!existsSync(VIDEO)) {
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15', '-t', '600',
    '-c:v', 'libvpx-vp9', '-b:v', '40k', '-deadline', 'realtime', '-cpu-used', '8', VIDEO]);
}
if (!existsSync(AUDIO)) {
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=600', '-c:a', 'libopus', '-b:a', '24k', AUDIO]);
}
const PAGES = {
  // Audio created in script and never put on the page.
  '/detached': `<button id="go">play</button><script>
    const a = new Audio('/tone.webm'); window.__media = a;
    document.getElementById('go').onclick = () => a.play();</script>`,
  // The player lives in a cross-origin iframe.
  '/frame-host': `<iframe src="https://player.example/plain-audio" width="400" height="120" allow="autoplay"></iframe>`,
  '/plain-audio': `<audio src="/tone.webm" controls></audio><script>window.__media = document.querySelector('audio');</script>`,
  // Audio inside a web component's (closed-to-page-CSS) shadow DOM.
  '/shadow': `<my-player></my-player><script>
    customElements.define('my-player', class extends HTMLElement {
      connectedCallback() { const r = this.attachShadow({ mode: 'open' }); r.innerHTML = '<audio src="/tone.webm" controls></audio>'; window.__media = r.querySelector('audio'); }
    });</script>`,
  // Main video, then a muted autoplaying preview that starts later.
  // Video on the page, keyboard focus inside a frame with no media (a chat box).
  '/video-plus-chat': `<video id="main" src="/long.webm" width="800" height="450"></video>
    <iframe src="https://chat.example/chat" width="400" height="300" style="position:absolute;right:0;bottom:0"></iframe>
    <script>window.__media = document.getElementById('main');</script>`,
  '/chat': `<div style="height:300px;background:#eee">chat (no media)</div>`,
  '/preview': `<video id="main" src="/long.webm" width="960" height="540"></video>
    <div style="position:absolute;right:0;bottom:0"><video id="preview" src="/long.webm?p" width="320" height="180" muted loop></video></div>
    <script>window.__media = document.getElementById('main');</script>`,
};
const ext = resolve('dist');
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'bt-media-')), {
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' }),
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required'],
});
await context.route(/^https:\/\/[a-z-]+\.example\//, (route) => {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith('.webm')) {
    return route.fulfill({ status: 200, contentType: url.pathname.includes('tone') ? 'audio/webm' : 'video/webm', body: readFileSync(url.pathname.includes('tone') ? AUDIO : VIDEO) });
  }
  return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><body style="margin:0">${PAGES[url.pathname] ?? ''}</body>` });
});

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const rateIn = (frame) => frame.evaluate(() => window.__media.playbackRate);
const pressD = async (page, times = 2) => {
  await page.mouse.click(1250, 780); // focus the main page, away from players
  for (let i = 0; i < times; i++) await page.keyboard.press('d');
  await page.waitForTimeout(500);
};
// All pages share one site, so per-site memory carries the speed between
// them; check the change (+0.10 for two presses), not the absolute value.
const up = (before, after) => Math.abs(after - before - 0.1) < 0.001;

try {
  // 1. Detached audio.
  let page = await context.newPage();
  await page.goto('https://site.example/detached');
  await page.click('#go');
  await page.waitForTimeout(1500);
  let before = await rateIn(page.mainFrame());
  await pressD(page);
  check('detached new Audio(): D works', up(before, await rateIn(page.mainFrame())), `${before}× → ${await rateIn(page.mainFrame())}×`);
  await page.close();

  // 2. Audio in a cross-origin iframe, keys on the main page.
  page = await context.newPage();
  await page.goto('https://site.example/frame-host');
  await page.waitForTimeout(1000);
  const frame = page.frames().find((f) => f.url().includes('player.example'));
  await frame.evaluate(() => window.__media.play());
  await page.waitForTimeout(1500);
  before = await rateIn(frame);
  await pressD(page);
  check('audio in a cross-origin iframe: D on the main page works', up(before, await rateIn(frame)), `${before}× → ${await rateIn(frame)}×`);
  await page.close();

  // 3. Audio inside shadow DOM, while an earlier paused media exists? (plain case)
  page = await context.newPage();
  await page.goto('https://site.example/shadow');
  await page.evaluate(() => window.__media.play());
  await page.waitForTimeout(1500);
  before = await rateIn(page.mainFrame());
  await pressD(page);
  check('audio inside a web component (shadow DOM): D works', up(before, await rateIn(page.mainFrame())), `${before}× → ${await rateIn(page.mainFrame())}×`);
  await page.close();

  // 4. Muted preview starts after the main video: keys must still drive the main video.
  page = await context.newPage();
  await page.goto('https://site.example/preview');
  await page.evaluate(() => document.getElementById('main').play());
  await page.waitForTimeout(1000);
  await page.evaluate(() => document.getElementById('preview').play());
  await page.waitForTimeout(1000);
  const rates = () => page.evaluate(() => ({ main: document.getElementById('main').playbackRate, preview: document.getElementById('preview').playbackRate }));
  const r0 = await rates();
  await pressD(page);
  const r = await rates();
  check('main video, not the muted preview, gets the shortcut', up(r0.main, r.main) && r.preview === r0.preview, `${JSON.stringify(r0)} → ${JSON.stringify(r)}`);
  await page.close();

  // 5. Media on the page, focus in a frame without media.
  page = await context.newPage();
  await page.goto('https://site.example/video-plus-chat');
  await page.evaluate(() => window.__media.play());
  await page.waitForTimeout(1500);
  before = await rateIn(page.mainFrame());
  await page.mouse.click(1150, 700); // inside the chat frame
  await page.keyboard.press('d');
  await page.keyboard.press('d');
  await page.waitForTimeout(600);
  check('focus in a frame without media: D still reaches the page video', up(before, await rateIn(page.mainFrame())), `${before}× → ${await rateIn(page.mainFrame())}×`);
  await page.close();
} finally {
  await context.close();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
