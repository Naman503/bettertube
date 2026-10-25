// Anonymous usage reporting (popup → YouTube → Privacy → Share anonymous usage), on by
// default. Service worker only. Sends feature names, daily counts of features used
// (speed changes by range and how, shortcuts by action, popup/overlay/dashboard opens,
// layout fixes applied…), a daily settings snapshot (switches and choices only), daily
// watch-time ranges, setup milestones and error reports from our own code, with a
// random install id, to POST /v1/app/bettertube every 6 hours. Never video IDs, titles,
// channels, sites, URLs or anything from incognito. Turning it off deletes what was sent.
import type { CrashReport, Props } from './shared/usageCore';

export { speedBucket } from './shared/usageCore';
export const USAGE_ENDPOINT = 'https://api.np-dev.duckdns.org/v1/app/bettertube';
const KEY = 'usage';

type CounterProps = Record<string, string>;
interface UsageState {
  installId: string;
  pending: { n: string; t: number; c?: number; p?: Props }[];
  counters: Record<string, number>;
  once: string[];
  crashes?: CrashReport[];
  /** fingerprint → day last reported, so one bug sends one report a day. */
  crashSeen?: Record<string, string>;
  lastVersion?: string;
  dailyChecked?: string;
  activeDay?: string;
  offPending?: boolean;
}

export const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const noonOf = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12).getTime();
};

const asCounterProps = (p: Props = {}): CounterProps => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)]));

export function counterKey(day: string, name: string, props: Props = {}): string {
  const p = asCounterProps(props);
  return [day, name, ...Object.keys(p).sort().map((k) => `${k}=${p[k]}`)].join('|');
}

export function parseCounterKey(key: string): { day: string; name: string; props: CounterProps } | null {
  const [day, name, ...rest] = key.split('|');
  if (!day || !name) return null;
  const props: CounterProps = {};
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
  return usageCountMany([{ n: name, p: props, c: n }]);
}

/** Several daily counters in one storage write. `cap1` names count at most once a day. */
export async function usageCountMany(items: { n: string; p?: Props; c: number }[], cap1: Set<string> = new Set()) {
  if (!items.length || !(await enabled())) return;
  await update((s) => {
    const day = localDay();
    for (const it of items) {
      const k = counterKey(day, it.n, it.p);
      s.counters[k] = cap1.has(it.n) ? 1 : Math.min(1e6, (s.counters[k] ?? 0) + it.c);
    }
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

/** One "daily_active" event per local day BetterTube was actually used. */
export async function usageActive(surface: string) {
  if (!(await enabled())) return;
  await update((s) => {
    const day = localDay();
    if (s.activeDay === day) return;
    s.activeDay = day;
    s.pending.push({ n: 'daily_active', t: Date.now(), p: { surface } });
  });
}

export async function usageCrash(crash: CrashReport) {
  if (!(await enabled())) return;
  await update((s) => {
    const day = localDay();
    s.crashSeen ??= {};
    if (s.crashSeen[crash.fp] === day) return;
    s.crashSeen[crash.fp] = day;
    for (const [fp, d] of Object.entries(s.crashSeen)) if (d !== day) delete s.crashSeen[fp];
    s.crashes ??= [];
    if (s.crashes.length < 20) s.crashes.push(crash);
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
    s.crashes = [];
    s.offPending = true;
  });
  await usageFlush();
}

export async function usageTurnedOn() {
  await update((s) => void (s.offPending = false));
}

/** Once a day, the events describing yesterday (totals, ranges) and today's settings. */
export type DailyReport = () => Promise<{ n: string; t: number; c?: number; p?: Props }[]>;

export async function usageFlush(daily?: DailyReport) {
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
    const events = await daily().catch(() => []);
    if (events.length) await update((s) => void s.pending.push(...events.slice(0, 60)));
  }
  const snap = await update((s) => ({
    pending: s.pending.slice(0, 150),
    crashes: (s.crashes ?? []).slice(0, 10),
    counters: Object.entries(s.counters)
      .filter(([k]) => parseCounterKey(k)?.day !== localDay())
      .slice(0, 50),
  }));
  const week = Date.now() - 7 * 86_400_000;
  const events = [
    ...snap.pending,
    ...snap.counters.flatMap(([k, c]) => {
      const p = parseCounterKey(k);
      return p ? [{ n: p.name, t: noonOf(p.day), c, ...(Object.keys(p.props).length ? { p: p.props } : {}) }] : [];
    }),
  ].filter((e) => e.t > week);
  // Nothing fresh to send: just drop what went stale.
  if ((events.length || snap.crashes.length) && !(await post({ ...base, e: events.slice(0, 200), cr: snap.crashes }))) return;
  await update((s) => {
    s.pending = s.pending.slice(snap.pending.length);
    s.crashes = (s.crashes ?? []).slice(snap.crashes.length);
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
