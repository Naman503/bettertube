// Daily limit: the over-limit pop-up on YouTube (snooze, okay for today, stop
// watching, off switch), and the red over-limit state in the badge, popup
// and dashboard. Today's stats are seeded: 1h 45m watched, 1h 30m limit.
// Usage: npm run build && node tests/daily-limit.mjs [--shots dir]
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const VIDEO = 'https://www.youtube.com/watch?v=aircAruvnKk';
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
const ext = resolve('dist');
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'bt-limit-')), {
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' }),
  headless: true,
  viewport: { width: 1440, height: 900 },
  colorScheme: 'dark',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required'],
});
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const extId = new URL(worker.url()).host;
const today = () => worker.evaluate(() => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
});
const local = (keys) => worker.evaluate((k) => chrome.storage.local.get(k), keys);
const setSettings = (patch) => worker.evaluate(async (p) => {
  const cur = (await chrome.storage.sync.get('settings')).settings ?? {};
  await chrome.storage.sync.set({ settings: { ...cur, ...p } });
}, patch);

const day = await today();
await worker.evaluate(({ day }) => chrome.storage.local.set({
  [`stats:day:${day}`]: {
    date: day, activeMs: 120 * 60_000, watchMs: 105 * 60_000, adMs: 0, contentSec: 6300, hourlyWatchMs: Array(24).fill(0),
    videos: { aircAruvnKk: { title: 'Demo', author: 'Demo', channelId: 'x', durationSec: 7200, watchMs: 105 * 60_000, contentSec: 6300, maxPosSec: 6300, firstAt: Date.now() - 7e6, lastAt: Date.now() } }, sessions: 1, longestSessionMs: 0, stalls: 0, stallMs: 0, droppedFrames: 0, totalFrames: 0, resolutionMs: {}, codecMs: {}, bandwidthKbpsSum: 0, bandwidthSamples: 0, searches: 0,
  },
}), { day });
await setSettings({ dailyLimitMinutes: 90 });

const prompt = (page) => page.locator('#bt-limit-prompt');
const playVideo = (page) => page.evaluate(() => {
  const v = document.querySelector('#movie_player video');
  v.muted = true;
  // Don't wait on play(): logged-out YouTube can leave it pending.
  void v.play().catch(() => {});
});
const paused = (page) => page.evaluate(() => document.querySelector('#movie_player video').paused);
const replay = async (page) => {
  await page.evaluate(() => document.querySelector('#movie_player video').pause());
  await page.waitForTimeout(300);
  await playVideo(page);
};

try {
  const page = await context.newPage();
  await page.goto(VIDEO, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#movie_player video', { timeout: 30_000 });
  await playVideo(page);
  await prompt(page).waitFor({ timeout: 20_000 }).catch(() => {});
  const text = (await prompt(page).innerText().catch(() => '')).replace(/\s+/g, ' ');
  check('over the limit: pop-up appears while watching', /over your daily limit/i.test(text), text.slice(0, 120));
  check('…says how much and how far over', /1h 45m watched today, 15m over your 1h 30m limit/.test(text));
  check('…pauses the video', await paused(page));
  check('…offers okay for today / remind me / stop', /Okay for today/.test(text) && /Remind me in 15 min/.test(text) && /Stop watching/.test(text));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/limit-prompt.png` });

  // Badge
  const badge = await page.evaluate(() => {
    const b = document.getElementById('bt-stats-badge');
    return { level: b?.dataset.level, over: b?.querySelector('.bt-over')?.textContent, shown: b ? getComputedStyle(b.querySelector('.bt-over')).display !== 'none' : false };
  });
  check('badge turns red with an over-limit pill (+15m)', badge.level === 'over' && badge.shown && badge.over === '+15m', JSON.stringify(badge));

  // YouTube's own keys don't fire behind the dialog.
  await page.keyboard.press('k');
  await page.waitForTimeout(300);
  check("YouTube's shortcuts are blocked behind the pop-up", await paused(page));

  // Remind me later
  await page.getByRole('button', { name: 'Remind me in 15 min' }).click();
  await page.waitForTimeout(800);
  const snooze = (await local(['limit:snoozeUntil']))['limit:snoozeUntil'];
  check('remind me: closes, resumes, asks again in 15 min', !(await prompt(page).count()) && !(await paused(page)) && Math.abs(snooze - Date.now() - 15 * 60_000) < 60_000);
  await replay(page);
  await page.waitForTimeout(1500);
  check('…not again while snoozed', !(await prompt(page).count()));

  // Snooze runs out
  await worker.evaluate(() => chrome.storage.local.set({ 'limit:snoozeUntil': Date.now() - 1000 }));
  await page.waitForTimeout(500);
  await replay(page);
  await prompt(page).waitFor({ timeout: 10_000 }).catch(() => {});
  check('after the snooze it asks again', (await prompt(page).count()) === 1);

  // Okay for today
  await page.getByRole('button', { name: 'Okay for today' }).click();
  await page.waitForTimeout(800);
  check('okay for today: closes and resumes', !(await prompt(page).count()) && !(await paused(page)));
  check('…remembered for today', (await local(['limit:ackDay']))['limit:ackDay'] === day);
  await replay(page);
  await page.waitForTimeout(2000);
  check('…no more pop-ups today', !(await prompt(page).count()));

  // Popup + dashboard
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 420, height: 640 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForTimeout(800);
  const pl = await popup.evaluate(() => ({ level: document.getElementById('limit').dataset.level, text: document.getElementById('limit-text').innerText }));
  check('popup: red over-limit line with how far over', pl.level === 'over' && /Over your daily limit by 15m/.test(pl.text), JSON.stringify(pl));
  if (SHOTS) await popup.locator('.card.today').screenshot({ path: `${SHOTS}/limit-popup.png` });

  // Setting the limit: any value to the minute.
  const limitNow = () => worker.evaluate(async () => (await chrome.storage.sync.get('settings')).settings.dailyLimitMinutes);
  await popup.click('.tabs button[data-tab="youtube"]');
  const field = popup.locator('.dur-field');
  await field.scrollIntoViewIfNeeded();
  const [hBox, mBox] = [field.getByLabel('Daily watch limit: hours'), field.getByLabel('Daily watch limit: minutes')];
  check('limit editor shows the current limit (1h 30m)', (await hBox.inputValue()) === '1' && (await mBox.inputValue()) === '30');
  if (SHOTS) await field.screenshot({ path: `${SHOTS}/limit-setting.png` });
  await hBox.fill('0'); await mBox.fill('7'); await mBox.press('Enter');
  await popup.waitForTimeout(300);
  check('any minute value: 7 min', (await limitNow()) === 7, `${await limitNow()}`);
  await hBox.fill('2'); await mBox.fill('13'); await mBox.press('Enter');
  await popup.waitForTimeout(300);
  check('hours + minutes: 2h 13m', (await limitNow()) === 133 && /2h 13m a day/.test(await field.innerText()));
  await hBox.fill('0'); await mBox.fill('95'); await mBox.press('Enter');
  await popup.waitForTimeout(300);
  check('95 minutes becomes 1h 35m', (await limitNow()) === 95 && (await hBox.inputValue()) === '1' && (await mBox.inputValue()) === '35');
  await field.getByRole('button', { name: '+5' }).click();
  await popup.waitForTimeout(300);
  check('+5 adds five minutes (1h 40m)', (await limitNow()) === 100);
  await field.getByRole('button', { name: '45m', exact: true }).click();
  await popup.waitForTimeout(300);
  check('quick pick 45m', (await limitNow()) === 45);
  await hBox.fill('0'); await mBox.fill('0'); await mBox.press('Enter');
  await popup.waitForTimeout(300);
  check('0 is rejected with a message, limit unchanged', (await limitNow()) === 45 && (await field.locator('.amount-error').isVisible()));
  await hBox.fill('25'); await mBox.fill('0'); await mBox.press('Enter');
  await popup.waitForTimeout(300);
  check('over 24h is rejected', (await limitNow()) === 45);
  await field.locator('.switch').click();
  await popup.waitForTimeout(300);
  check('switch off: no limit, editor hidden', (await limitNow()) === 0 && !(await field.locator('.dur').isVisible()));
  await field.locator('.switch').click();
  await popup.waitForTimeout(300);
  check('switch on again: back to 45m', (await limitNow()) === 45);
  await setSettings({ dailyLimitMinutes: 90 });
  await popup.close();
  const dash = await context.newPage();
  dash.on('pageerror', (e) => console.log('  dashboard error:', e.message));
  await dash.goto(`chrome-extension://${extId}/dashboard.html`);
  await dash.waitForSelector('.tile.hero');
  await dash.waitForTimeout(500);
  const d = await dash.evaluate(() => ({ cls: document.querySelector('.tile.hero').className, text: document.querySelector('.tile.hero .status')?.innerText.replace(/\s+/g, ' ') }));
  check('dashboard: hero card flagged with alert and how far over', /limit-over/.test(d.cls) && /Over your daily limit by 15m/.test(d.text) && /117% of 1h 30m/.test(d.text), JSON.stringify(d));
  if (SHOTS) await dash.locator('.tile.hero').screenshot({ path: `${SHOTS}/limit-dashboard.png` });
  await dash.close();

  // Pop-up switched off
  await worker.evaluate(() => chrome.storage.local.remove('limit:ackDay'));
  await setSettings({ dailyLimitPrompt: false });
  await page.waitForTimeout(800);
  await replay(page);
  await page.waitForTimeout(2000);
  check('pop-up setting off: no pop-up', !(await prompt(page).count()));

  // Stop watching closes the tab
  await setSettings({ dailyLimitPrompt: true });
  await page.waitForTimeout(800);
  await replay(page);
  await prompt(page).waitFor({ timeout: 10_000 }).catch(() => {});
  const closed = page.waitForEvent('close', { timeout: 5000 }).then(() => true).catch(() => false);
  await page.getByRole('button', { name: 'Stop watching' }).click().catch(() => {});
  check('stop watching closes the tab', await closed);
} finally {
  await context.close();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
