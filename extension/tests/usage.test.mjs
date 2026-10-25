// Unit tests for the anonymous-usage helpers (no browser needed).
// Usage: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function load(entry) {
  const out = await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false });
  const file = join(mkdtempSync(join(tmpdir(), 'bt-unit-')), 'm.mjs');
  writeFileSync(file, out.outputFiles[0].text);
  return import(file);
}

const core = await load('src/shared/usageCore.ts');
const usage = await load('src/usage.ts');
const BASE = 'chrome-extension://abcdefghijklmnop/';

test('sanitizeProps keeps enums, numbers and booleans only', () => {
  const p = core.sanitizeProps({
    action: 'faster',
    speed: 'fast',
    on: true,
    n: 3,
    url: 'https://www.youtube.com/watch?v=x',
    title: 'My video title',
    bad_number: Number.NaN,
    BadKey: 'x',
  });
  assert.deepEqual(p, { action: 'faster', speed: 'fast', on: true, n: 3 });
  assert.equal(core.sanitizeProps('nope'), undefined);
  assert.equal(core.sanitizeProps({ url: 'a b' }), undefined);
});

test('sanitizeProps keeps at most 8 keys', () => {
  const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, i]));
  assert.equal(Object.keys(core.sanitizeProps(many)).length, 8);
});

test('every client counter name matches the API pattern', () => {
  for (const n of core.CLIENT_COUNTERS) assert.ok(core.validName(n), n);
  assert.ok(!core.validName('Bad-Name'));
});

test('buckets', () => {
  assert.equal(core.speedBucket(0.75), 'slow');
  assert.equal(core.speedBucket(1.25), 'normal');
  assert.equal(core.speedBucket(2), 'fast');
  assert.equal(core.speedBucket(3.1), 'faster');
  assert.equal(core.minutesBucket(0), '0');
  assert.equal(core.minutesBucket(45), '30_60');
  assert.equal(core.minutesBucket(500), 'gte240');
  assert.equal(core.countBucket(1), '1');
  assert.equal(core.countBucket(7), '4_10');
});

test('settingValue drops free text', () => {
  assert.equal(core.settingValue('no-av1'), 'no-av1');
  assert.equal(core.settingValue(0.555555), 0.556);
  assert.equal(core.settingValue(true), true);
  assert.equal(core.settingValue('youtube.com\nexample.com'), undefined);
  assert.equal(core.settingValue({}), undefined);
});

test('mainWorldUsage accepts only our three MAIN-world counts with known values', () => {
  assert.deepEqual(core.mainWorldUsage('quality_lowered', { to: '720p' }), { n: 'quality_lowered', p: { to: '720p' } });
  assert.deepEqual(core.mainWorldUsage('default_quality_applied', { quality: '1080', exact: 'true' }), {
    n: 'default_quality_applied',
    p: { quality: '1080', exact: 'true' },
  });
  assert.ok(core.mainWorldUsage('layout_flags_applied', { layout: 'true', ambient: 'false', corners: 'false', controls: 'true' }));
  assert.equal(core.mainWorldUsage('speed_changed', { speed: 'fast', via: 'key' }), null);
  assert.equal(core.mainWorldUsage('quality_lowered', { to: 'My title' }), null);
  assert.equal(core.mainWorldUsage('quality_lowered', { to: '720p', extra: 'x' }), null);
  assert.equal(core.mainWorldUsage('quality_lowered', undefined), null);
  assert.equal(core.mainWorldUsage('toString', {}), null);
  assert.equal(core.mainWorldUsage('default_quality_applied', { quality: '1080' }), null);
});

test('scrubStack keeps only our frames, without the extension id', () => {
  const stack = [
    'TypeError: x is null',
    `    at render (${BASE}content.js:10:20)`,
    '    at https://www.youtube.com/s/desktop/app.js:1:2',
    `    at ${BASE}content.js:30:4`,
  ].join('\n');
  const st = core.scrubStack(stack, BASE);
  assert.equal(st, 'at render content.js:10:20\nat content.js:30:4');
  assert.equal(core.scrubStack('Error\n    at https://site/x.js:1:1', BASE), undefined);
});

test('isOurs tells our errors from the page', () => {
  assert.ok(core.isOurs(`${BASE}speed.js`, undefined, BASE, ['speed.js']));
  assert.ok(!core.isOurs('https://www.youtube.com/app.js', undefined, BASE, ['speed.js']));
  assert.ok(!core.isOurs(`${BASE}content.js`, undefined, BASE, ['speed.js']));
  assert.ok(core.isOurs(undefined, `Error: x\n    at f (${BASE}popup.js:1:1)`, BASE, ['popup.js']));
});

test('buildCrash fits the API limits and fingerprints stably', () => {
  const err = { name: 'TypeError', message: 'Cannot read "मेरा वीडियो" Hindititle https://x.com', stack: `TypeError: x\n    at a (${BASE}background.js:1:2)` };
  const a = core.buildCrash('background', err, BASE, true, 1);
  const b = core.buildCrash('background', err, BASE, true, 2);
  assert.equal(a.fp, b.fp);
  assert.ok(a.fp.length <= 64);
  assert.equal(a.m, '[background] TypeError');
  assert.ok(!JSON.stringify(a).includes('Hindi') && !JSON.stringify(a).includes('वीडियो') && !JSON.stringify(a).includes('x.com'));
  // Same class and frames, different text: same fingerprint.
  assert.equal(core.buildCrash('background', { ...err, message: 'other words' }, BASE).fp, a.fp);
  assert.ok(!a.st.includes(BASE));
  assert.equal(a.fatal, true);
  const c = core.buildCrash('popup', 'plain string', BASE);
  assert.equal(c.st, undefined);
  assert.equal(c.m, '[popup] Error');
});

test('counter keys round-trip, with non-string props stringified', () => {
  const k = usage.counterKey('2026-10-26', 'speed_changed', { via: 'key', speed: 'fast', classic: true });
  assert.equal(k, '2026-10-26|speed_changed|classic=true|speed=fast|via=key');
  assert.deepEqual(usage.parseCounterKey(k), {
    day: '2026-10-26',
    name: 'speed_changed',
    props: { classic: 'true', speed: 'fast', via: 'key' },
  });
});
