// Anonymous usage reporting (popup → YouTube → Privacy → Share anonymous usage), on by
// default. Service worker only. Sends feature names, daily counts (speed changes by range,
// minutes saved, videos watched) and setup milestones with a random install id to
// POST /v1/app/bettertube every 6 hours. Never video IDs, titles, channels, sites or
// anything from incognito. Turning it off deletes what was sent.

export const USAGE_ENDPOINT = 'https://api.np-dev.duckdns.org/v1/app/bettertube';
const KEY = 'usage';

type Props = Record<string, string>;
interface UsageState {
  installId: string;
  pending: { n: string; t: number; c?: number; p?: Props }[];
  counters: Record<string, number>;
  once: string[];
  lastVersion?: string;
  dailyChecked?: string;
  offPending?: boolean;
}

/** A speed as a range, never the exact value per video. */
export function speedBucket(rate: number): string {
  if (rate < 1) return 'slow';
  if (rate <= 1.5) return 'normal';
  if (rate <= 2.5) return 'fast';
  return 'faster';
}

export const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const noonOf = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12).getTime();
};

export function counterKey(day: string, name: string, props: Props = {}): string {
  return [day, name, ...Object.keys(props).sort().map((k) => `${k}=${props[k]}`)].join('|');
}

export function parseCounterKey(key: string): { day: string; name: string; props: Props } | null {
  const [day, name, ...rest] = key.split('|');
  if (!day || !name) return null;
  const props: Props = {};
  for (const r of rest) {
    const i = r.indexOf('=');
    if (i > 0) props[r.slice(0, i)] = r.slice(i + 1);
  }
  return { day, name, props };
}

let chain: Promise<unknown> = Promise.resolve();
function update<T>(fn: (s: UsageState) => T): Promise<T> {
  const run = chain.then(async () => {
    const got = (await chrome.storage.local.get(KEY))[KEY] as UsageState | undefined;
    const s: UsageState = got?.installId ? got : { installId: crypto.randomUUID(), pending: [], counters: {}, once: [] };
    const out = fn(s);
    await chrome.storage.local.set({ [KEY]: s });
    return out;
  });
  chain = run.catch(() => undefined);
  return run;
}

async function enabled(): Promise<boolean> {
  const s = (await chrome.storage.sync.get('settings')).settings as { shareUsage?: boolean } | undefined;
  return s?.shareUsage !== false;
}

export async function usageEvent(name: string, props?: Props, c?: number, t = Date.now()) {
  if (!(await enabled())) return;
  await update((s) => {
    if (s.pending.length < 500) s.pending.push({ n: name, t, ...(c ? { c } : {}), ...(props ? { p: props } : {}) });
  });
}

export async function usageCount(name: string, props: Props = {}, n = 1) {
  if (!(await enabled())) return;
  await update((s) => {
    const k = counterKey(localDay(), name, props);
    s.counters[k] = (s.counters[k] ?? 0) + n;
  });
}

export async function usageOnce(name: string) {
  if (!(await enabled())) return;
  await update((s) => {
    if (s.once.includes(name)) return;
    s.once.push(name);
    s.pending.push({ n: name, t: Date.now() });
  });
}

export async function usageVersion() {
  if (!(await enabled())) return;
  const v = chrome.runtime.getManifest().version;
  await update((s) => {
    if (!s.lastVersion) s.pending.push({ n: 'app_installed', t: Date.now() });
    else if (s.lastVersion !== v) s.pending.push({ n: 'app_update', t: Date.now(), p: { from: s.lastVersion.slice(0, 16), to: v } });
    s.lastVersion = v;
  });
}

export async function usageTurnedOff() {
  await update((s) => {
    s.pending = [];
    s.counters = {};
    s.offPending = true;
  });
  await usageFlush();
}

export async function usageTurnedOn() {
  await update((s) => void (s.offPending = false));
}

/** Once a day: yesterday's minutes saved and videos watched, as daily totals. */
export type DailyTotals = () => Promise<{ day: string; minutesSaved: number; videos: number } | null>;

export async function usageFlush(daily?: DailyTotals) {
  const state = await update((s) => s);
  const base = {
    i: state.installId,
    v: chrome.runtime.getManifest().version,
    pf: (navigator as Navigator & { brave?: unknown }).brave !== undefined ? 'brave' : 'chrome',
    os: ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? 'unknown').slice(0, 32),
    dc: 'browser',
    loc: (navigator.language ?? '').slice(0, 16),
  };
  if (state.offPending) {
    if (await post({ ...base, off: true })) await update((s) => void (s.offPending = false));
    return;
  }
  if (!(await enabled())) return;
  if (daily && state.dailyChecked !== localDay()) {
    await update((s) => void (s.dailyChecked = localDay()));
    const d = await daily();
    if (d?.minutesSaved) await usageEvent('minutes_saved', undefined, d.minutesSaved, noonOf(d.day));
    if (d?.videos) await usageEvent('videos_watched', undefined, d.videos, noonOf(d.day));
  }
  const snap = await update((s) => ({
    pending: [...s.pending],
    counters: Object.entries(s.counters).filter(([k]) => parseCounterKey(k)?.day !== localDay()),
  }));
  const events = [
    ...snap.pending,
    ...snap.counters.flatMap(([k, c]) => {
      const p = parseCounterKey(k);
      return p ? [{ n: p.name, t: noonOf(p.day), c, ...(Object.keys(p.props).length ? { p: p.props } : {}) }] : [];
    }),
  ];
  if (!events.length) return;
  if (!(await post({ ...base, e: events }))) return;
  await update((s) => {
    s.pending = s.pending.slice(snap.pending.length);
    for (const [k] of snap.counters) delete s.counters[k];
  });
}

async function post(body: unknown): Promise<boolean> {
  try {
    const r = await fetch(USAGE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}
