// Dev helper: prints YouTube page + player experiment flags whose names match
// a regex, from a live (logged-out) watch page.
// Usage: node tests/flags-dump.mjs <regex> [url]
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [pattern = '.', url = 'https://www.youtube.com/watch?v=aircAruvnKk'] = process.argv.slice(2);
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'bt-flags-')), {
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' }),
  headless: true,
});
const page = await context.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#movie_player', { timeout: 30_000 });
await page.waitForTimeout(2000);
const out = await page.evaluate((src) => {
  const re = new RegExp(src, 'i');
  const store = window.ytcfg?.data_ ?? window.yt?.config_;
  const page = Object.entries(store?.EXPERIMENT_FLAGS ?? {}).filter(([k]) => re.test(k));
  const cfgs = store?.WEB_PLAYER_CONTEXT_CONFIGS ?? {};
  const watch = cfgs.WEB_PLAYER_CONTEXT_CONFIG_ID_KEVLAR_WATCH ?? Object.values(cfgs)[0];
  const player = [...new URLSearchParams(watch?.serializedExperimentFlags ?? '')].filter(([k]) => re.test(k));
  return { page, player };
}, pattern);
console.log('PAGE FLAGS'); for (const [k, v] of out.page) console.log(`  ${k}=${v}`);
console.log('PLAYER FLAGS'); for (const [k, v] of out.player) console.log(`  ${k}=${v}`);
await context.close();
