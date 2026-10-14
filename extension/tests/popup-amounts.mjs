// The gradual speed-up "Step", "Every" and "Skip" fields accept any value.
// Usage: npm run build && node tests/popup-amounts.mjs
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ext = resolve('dist');
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'bt-pop-')), {
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' }),
  headless: true,
  viewport: { width: 380, height: 1400 },
  colorScheme: process.env.SCHEME ?? 'dark',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const page = await context.newPage();
page.on('pageerror', (e) => console.log('  page error:', e.message));
await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
await page.click('.tabs button[data-tab="speed"]');
const stored = () => worker.evaluate(async () => (await chrome.storage.sync.get('speedController')).speedController ?? {});
const amount = (label) => page.locator(`.amount:has(input[aria-label="${label}"])`);
const type = async (label, value) => {
  const input = amount(label).locator('input');
  await input.fill(String(value));
  await input.press('Enter');
  await page.waitForTimeout(250);
};

try {
  await type('Every', 47);
  check('Every: any seconds (47 s)', (await stored()).rampEverySec === 47, `${(await stored()).rampEverySec}`);

  await amount('Every').locator('.seg-btn', { hasText: 'min' }).click();
  await type('Every', 1.5);
  check('Every: minutes (1.5 min = 90 s)', (await stored()).rampEverySec === 90, `${(await stored()).rampEverySec}`);
  check('re-renders in the unit that fits', (await amount('Every').locator('input').inputValue()) === '90'
    || (await amount('Every').locator('.seg-btn[aria-checked="true"]').innerText()) !== '', await amount('Every').locator('input').inputValue());

  await amount('Every').locator('.seg-btn', { hasText: 'h' }).click();
  await type('Every', 0.25);
  check('Every: hours (0.25 h = 900 s)', (await stored()).rampEverySec === 900, `${(await stored()).rampEverySec}`);
  check('shown as 15 min after saving', (await amount('Every').locator('input').inputValue()) === '15'
    && (await amount('Every').locator('.seg-btn[aria-checked="true"]').innerText()) === 'min',
    `${await amount('Every').locator('input').inputValue()} ${await amount('Every').locator('.seg-btn[aria-checked="true"]').innerText()}`);

  await type('Every', 0);
  const err = await amount('Every').locator('.amount-error').isVisible();
  check('invalid value flagged, not saved', err && (await stored()).rampEverySec === 900, `error shown: ${err}`);

  await amount('Every').locator('.chip', { hasText: '2 min' }).click();
  await page.waitForTimeout(250);
  check('preset chip (2 min)', (await stored()).rampEverySec === 120, `${(await stored()).rampEverySec}`);

  await type('Step', 0.007);
  check('Step: any amount (+0.007×)', (await stored()).rampStep === 0.007, `${(await stored()).rampStep}`);

  await type('Skip videos shorter than', 3.5);
  check('Skip: any minutes (3.5)', (await stored()).rampMinVideoMin === 3.5, `${(await stored()).rampMinVideoMin}`);

  await page.locator('.seg[aria-label="Decimal places"] .seg-btn', { hasText: '1' }).click();
  await page.waitForTimeout(250);
  const preview = await page.locator('.decimals-preview').innerText();
  check('decimal places saved and previewed', (await stored()).speedDecimals === 1 && /1\.0 · 2\.5 · 3\.0/.test(preview), preview);

  const eta = await page.locator('#ramp-eta').innerText();
  check('time-to-max estimate updates', /takes about/.test(eta), eta.replace(/\s+/g, ' '));
  await page.locator('#speed-ramp').screenshot({ path: 'test-results/popup-ramp-amounts.png' });
} finally {
  await context.close();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
