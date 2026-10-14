// Dev experiment: measures how far ahead YouTube buffers with different player
// flag overrides. Usage: node tests/buffer-experiment.mjs
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.VIDEO_URL ?? 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'; // Big Buck Bunny (Blender, no ads)
const VARIANTS = {
  baseline: {},
  readahead: { html5_minimum_readahead_seconds: '120', html5_maximum_readahead_seconds: '300' },
  noServerDriven: {
    enable_server_driven_readahead: 'false',
    html5_minimum_readahead_seconds: '120',
    html5_maximum_readahead_seconds: '300',
  },
  noServerDrivenBig: {
    enable_server_driven_readahead: 'false',
    html5_minimum_readahead_seconds: '300',
    html5_maximum_readahead_seconds: '600',
    html5_platform_minimum_readahead_seconds: '300',
  },
};

// Same technique as src/main/flags.ts, reduced to player flags.
const patcher = (overrides) => {
  const patch = () => {
    for (const store of [window.ytcfg?.data_, window.yt?.config_]) {
      for (const cfg of Object.values(store?.WEB_PLAYER_CONTEXT_CONFIGS ?? {})) {
        if (typeof cfg?.serializedExperimentFlags !== 'string') continue;
        const p = new URLSearchParams(cfg.serializedExperimentFlags);
        for (const [k, v] of Object.entries(overrides)) p.set(k, v);
        cfg.serializedExperimentFlags = p.toString();
      }
    }
  };
  new MutationObserver(patch).observe(document, { childList: true, subtree: true });
};

for (const [name, overrides] of Object.entries(VARIANTS)) {
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'bt-buf-')), {
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' }),
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const page = await context.newPage();
  await page.addInitScript(patcher, overrides);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#movie_player video', { timeout: 30_000 });
  await page.evaluate(() => { const v = document.querySelector('#movie_player video'); v.muted = true; v.play(); });
  const samples = [];
  for (const t of [15, 35, 60, 90]) {
    await page.waitForTimeout((t - (samples.at(-1)?.t ?? 0)) * 1000);
    samples.push({
      t,
      ...(await page.evaluate(() => {
        const v = document.querySelector('#movie_player video');
        let ahead = 0;
        for (let i = 0; i < v.buffered.length; i++) {
          if (v.buffered.start(i) <= v.currentTime + 0.5 && v.buffered.end(i) > v.currentTime) ahead = v.buffered.end(i) - v.currentTime;
        }
        const s = document.getElementById('movie_player')?.getStatsForNerds?.();
        return { pos: +v.currentTime.toFixed(1), ahead: +ahead.toFixed(1), health: s?.buffer_health_seconds, res: s?.resolution };
      })),
    });
  }
  console.log(name.padEnd(15), samples.map((s) => `t=${s.t}s ahead=${s.ahead}s (pos ${s.pos}, ${s.res})`).join(' | '));
  await context.close();
}
