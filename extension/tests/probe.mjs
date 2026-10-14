// Dev helper: dumps the element tree (tag, classes, size, href/title) under a
// selector on a live YouTube page, to write CSS against the real DOM.
// Usage: node tests/probe.mjs <url> <selector> [depth] [--no-ext]
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [url, selector, depthArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const withExt = !process.argv.includes('--no-ext');
const ext = resolve('dist');

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'bt-probe-')), {
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' }),
  headless: true,
  viewport: { width: 1440, height: 900 },
  args: withExt ? [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] : [],
});
const page = await context.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForSelector(selector, { timeout: 30_000 });
await page.waitForTimeout(3000);
const out = await page.evaluate(
  ([sel, maxDepth]) => {
    const lines = [];
    const walk = (el, d) => {
      const r = el.getBoundingClientRect();
      const cls = typeof el.className === 'string' ? el.className.trim().replace(/\s+/g, '.') : '';
      const extra = ['href', 'title', 'aria-label', 'id']
        .map((a) => (el.getAttribute(a) ? `${a}="${el.getAttribute(a).slice(0, 40)}"` : ''))
        .filter(Boolean)
        .join(' ');
      lines.push(`${'  '.repeat(d)}${el.localName}${cls ? '.' + cls : ''} ${Math.round(r.width)}×${Math.round(r.height)} ${extra}`);
      if (d < maxDepth) for (const c of el.children) walk(c, d + 1);
    };
    walk(document.querySelector(sel), 0);
    return lines.join('\n');
  },
  [selector, Number(depthArg ?? 6)],
);
console.log(out);
await context.close();
