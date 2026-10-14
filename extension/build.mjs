// Bundles each entry point into dist/ and copies static files.
// Usage: node build.mjs [--watch]
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
// build.json lets an unpacked install notice a rebuild and reload itself.
const copyStatic = () => {
  cpSync('static', outdir, { recursive: true });
  writeFileSync(`${outdir}/build.json`, JSON.stringify({ builtAt: Date.now() }));
};
copyStatic();

const ctx = await esbuild.context({
  entryPoints: {
    main: 'src/main/index.ts', // MAIN world, document_start
    content: 'src/content/index.ts', // isolated world, document_start
    popup: 'src/popup/popup.ts',
    dashboard: 'src/dashboard/dashboard.ts',
    background: 'src/background.ts', // service worker
    speed: 'src/speed/index.ts', // speed controller, every site
    'speed-main': 'src/speed/main.ts', // MAIN-world helper: off-page and shadow-DOM media
  },
  outdir,
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
  plugins: [{ name: 'copy-static', setup: (b) => b.onEnd(copyStatic) }],
});

if (watch) {
  await ctx.watch();
  console.log('Watching… reload the extension in brave://extensions after changes.');
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
