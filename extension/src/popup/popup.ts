import type { Diagnostics } from '../shared/diagnostics';
import { DEFAULTS, PRESETS, STORAGE_KEY, withDefaults, type Settings } from '../shared/settings';
import {
  ACTIONS,
  DEFAULT_SPEED_SETTINGS,
  SPEED_KEY,
  RAMP_LIMITS,
  fmtInterval,
  fmtRate,
  fmtRateDisplay,
  keyLabel,
  rampEffectOf,
  RAMP_PAUSED_KEY,
  SITE_SPEEDS_KEY,
  rampMinutesToMax,
  withSpeedDefaults,
  type Shortcut,
  type RampEffect,
  type SpeedAction,
  type SpeedDecimals,
  type SpeedSettings,
} from '../shared/speedSettings';
import { DAY_PREFIX, dayKey, fmtDuration, summarize, type DayStats } from '../shared/stats';
import { SECTIONS, type Field } from './schema';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const VERSION = chrome.runtime.getManifest().version;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// ---------- icons ----------

const ICONS: Record<string, string[]> = {
  home: ['M3 10.5 12 3l9 7.5', 'M5 9.5V21h14V9.5'],
  youtube: ['M3 7.5a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z', 'M10 9v6l5-3z'],
  speed: ['M12 14l4-4', 'M3.5 17a9 9 0 1 1 17 0'],
  health: ['M3 12h4l2.5-6 4 12 2.5-6H21'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-3.5-3.5'],
  alert: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'],
  view: ['M3 5h18v14H3z', 'M15 5v14'],
  layout: ['M3 4h11v9H3z', 'M17 4h4', 'M17 9h4', 'M17 14h4', 'M3 17h11', 'M3 20h8'],
  shorts: ['M4 4l16 16', 'M9 4h8a2 2 0 0 1 2 2v8', 'M15 20H7a2 2 0 0 1-2-2V10'],
  text: ['M4 6h16', 'M4 10h16', 'M4 14h10', 'M4 18h7'],
  gauge: ['M12 14l4-4', 'M3.5 17a9 9 0 1 1 17 0'],
  chart: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M22 20H2'],
};

function icon(name: string) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of ICONS[name] ?? []) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

function hydrateIcons(root: ParentNode = document) {
  for (const slot of root.querySelectorAll<HTMLElement>('[data-icon]')) {
    if (!slot.firstChild) slot.append(icon(slot.dataset.icon!));
  }
}

// ---------- state ----------

let settings: Settings = withDefaults(undefined);
let speed: SpeedSettings = withSpeedDefaults(undefined);
let activeTab: chrome.tabs.Tab | undefined;

async function saveSettings(patch: Partial<Settings>) {
  const before = settings;
  settings = { ...settings, ...patch };
  await chrome.storage.sync.set({ [STORAGE_KEY]: settings });
  const needsReload = SECTIONS.some((s) =>
    s.fields.some((f) => f.reload && f.key in patch && before[f.key] !== settings[f.key]),
  );
  if (needsReload) showReloadAlert();
}

async function saveSpeed(patch: Partial<SpeedSettings>) {
  speed = { ...speed, ...patch };
  await chrome.storage.sync.set({ [SPEED_KEY]: speed });
}

// ---------- alerts ----------

function showAlert(id: string, title: string, body: string, actions: [label: string, fn: () => void][] = []) {
  document.getElementById(id)?.remove();
  const box = el('div', { className: 'alert', id }, el('span', {}, icon('alert')), el('div', {}, el('b', {}, title), body));
  box.firstElementChild!.setAttribute('data-icon', 'alert');
  if (actions.length) {
    box.append(
      el(
        'div',
        { className: 'actions' },
        ...actions.map(([label, fn]) => {
          const b = el('button', { className: 'btn small' }, label);
          b.addEventListener('click', fn);
          return b;
        }),
      ),
    );
  }
  $('alerts').append(box);
}

async function reloadYouTubeTabs() {
  const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
  await Promise.all(tabs.map((t) => chrome.tabs.reload(t.id!)));
  document.getElementById('alert-reload')?.remove();
}

function showReloadAlert() {
  showAlert('alert-reload', 'Reload YouTube to apply', 'Some changes take effect after the page reloads.', [
    ['Reload YouTube tabs', () => void reloadYouTubeTabs()],
  ]);
}

/** Is BetterTube actually running (and current) in the active tab? */
async function checkActiveTab() {
  const status = $('tab-status');
  const tab = activeTab;
  if (!tab?.id || !tab.url?.startsWith('http')) return;

  if (tab.url.startsWith('https://www.youtube.com/')) {
    let ping: { version: string } | null = null;
    try {
      ping = await chrome.tabs.sendMessage(tab.id, { type: 'ping' });
    } catch {
      ping = null;
    }
    status.hidden = false;
    if (ping?.version === VERSION) {
      status.textContent = '● Active on this tab';
      status.className = 'status ok';
    } else {
      status.textContent = 'Reload needed';
      status.className = 'status warn';
      showAlert(
        'alert-stale',
        ping ? `This tab is running an older BetterTube (v${ping.version})` : 'BetterTube is not running in this tab yet',
        'Reload the tab to use the current version.',
        [['Reload tab', () => void chrome.tabs.reload(tab.id!).then(() => window.close())]],
      );
    }
  }

  // Speed controller status (any site).
  try {
    const s = (await chrome.tabs.sendMessage(tab.id, { type: 'speed:status' }, { frameId: 0 })) as {
      vscDetected: boolean;
      rate: number | null;
      active: boolean;
      site: string;
      siteSpeed: number | null;
      perSite: boolean;
    };
    if (s?.vscDetected) {
      showAlert(
        'alert-vsc',
        'Video Speed Controller is also running',
        'Both controllers react to the same keys. Turn the other one off so BetterTube can take over (BetterTube steps aside while it is on).',
        [['Open extensions', () => void chrome.tabs.create({ url: 'chrome://extensions' })]],
      );
    }
    if (s?.rate) {
      const now = $('speed-now');
      now.hidden = false;
      const note = !s.active
        ? 'Controller is off on this site'
        : s.perSite
          ? s.siteSpeed !== null
            ? `Speed on ${s.site} · remembered for this site`
            : `Speed on ${s.site} · your last speed (nothing saved for this site yet)`
          : 'Speed on this tab';
      now.replaceChildren(el('span', { className: 'hint' }, note), el('b', {}, `${fmtRate(s.rate)}×`));
    }
  } catch {
    // No content script here (browser pages, or the tab predates the install).
  }
}

// ---------- Home ----------

async function renderToday() {
  const key = DAY_PREFIX + dayKey();
  const day = (await chrome.storage.local.get(key))[key] as DayStats | undefined;
  const s = summarize(day);
  $('stat-watch').textContent = fmtDuration(s.watchMs);
  $('stat-videos').textContent = String(s.videos);
  $('stat-active').textContent = fmtDuration(s.activeMs);
  $('stat-saved').textContent = fmtDuration(s.savedMs);
  const limitMs = settings.dailyLimitMinutes * 60_000;
  $('limit').hidden = !limitMs;
  if (limitMs) {
    const ratio = s.watchMs / limitMs;
    const fill = $('limit-fill');
    fill.style.width = `${Math.min(100, ratio * 100)}%`;
    fill.style.background = ratio >= 1 ? 'var(--fail)' : ratio >= 0.8 ? 'var(--warn)' : 'var(--ok)';
    $('limit-text').textContent = `${ratio >= 1 ? '✕ Over' : ratio >= 0.8 ? '▲ Close to' : '● Within'} your ${fmtDuration(limitMs)} daily limit · ${Math.round(ratio * 100)}%`;
  }
}

interface Quick {
  label: string;
  icon: string;
  get: () => boolean;
  set: (on: boolean) => Promise<void>;
}

const QUICK: Quick[] = [
  {
    label: 'Open in normal view',
    icon: 'view',
    get: () => settings.viewMode === 'default',
    set: (on) => saveSettings({ viewMode: on ? 'default' : 'remember' }),
  },
  { label: 'Classic layout', icon: 'layout', get: () => settings.classicLayout, set: (on) => saveSettings({ classicLayout: on, compactSidebar: on }) },
  { label: 'Hide Shorts', icon: 'shorts', get: () => settings.hideShorts, set: (on) => saveSettings({ hideShorts: on, redirectShorts: on }) },
  { label: 'Description under video', icon: 'text', get: () => settings.restoreDescription, set: (on) => saveSettings({ restoreDescription: on }) },
  { label: 'Speed controller', icon: 'gauge', get: () => speed.enabled, set: (on) => saveSpeed({ enabled: on }) },
  {
    label: 'Watch stats',
    icon: 'chart',
    get: () => settings.statsEnabled && settings.statsBadge,
    set: (on) => saveSettings({ statsEnabled: on, statsBadge: on }),
  },
];

function renderQuick() {
  $('quick').replaceChildren(
    ...QUICK.map((q) => {
      const b = el('button', { className: 'qs' }, el('span', {}, icon(q.icon)), el('span', { className: 't' }, q.label), el('span', { className: 'dot' }));
      b.firstElementChild!.setAttribute('data-icon', q.icon);
      b.setAttribute('role', 'switch');
      b.setAttribute('aria-checked', String(q.get()));
      b.addEventListener('click', async () => {
        await q.set(!q.get());
        b.setAttribute('aria-checked', String(q.get()));
        renderSections();
        renderSpeed();
      });
      return b;
    }),
  );
  $('presets').replaceChildren(
    ...Object.values(PRESETS).map((p) => {
      const b = el('button', { className: 'preset', title: p.description }, el('b', {}, p.label), el('span', {}, p.description));
      b.addEventListener('click', async () => {
        await saveSettings(p.values);
        renderQuick();
        renderSections();
      });
      return b;
    }),
  );
}

// ---------- YouTube settings ----------

function switchControl(label: string, checked: boolean, onChange: (v: boolean) => void) {
  const input = el('input', { type: 'checkbox', checked });
  input.setAttribute('aria-label', label);
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { className: 'switch' }, input, el('span'));
}

function renderField(f: Field): HTMLElement {
  const text = el('div', { className: 'text' }, f.label);
  if (f.reload) text.append(el('span', { className: 'reload', title: 'Applies after reloading YouTube' }, '↻'));
  if (f.hint) text.append(el('p', { className: 'hint' }, f.hint));
  const row = (control?: HTMLElement) => {
    const r = el('div', { className: control ? 'row' : 'row column' }, text, ...(control ? [control] : []));
    r.dataset.search = `${f.label} ${f.hint ?? ''}`.toLowerCase();
    return r;
  };

  if (f.type === 'toggle') {
    return row(
      switchControl(f.label, Boolean(settings[f.key]), (v) => {
        void saveSettings({ [f.key]: v }).then(renderQuick);
      }),
    );
  }
  if (f.type === 'range') {
    const value = Number(settings[f.key]);
    const input = el('input', { type: 'range', min: String(f.min), max: String(f.max), step: String(f.step) });
    input.value = String(value || f.min);
    input.setAttribute('aria-label', f.label);
    const readout = el('span', { className: 'range-value' });
    const reset = el('button', { className: 'link', title: 'Back to YouTube default' }, 'Reset');
    const show = (v: number) => {
      readout.textContent = v ? `${v} ${f.unit}` : f.zeroLabel;
      reset.hidden = !v;
      input.classList.toggle('unset', !v);
    };
    show(value);
    input.addEventListener('input', () => show(Number(input.value)));
    input.addEventListener('change', () => void saveSettings({ [f.key]: Number(input.value) }));
    reset.addEventListener('click', () => {
      show(0);
      input.value = String(f.min);
      void saveSettings({ [f.key]: 0 });
    });
    text.append(el('div', { className: 'range-row' }, input, readout, reset));
    return row();
  }
  const current = String(settings[f.key]);
  const select = el('select');
  select.setAttribute('aria-label', f.label);
  for (const [value, label] of f.options) {
    select.append(el('option', { value: String(value), selected: String(value) === current }, label));
  }
  select.addEventListener('change', () => {
    const raw = f.options.find(([v]) => String(v) === select.value)![0];
    void saveSettings({ [f.key]: raw }).then(renderQuick);
  });
  return row(select);
}

function renderSections() {
  $('sections').replaceChildren(
    ...SECTIONS.map((s) => el('section', { className: 'card' }, el('h3', {}, s.title), el('div', {}, ...s.fields.map(renderField)))),
  );
  applySearch();
}

function applySearch() {
  const q = ($('search') as HTMLInputElement).value.trim().toLowerCase();
  for (const card of $('sections').children as HTMLCollectionOf<HTMLElement>) {
    let any = false;
    for (const row of card.querySelectorAll<HTMLElement>('.row')) {
      const hit = !q || row.dataset.search!.includes(q);
      row.hidden = !hit;
      any ||= hit;
    }
    card.hidden = !any;
  }
}

// ---------- Speed ----------

/** "Decimal places" for the speed on the video, with a live example. */
function decimalsRow() {
  const options: [SpeedDecimals, string][] = [['auto', 'Auto'], [0, '0'], [1, '1'], [2, '2'], [3, '3']];
  const preview = el('p', { className: 'hint decimals-preview' });
  const showPreview = (d: SpeedDecimals) => {
    preview.replaceChildren(
      'On the video: ',
      ...[1, 2.5, 3.015].flatMap((r, i) => [
        ...(i ? [' · '] : []),
        el('b', {}, fmtRateDisplay(r, d)),
      ]),
      d === 'auto' ? '  (2 decimals, 3 when needed)' : '',
    );
  };
  const seg = el('div', { className: 'seg', role: 'radiogroup' });
  seg.setAttribute('aria-label', 'Decimal places');
  for (const [value, label] of options) {
    const b = el('button', { className: 'seg-btn' }, label);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(speed.speedDecimals === value));
    b.addEventListener('click', () => {
      for (const x of seg.children) x.setAttribute('aria-checked', String(x === b));
      showPreview(value);
      void saveSpeed({ speedDecimals: value });
    });
    seg.append(b);
  }
  showPreview(speed.speedDecimals);
  const text = el('div', { className: 'text' }, 'Decimal places', el('p', { className: 'hint' }, 'How the speed number on the video is written. Display only.'));
  return el('div', { className: 'row column' }, text, el('div', { className: 'decimals' }, seg, preview));
}

function speedRow(label: string, hint: string, control: HTMLElement) {
  const text = el('div', { className: 'text' }, label);
  if (hint) text.append(el('p', { className: 'hint' }, hint));
  return el('div', { className: 'row' }, text, control);
}

function renderSpeed() {
  const opacity = el('input', { type: 'range', min: '0.1', max: '1', step: '0.05', value: String(speed.opacity) });
  opacity.setAttribute('aria-label', 'Controller opacity');
  const opacityValue = el('span', { className: 'range-value' }, `${Math.round(speed.opacity * 100)}%`);
  opacity.addEventListener('input', () => (opacityValue.textContent = `${Math.round(Number(opacity.value) * 100)}%`));
  opacity.addEventListener('change', () => void saveSpeed({ opacity: Number(opacity.value) }));
  const opacityRow = el(
    'div',
    { className: 'row column' },
    el('div', { className: 'text' }, 'Controller opacity', el('div', { className: 'range-row' }, opacity, opacityValue)),
  );

  $('speed-general').replaceChildren(
    speedRow('Enabled', 'On every site with video or audio', switchControl('Enabled', speed.enabled, (v) => void saveSpeed({ enabled: v }).then(renderQuick))),
    speedRow('Remember playback speed', 'New videos start at your last speed', switchControl('Remember speed', speed.rememberSpeed, (v) => void saveSpeed({ rememberSpeed: v }))),
    speedRow(
      'Remember speed per site',
      'Each site keeps its own speed. A new site starts at the speed you used last, until you change it there.',
      switchControl('Remember speed per site', speed.perSiteSpeed, (v) => void saveSpeed({ perSiteSpeed: v }).then(renderSiteSpeeds)),
    ),
    speedRow('Always keep my speed', "Ignore speed changes made by the site's own player", switchControl('Force speed', speed.forceSpeed, (v) => void saveSpeed({ forceSpeed: v }))),
    speedRow('Work on audio', 'Podcasts and audio players too', switchControl('Work on audio', speed.workOnAudio, (v) => void saveSpeed({ workOnAudio: v }))),
    speedRow('Hide controller by default', 'Shortcuts still work; it flashes on change', switchControl('Hide by default', speed.startHidden, (v) => void saveSpeed({ startHidden: v }))),
    decimalsRow(),
    opacityRow,
  );
  renderRamp();
  void renderSiteSpeeds();
  renderShortcuts();
  ($('blacklist') as HTMLTextAreaElement).value = speed.blacklist;
}

function selectControl<T extends string | number>(label: string, options: [T, string][], current: T, onChange: (v: T) => void) {
  const select = el('select');
  select.setAttribute('aria-label', label);
  for (const [value, text] of options) select.append(el('option', { value: String(value), selected: value === current }, text));
  select.addEventListener('change', () => onChange(options.find(([v]) => String(v) === select.value)![0]));
  return select;
}

interface Unit {
  label: string;
  /** Stored value = typed value × factor. */
  factor: number;
  /** Arrow-key step in this unit. */
  step: number;
}

/**
 * A number you can type freely, with an optional unit switch (s / min / h) and
 * one-click presets. Invalid or out-of-range input is flagged, not saved.
 */
function amountControl(o: {
  label: string;
  value: number;
  units: Unit[];
  min: number;
  max: number;
  presets: [value: number, label: string][];
  format: (v: number) => string;
  prefix?: string;
  onChange: (v: number) => void;
}) {
  const fits = (u: Unit) => o.value >= u.factor && Math.abs(o.value / u.factor - Math.round(o.value / u.factor)) < 1e-9;
  let unit = [...o.units].reverse().find(fits) ?? o.units[0];
  const show = (v: number) => String(Math.round((v / unit.factor) * 1000) / 1000);

  const input = el('input', { type: 'number', className: 'amount-input', inputMode: 'decimal', value: show(o.value) });
  input.setAttribute('aria-label', o.label);
  const error = el('p', { className: 'amount-error', hidden: true }, `Enter ${o.format(o.min)} – ${o.format(o.max)}`);
  const setStep = () => {
    input.step = String(unit.step);
    input.min = '0';
  };
  setStep();

  const commit = () => {
    const typed = Number(input.value);
    const v = Math.round(typed * unit.factor * 1000) / 1000;
    const ok = input.value.trim() !== '' && Number.isFinite(typed) && v >= o.min && v <= o.max;
    input.classList.toggle('invalid', !ok);
    error.hidden = ok;
    if (ok && v !== o.value) o.onChange(v);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
  });

  const row = el('div', { className: 'amount-row' });
  if (o.prefix) row.append(el('span', { className: 'amount-prefix' }, o.prefix));
  row.append(input);
  if (o.units.length > 1) {
    const seg = el('div', { className: 'seg', role: 'radiogroup' });
    seg.setAttribute('aria-label', `${o.label} unit`);
    for (const u of o.units) {
      const b = el('button', { className: 'seg-btn' }, u.label);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(u === unit));
      b.addEventListener('click', () => {
        // Same amount, shown in the new unit (90 s ↔ 1.5 min).
        const current = Number(input.value) * unit.factor;
        unit = u;
        setStep();
        input.value = Number.isFinite(current) ? show(current) : input.value;
        for (const x of seg.children) x.setAttribute('aria-checked', String(x === b));
        input.focus();
      });
      seg.append(b);
    }
    row.append(seg);
  } else {
    row.append(el('span', { className: 'amount-unit' }, o.units[0].label));
  }

  const chips = el(
    'div',
    { className: 'amount-chips' },
    ...o.presets.map(([v, label]) => {
      const c = el('button', { className: `chip${Math.abs(v - o.value) < 1e-9 ? ' on' : ''}` }, label);
      c.addEventListener('click', () => o.onChange(v));
      return c;
    }),
  );
  return el('div', { className: 'amount' }, row, chips, error);
}

/** Label and hint on top, a wide control underneath. */
function stackedRow(label: string, hint: string, control: HTMLElement) {
  const text = el('div', { className: 'text' }, label);
  if (hint) text.append(el('p', { className: 'hint' }, hint));
  return el('div', { className: 'row column' }, text, control);
}

const SECONDS: Unit = { label: 's', factor: 1, step: 1 };
const MINUTES: Unit = { label: 'min', factor: 60, step: 0.5 };
const HOURS: Unit = { label: 'h', factor: 3600, step: 0.25 };

function renderRamp() {
  const save = (patch: Partial<SpeedSettings>) => void saveSpeed(patch).then(renderRamp);
  const max = el('input', { type: 'number', className: 'num', min: '1', max: '16', step: '0.05', value: String(speed.rampMax) });
  max.setAttribute('aria-label', 'Maximum speed');
  max.addEventListener('change', () => {
    const v = Number(max.value);
    if (Number.isFinite(v) && v >= 1 && v <= 16) save({ rampMax: Math.round(v * 1000) / 1000 });
  });
  const box = $('speed-ramp');
  box.classList.toggle('ramp-off', !speed.ramp);
  box.replaceChildren(
    speedRow('Gradual speed-up', `Turn on/off from the video too${keyFor('ramp')}`, switchControl('Gradual speed-up', speed.ramp, (v) => save({ ramp: v }))),
    stackedRow(
      'Step',
      'Added each time: type any amount',
      amountControl({
        label: 'Step',
        value: speed.rampStep,
        units: [{ label: '×', factor: 1, step: 0.005 }],
        ...RAMP_LIMITS.step,
        prefix: '+',
        presets: [[0.005, '+0.005'], [0.01, '+0.01'], [0.02, '+0.02'], [0.05, '+0.05'], [0.1, '+0.1']],
        format: (v) => `${v}×`,
        onChange: (v) => save({ rampStep: v }),
      }),
    ),
    stackedRow(
      'Every',
      'Counted only while a video is actually playing: type any time',
      amountControl({
        label: 'Every',
        value: speed.rampEverySec,
        units: [SECONDS, MINUTES, HOURS],
        ...RAMP_LIMITS.everySec,
        presets: [[10, '10 s'], [30, '30 s'], [60, '1 min'], [120, '2 min'], [300, '5 min'], [600, '10 min']],
        format: fmtInterval,
        onChange: (v) => save({ rampEverySec: v }),
      }),
    ),
    speedRow('Up to', 'Never goes above this speed', max),
    speedRow(
      'Carry over to the next video',
      'If you don’t touch the speed, the next video starts where this one got to and keeps climbing',
      switchControl('Carry over', speed.rampCarryOver, (v) => save({ rampCarryOver: v })),
    ),
    speedRow(
      'When I change the speed',
      '',
      selectControl(
        'When I change the speed',
        [
          ['continue', 'Keep climbing'],
          ['hold', 'Stop for this video'],
        ],
        speed.rampOnManual,
        (v) => save({ rampOnManual: v }),
      ),
    ),
    speedRow(
      'Slow down when I rewind',
      'Jumping back means it got too fast: −0.05× and a 1-minute pause',
      switchControl('Ease on rewind', speed.rampEaseOnRewind, (v) => save({ rampEaseOnRewind: v })),
    ),
    quietZoneRow(save),
    stackedRow(
      'Skip videos shorter than',
      'Clips and most ads stay at your speed. 0 ramps everything.',
      amountControl({
        label: 'Skip videos shorter than',
        value: speed.rampMinVideoMin,
        units: [{ label: 'min', factor: 1, step: 0.5 }],
        ...RAMP_LIMITS.minVideoMin,
        presets: [[0, 'Off'], [1, '1 min'], [2, '2 min'], [5, '5 min'], [10, '10 min']],
        format: (v) => `${v} min`,
        onChange: (v) => save({ rampMinVideoMin: v }),
      }),
    ),
  );
  void renderRampEta();
  void renderRampPaused();
}

/** Remembered speed per site, with remove buttons. */
async function renderSiteSpeeds() {
  const card = $('site-speeds-card');
  card.hidden = !speed.perSiteSpeed;
  if (card.hidden) return;
  const stored = ((await chrome.storage.local.get(SITE_SPEEDS_KEY))[SITE_SPEEDS_KEY] ?? {}) as Record<string, number>;
  const sites = Object.entries(stored).sort(([a], [b]) => a.localeCompare(b));
  const save = async (next: Record<string, number>) => {
    await chrome.storage.local.set({ [SITE_SPEEDS_KEY]: next });
    void renderSiteSpeeds();
  };
  const list = $('site-speeds');
  if (!sites.length) {
    list.replaceChildren(el('p', { className: 'hint' }, 'None yet. Change the speed on a site and it is remembered there.'));
  } else {
    list.replaceChildren(
      ...sites.map(([site, rate]) => {
        const del = el('button', { className: 'del', title: `Forget ${site}` }, '✕');
        del.setAttribute('aria-label', `Forget the speed for ${site}`);
        del.addEventListener('click', () => {
          const next = { ...stored };
          delete next[site];
          void save(next);
        });
        return el('div', { className: 'site-row' }, el('span', { className: 'site-name' }, site), el('b', {}, `${fmtRate(rate)}×`), del);
      }),
    );
  }
  $('forget-sites').hidden = !sites.length;
  $('forget-sites').onclick = () => void save({});
}

/** "No speed-up between [1.00]× and [2.00]×" with an on/off switch. */
function quietZoneRow(save: (patch: Partial<SpeedSettings>) => void) {
  const num = (label: string, value: number, key: 'rampQuietFrom' | 'rampQuietTo') => {
    const input = el('input', { type: 'number', className: 'amount-input small', min: '0.07', max: '16', step: '0.05', value: String(value) });
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => {
      const v = Math.round(Number(input.value) * 1000) / 1000;
      const other = key === 'rampQuietFrom' ? speed.rampQuietTo : speed.rampQuietFrom;
      const ok = Number.isFinite(v) && v >= 0.07 && v <= 16 && (key === 'rampQuietFrom' ? v <= other : v >= other);
      input.classList.toggle('invalid', !ok);
      if (ok) save({ [key]: v });
    });
    return input;
  };
  const range = el(
    'div',
    { className: 'amount-row quiet-range' },
    el('span', { className: 'amount-prefix' }, 'between'),
    num('Quiet zone from', speed.rampQuietFrom, 'rampQuietFrom'),
    el('span', { className: 'amount-unit' }, '× and'),
    num('Quiet zone to', speed.rampQuietTo, 'rampQuietTo'),
    el('span', { className: 'amount-unit' }, '×'),
  );
  const text = el(
    'div',
    { className: 'text' },
    'No speed-up in this range',
    el('p', { className: 'hint' }, 'E.g. music at 1–2×. Raise the speed above it and the climb starts again.'),
  );
  const head = el('div', { className: 'quiet-head' }, text, switchControl('Quiet zone', speed.rampQuiet, (v) => save({ rampQuiet: v })));
  const row = el('div', { className: `row column${speed.rampQuiet ? '' : ' quiet-off'}` }, head, range);
  return row;
}

/** "Paused by R: press G, H, D to resume" with a Resume button, when paused. */
async function renderRampPaused() {
  const box = $('ramp-paused');
  const paused = (await chrome.storage.local.get(RAMP_PAUSED_KEY))[RAMP_PAUSED_KEY] === true;
  box.hidden = !(paused && speed.ramp);
  if (box.hidden) return;
  const keys = speed.shortcuts.filter((x) => x.code && rampEffectOf(x) === 'resume').map((x) => keyLabel(x.code));
  const resume = el('button', { className: 'btn small' }, 'Resume');
  resume.addEventListener('click', async () => {
    await chrome.storage.local.set({ [RAMP_PAUSED_KEY]: false });
    void renderRampPaused();
  });
  box.replaceChildren(
    el('span', {}, el('b', {}, 'Paused'), keys.length ? ` · press ${keys.join(', ')} on a video to resume` : ''),
    resume,
  );
}

function keyFor(action: SpeedAction) {
  const sc = speed.shortcuts.find((x) => x.action === action && x.code);
  return sc ? ` · key ${keyLabel(sc.code)}` : '';
}

/** "From your current 1.40×, reaching 2.50× takes ~55 min of watching". */
async function renderRampEta() {
  const local = await chrome.storage.local.get('lastSpeed');
  const from = Math.min((local.lastSpeed as number | undefined) ?? 1, speed.rampMax);
  const mins = rampMinutesToMax(from, speed);
  const eta = $('ramp-eta');
  eta.replaceChildren();
  if (from >= speed.rampMax) {
    eta.append('You are already at your max of ', el('b', {}, `${fmtRate(speed.rampMax)}×`), '.');
    return;
  }
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  eta.append(
    'From your current ',
    el('b', {}, `${fmtRate(from)}×`),
    ', reaching ',
    el('b', {}, `${fmtRate(speed.rampMax)}×`),
    ' takes about ',
    el('b', {}, h ? `${h} h ${m} min` : `${Math.max(1, m)} min`),
    ' of watching.',
  );
}

let listening: HTMLButtonElement | null = null;

function renderShortcuts() {
  const counts = new Map<string, number>();
  for (const s of speed.shortcuts) if (s.code) counts.set(s.code, (counts.get(s.code) ?? 0) + 1);
  const update = (i: number, patch: Partial<Shortcut>) => {
    const shortcuts = speed.shortcuts.map((s, j) => (j === i ? { ...s, ...patch } : s));
    void saveSpeed({ shortcuts }).then(renderShortcuts);
  };

  $('shortcuts').replaceChildren(
    ...speed.shortcuts.map((s, i) => {
      const action = el('select');
      action.setAttribute('aria-label', 'Action');
      action.title = ACTIONS[s.action].title;
      for (const [value, meta] of Object.entries(ACTIONS)) {
        action.append(el('option', { value, selected: value === s.action, title: meta.title }, meta.label));
      }
      action.addEventListener('change', () => update(i, { action: action.value as SpeedAction }));

      const dupe = (counts.get(s.code) ?? 0) > 1;
      const key = el('button', { className: `key${dupe ? ' dupe' : ''}`, title: dupe ? 'Used by more than one shortcut' : 'Click, then press a key' }, s.code ? keyLabel(s.code) : 'Set');
      key.setAttribute('aria-label', `Key for ${ACTIONS[s.action].label}`);
      key.addEventListener('click', () => {
        listening?.classList.remove('listening');
        listening = key;
        key.classList.add('listening');
        key.textContent = 'Press…';
      });
      key.addEventListener('keydown', (e) => {
        if (listening !== key || ['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(e.key)) return;
        e.preventDefault();
        listening = null;
        if (e.key === 'Escape') return renderShortcuts();
        update(i, { code: e.code });
      });
      key.addEventListener('blur', () => {
        if (listening === key) {
          listening = null;
          renderShortcuts();
        }
      });

      const meta = ACTIONS[s.action];
      const value = el('input', { type: 'number', step: '0.05', min: '0', value: meta.hasValue ? String(s.value) : '', disabled: !meta.hasValue });
      value.setAttribute('aria-label', 'Value');
      value.placeholder = meta.unit ?? '';
      value.addEventListener('change', () => update(i, { value: Number(value.value) }));

      // What this key also does to gradual speed-up.
      const effect = el('select', { className: 'effect' });
      effect.setAttribute('aria-label', `Gradual speed-up when pressing ${ACTIONS[s.action].label}`);
      effect.title = 'Gradual speed-up: pause it, resume it, or leave it alone when this key is pressed';
      const current = rampEffectOf(s);
      for (const [value, label] of [
        ['none', '—'],
        ['pause', 'Pause'],
        ['resume', 'Resume'],
      ] as [RampEffect, string][]) {
        effect.append(el('option', { value, selected: value === current }, label));
      }
      effect.disabled = s.action === 'ramp';
      effect.addEventListener('change', () => update(i, { ramp: effect.value as RampEffect }));

      const del = el('button', { className: 'del', title: 'Remove' }, '✕');
      del.setAttribute('aria-label', 'Remove shortcut');
      del.addEventListener('click', () => void saveSpeed({ shortcuts: speed.shortcuts.filter((_, j) => j !== i) }).then(renderShortcuts));
      return el('div', { className: 'sc' }, action, key, value, effect, del);
    }),
  );
  $('shortcuts').prepend(
    el(
      'div',
      { className: 'sc sc-head', 'aria-hidden': 'true' },
      el('span', {}, 'Action'),
      el('span', {}, 'Key'),
      el('span', {}, 'Value'),
      el('span', { title: 'Effect on gradual speed-up' }, 'Speed-up'),
      el('span', {}),
    ),
  );
}

// ---------- Health ----------

let lastDiagnostics: Diagnostics | null = null;

async function runDiagnostics() {
  const note = $('diag-note');
  const list = $('diag-list');
  list.replaceChildren();
  const tab = activeTab;
  if (!tab?.id || !tab.url?.startsWith('https://www.youtube.com/')) {
    note.textContent = 'Open a YouTube video in this window, then run the checks.';
    return;
  }
  note.textContent = 'Checking…';
  try {
    lastDiagnostics = (await chrome.tabs.sendMessage(tab.id, { type: 'diagnostics' })) as Diagnostics;
  } catch {
    note.textContent = 'BetterTube is not running in this tab yet. Reload the tab and try again.';
    return;
  }
  note.textContent = lastDiagnostics.url.replace('https://www.youtube.com', '');
  list.replaceChildren(
    ...lastDiagnostics.checks.map((c) =>
      el(
        'li',
        { className: c.status },
        el('span', { className: 'dot' }),
        el('span', {}, c.label, el('span', { className: 'module' }, c.module)),
        ...(c.detail ? [el('span', { className: 'detail' }, c.detail)] : []),
      ),
    ),
  );
}

async function copyDiagnostics() {
  if (!lastDiagnostics) await runDiagnostics();
  if (!lastDiagnostics) return;
  await navigator.clipboard.writeText(JSON.stringify(lastDiagnostics, null, 2));
  const b = $('diag-copy');
  b.textContent = 'Copied ✓';
  setTimeout(() => (b.textContent = 'Copy diagnostics'), 1500);
}

// ---------- chip detection (codec "auto") ----------

function detectChip(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext ? String(gl!.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    return /Apple M\d+[^,)]*/.exec(renderer)?.[0] ?? (/Intel/i.test(renderer) ? 'Intel' : renderer);
  } catch {
    return '';
  }
}

// ---------- wiring ----------

function selectTab(name: string) {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === name));
  }
  for (const panel of document.querySelectorAll<HTMLElement>('main[data-panel]')) {
    panel.hidden = panel.dataset.panel !== name;
  }
  if (name === 'health') void runDiagnostics();
  try {
    localStorage.setItem('bt-popup-tab', name);
  } catch {
    // ignore
  }
}

async function main() {
  // Opened as the options page (a full tab) rather than the toolbar popup.
  if (window.innerWidth > 500) document.body.classList.add('full');
  $('version').textContent = `v${VERSION}`;
  hydrateIcons();

  const sync = await chrome.storage.sync.get([STORAGE_KEY, SPEED_KEY]);
  settings = withDefaults(sync[STORAGE_KEY] as Partial<Settings> | undefined);
  speed = withSpeedDefaults(sync[SPEED_KEY] as Partial<SpeedSettings> | undefined);
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const chip = detectChip();
  if (chip && chip !== settings.chip) await saveSettings({ chip });

  renderQuick();
  renderSections();
  renderSpeed();
  void renderToday();
  void checkActiveTab();

  for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button')) {
    b.addEventListener('click', () => selectTab(b.dataset.tab!));
  }
  try {
    const last = localStorage.getItem('bt-popup-tab');
    if (last) selectTab(last);
  } catch {
    // ignore
  }

  $('open-dashboard').addEventListener('click', () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
    window.close();
  });
  $('search').addEventListener('input', applySearch);
  $('reset').addEventListener('click', async () => {
    await saveSettings({ ...DEFAULTS, chip: settings.chip });
    renderQuick();
    renderSections();
  });
  $('add-shortcut').addEventListener('click', () => {
    void saveSpeed({ shortcuts: [...speed.shortcuts, { action: 'preferred', code: '', value: 2 }] }).then(renderShortcuts);
  });
  $('speed-defaults').addEventListener('click', () => {
    void saveSpeed({ shortcuts: DEFAULT_SPEED_SETTINGS.shortcuts }).then(renderShortcuts);
  });
  $('blacklist').addEventListener('change', () => void saveSpeed({ blacklist: ($('blacklist') as HTMLTextAreaElement).value }));
  $('diag-refresh').addEventListener('click', () => void runDiagnostics());
  $('diag-copy').addEventListener('click', () => void copyDiagnostics());
}

void main();
