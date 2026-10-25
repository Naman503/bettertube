// Service worker: merges stats ticks from every YouTube tab into the day's
// record, and opens the dashboard.
import { INCOGNITO_PREFIX, SIMULATE_INCOGNITO_KEY } from './shared/privacy';
import { DAY_PREFIX, RETENTION_DAYS, SESSION_GAP_MS, dayKey, emptyDay, summarize, type DayStats, type Tick } from './shared/stats';
import { STORAGE_KEY, withDefaults, type Settings } from './shared/settings';
import { DEFAULT_SPEED_SETTINGS, SITE_SPEEDS_KEY, SPEED_KEY, withSpeedDefaults, type SpeedSettings } from './shared/speedSettings';
import { buildCrash, CLIENT_COUNTERS, countBucket, minutesBucket, ONCE_A_DAY, sanitizeProps, settingValue, speedBucket, validName, type Props } from './shared/usageCore';
import { localDay, noonOf, usageActive, usageCountMany, usageCrash, usageEvent, usageFlush, usageOnce, usageTurnedOff, usageTurnedOn, usageVersion, type DailyReport } from './usage';

// ---------- errors in the service worker (anonymous, see src/usage.ts) ----------
const bgCrash = (err: unknown, fatal = false) => {
  try {
    void usageCrash(buildCrash('background', err instanceof Error ? err : String(err ?? 'unknown'), chrome.runtime.getURL(''), fatal)).catch(() => {});
  } catch {
    // never let error reporting throw
  }
};
self.addEventListener('error', (e) => bgCrash((e as ErrorEvent).error ?? (e as ErrorEvent).message, true));
self.addEventListener('unhandledrejection', (e) => bgCrash((e as PromiseRejectionEvent).reason));

const STATE_KEY = 'stats:state';

/** Union bookkeeping, so overlapping ticks from several tabs count once. */
interface State {
  activeEnd: number;
  playingEnd: number;
  lastActiveAt: number;
  sessionStart: number;
}

const bump = (map: Record<string, number>, key: string | null, ms: number) => {
  if (key && ms > 0) map[key] = (map[key] ?? 0) + ms;
};

async function record(tick: Tick) {
  const state: State = ((await chrome.storage.session.get(STATE_KEY))[STATE_KEY] as State | undefined) ?? {
    activeEnd: 0,
    playingEnd: 0,
    lastActiveAt: 0,
    sessionStart: 0,
  };
  const key = DAY_PREFIX + dayKey(tick.at);
  const day: DayStats = ((await chrome.storage.local.get(key))[key] as DayStats | undefined) ?? emptyDay(dayKey(tick.at));
  const start = tick.at - tick.dt;

  if (tick.active) {
    day.activeMs += Math.max(0, tick.at - Math.max(start, state.activeEnd));
    state.activeEnd = Math.max(state.activeEnd, tick.at);
    if (tick.at - state.lastActiveAt > SESSION_GAP_MS) {
      day.sessions++;
      state.sessionStart = start;
    }
    state.lastActiveAt = tick.at;
    day.longestSessionMs = Math.max(day.longestSessionMs, tick.at - state.sessionStart);
  }

  if (tick.playing) {
    const added = Math.max(0, tick.at - Math.max(start, state.playingEnd));
    state.playingEnd = Math.max(state.playingEnd, tick.at);
    day.watchMs += added;
    day.hourlyWatchMs[new Date(tick.at).getHours()] += added;
    bump(day.resolutionMs, tick.resolution, added);
    bump(day.codecMs, tick.codec, added);
  }
  if (tick.adPlaying) day.adMs += tick.dt;

  const v = tick.video;
  if (v) {
    const stat = (day.videos[v.id] ??= {
      title: v.title,
      author: v.author,
      channelId: v.channelId,
      durationSec: v.durationSec,
      watchMs: 0,
      contentSec: 0,
      maxPosSec: 0,
      firstAt: tick.at,
      lastAt: tick.at,
    });
    Object.assign(stat, {
      title: v.title || stat.title,
      author: v.author || stat.author,
      channelId: v.channelId || stat.channelId,
      durationSec: v.durationSec || stat.durationSec,
      lastAt: tick.at,
      maxPosSec: Math.max(stat.maxPosSec, v.posSec),
    });
    if (tick.playing) stat.watchMs += tick.dt;
    stat.contentSec += v.contentDeltaSec;
    day.contentSec += v.contentDeltaSec;
  }

  day.stalls += tick.stalls;
  day.stallMs += tick.stallMs;
  day.droppedFrames += tick.droppedFrames;
  day.totalFrames += tick.totalFrames;
  if (tick.bandwidthKbps) {
    day.bandwidthKbpsSum += tick.bandwidthKbps;
    day.bandwidthSamples++;
  }
  day.searches += tick.searches;

  await chrome.storage.local.set({ [key]: day });
  await chrome.storage.session.set({ [STATE_KEY]: state });
}

async function pruneOldDays() {
  const cutoff = dayKey(Date.now() - RETENTION_DAYS * 86_400_000);
  const all = await chrome.storage.local.get(null);
  const old = Object.keys(all).filter((k) => k.startsWith(DAY_PREFIX) && k.slice(DAY_PREFIX.length) < cutoff);
  if (old.length) await chrome.storage.local.remove(old);
}

// Ticks arrive concurrently from several tabs; serialise the read-modify-write.
let queue = Promise.resolve();

// ---------- speed controller: which frames of a tab have media ----------
// So a shortcut pressed in a frame without media (usually the page, while the
// player is an embedded frame) reaches the frame that has it.
const FRAMES_KEY = 'speed:mediaFrames';
type FrameMap = Record<string, number[]>;

async function mediaFrames(): Promise<FrameMap> {
  return ((await chrome.storage.session.get(FRAMES_KEY))[FRAMES_KEY] as FrameMap | undefined) ?? {};
}

async function setMediaFrames(tabId: number, frames: number[]) {
  const all = await mediaFrames();
  if (frames.length) all[tabId] = frames;
  else delete all[tabId];
  await chrome.storage.session.set({ [FRAMES_KEY]: all });
  void chrome.tabs.sendMessage(tabId, { type: 'speed:media-frames', frames }).catch(() => {});
}

let framesQueue = Promise.resolve();
const serially = (job: () => Promise<void>) => (framesQueue = framesQueue.then(job).catch(() => {}));

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender.tab?.id;
  const frameId = sender.frameId ?? 0;
  if (tabId === undefined) return;
  if (msg?.type === 'speed:hello') {
    serially(async () => {
      // A fresh top-level page forgets the previous page's frames.
      if (frameId === 0) await setMediaFrames(tabId, []);
      reply({ frameId, frames: (await mediaFrames())[tabId] ?? [] });
    });
    return true;
  }
  if (msg?.type === 'speed:has-media') {
    serially(async () => {
      const frames = new Set((await mediaFrames())[tabId] ?? []);
      frames.add(frameId);
      await setMediaFrames(tabId, [...frames]);
    });
  } else if (msg?.type === 'speed:relay') {
    void mediaFrames().then((all) => {
      for (const f of all[tabId] ?? []) {
        if (f !== frameId) void chrome.tabs.sendMessage(tabId, { type: 'speed:run-key', code: msg.code }, { frameId: f }).catch(() => {});
      }
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => serially(() => setMediaFrames(tabId, [])));

// ---------- incognito: remember nothing past the session ----------
// The speed controller keeps incognito speeds and pause states in
// chrome.storage.session (memory only) under "incognito:" keys; content scripts
// need access to that area. When the last incognito tab closes, wipe them.
void chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });

async function forgetIncognito() {
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(INCOGNITO_PREFIX));
  if (keys.length) await chrome.storage.session.remove(keys);
}

chrome.tabs.onRemoved.addListener(async () => {
  // Simulated incognito (tests) has no real incognito tabs to count.
  if ((await chrome.storage.local.get(SIMULATE_INCOGNITO_KEY))[SIMULATE_INCOGNITO_KEY] === true) return;
  const tabs = await chrome.tabs.query({});
  if (!tabs.some((t) => t.incognito)) await forgetIncognito();
});
// Tests can't open real incognito tabs; unpacked builds expose the wipe.
if (!('update_url' in chrome.runtime.getManifest())) (globalThis as Record<string, unknown>).btForgetIncognito = forgetIncognito;

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'stats:tick') {
    if (sender.tab?.incognito) return; // never record incognito watching
    queue = queue
      .then(() => record(msg as Tick))
      .catch((err) => {
        console.error('[BetterTube] stats', err);
        bgCrash(err);
      });
    markActive('youtube');
  } else if (msg?.type === 'usage:batch') {
    if (sender.tab?.incognito || !Array.isArray(msg.items)) return;
    onClientCounts(msg.items as unknown[], sender);
  } else if (msg?.type === 'usage:crash') {
    if (sender.tab?.incognito) return;
    const c = msg.crash as { fp?: unknown; m?: unknown; st?: unknown; fatal?: unknown } | undefined;
    if (typeof c?.fp !== 'string' || typeof c.m !== 'string') return;
    void usageCrash({
      fp: c.fp.slice(0, 64),
      m: c.m.slice(0, 500),
      ...(typeof c.st === 'string' ? { st: c.st.slice(0, 1500) } : {}),
      t: Date.now(),
      ...(c.fatal === true ? { fatal: true } : {}),
    });
  } else if (msg?.type === 'open-dashboard') {
    void chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  }
});

chrome.runtime.onStartup.addListener(() => void pruneOldDays());

// ---------- anonymous usage from content scripts and pages (src/shared/track.ts) ----------
/** First time a feature is used: one setup milestone each. */
const MILESTONES: Record<string, string> = {
  popup_opened: 'first_popup_open',
  speed_changed: 'first_speed_change',
  shortcut_used: 'first_shortcut_used',
  ramp_step: 'first_ramp_step',
  dashboard_opened: 'first_dashboard_open',
  preset_applied: 'first_preset',
};
/** Where a use came from, for "daily_active". */
const SURFACE_OF = (sender: chrome.runtime.MessageSender) => {
  if (!sender.tab) return 'popup';
  const url = sender.url ?? '';
  if (url.startsWith(chrome.runtime.getURL(''))) return url.includes('dashboard') ? 'dashboard' : 'options';
  return url.startsWith('https://www.youtube.com/') ? 'youtube' : 'other_site';
};

let activeMarked = '';
function markActive(surface: string) {
  if (activeMarked === localDay()) return;
  activeMarked = localDay();
  void usageActive(surface).catch(() => {});
}

function onClientCounts(raw: unknown[], sender: chrome.runtime.MessageSender) {
  const items: { n: string; p?: Props; c: number }[] = [];
  for (const it of raw.slice(0, 100)) {
    const x = it as { n?: unknown; p?: unknown; c?: unknown };
    if (!validName(x?.n) || !CLIENT_COUNTERS.has(x.n)) continue;
    const c = typeof x.c === 'number' && Number.isFinite(x.c) ? Math.min(1000, Math.max(1, Math.round(x.c))) : 1;
    items.push({ n: x.n, p: sanitizeProps(x.p), c });
  }
  if (!items.length) return;
  markActive(SURFACE_OF(sender));
  void usageCountMany(items, ONCE_A_DAY).catch(() => {});
  for (const it of items) if (MILESTONES[it.n]) void usageOnce(MILESTONES[it.n]).catch(() => {});
}
chrome.runtime.onInstalled.addListener(() => {
  void pruneOldDays();
  void usageVersion();
});

// ---------- anonymous usage (src/usage.ts) ----------
// Feature switches: which one changed and its new value, never anything else in settings.
const FEATURES = ['classicLayout', 'compactSidebar', 'restoreDescription', 'noBigTheater', 'revertPlayerControls', 'squareCorners', 'hideShorts', 'redirectShorts', 'hideAI', 'hideEndscreen', 'disableHoverPreviews', 'disableAmbient', 'autoplayOff', 'autoContinue', 'hideRelated', 'hideComments', 'antiBuffer', 'statsEnabled', 'statsBadge'];
/** Choices (not switches): which one changed and the chosen option. */
const CHOICES = ['viewMode', 'defaultQuality', 'codecMode', 'gridItemsPerRow', 'dailyLimitMinutes'];
/** Speed controller switches, reported under these names. */
const SPEED_FEATURES: Record<string, string> = {
  enabled: 'speedController',
  rememberSpeed: 'rememberSpeed',
  perSiteSpeed: 'perSiteSpeed',
  forceSpeed: 'forceSpeed',
  workOnAudio: 'workOnAudio',
  startHidden: 'startHidden',
  ramp: 'gradualSpeedUp',
  rampCarryOver: 'rampCarryOver',
  rampEaseOnRewind: 'rampEaseOnRewind',
  rampQuiet: 'rampQuiet',
};
const SPEED_CHOICES = ['speedDecimals', 'opacity', 'rampStep', 'rampEverySec', 'rampMax', 'rampOnManual', 'rampMinVideoMin', 'rampQuietFrom', 'rampQuietTo'];

const choiceEvent = (setting: string, v: unknown) => {
  const value = settingValue(v);
  if (value !== undefined) void usageEvent('setting_changed', { setting, value: String(value) });
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[STORAGE_KEY]) {
    const before = (changes[STORAGE_KEY].oldValue ?? {}) as Record<string, unknown>;
    const after = (changes[STORAGE_KEY].newValue ?? {}) as Record<string, unknown>;
    if (before.shareUsage !== false && after.shareUsage === false) void usageTurnedOff();
    else if (before.shareUsage === false && after.shareUsage !== false) void usageTurnedOn();
    for (const f of FEATURES) {
      if (f in before && before[f] !== after[f] && typeof after[f] === 'boolean') void usageEvent('feature_toggled', { feature: f, on: String(after[f]) });
    }
    for (const f of CHOICES) if (f in before && before[f] !== after[f]) choiceEvent(f, after[f]);
    // Sizes are dragged on the page: only whether one is set, never the width.
    for (const f of ['sidebarWidth', 'theaterHeight']) {
      if (f in before && Boolean(before[f]) !== Boolean(after[f])) choiceEvent(f, after[f] ? 'custom' : 'default');
    }
  }
  if (area === 'sync' && changes[SPEED_KEY]) {
    const b = (changes[SPEED_KEY].oldValue ?? {}) as Record<string, unknown>;
    const a = (changes[SPEED_KEY].newValue ?? {}) as Record<string, unknown>;
    for (const [k, name] of Object.entries(SPEED_FEATURES)) {
      if (k in b && b[k] !== a[k] && typeof a[k] === 'boolean') void usageEvent('feature_toggled', { feature: name, on: String(a[k]) });
    }
    for (const k of SPEED_CHOICES) if (k in b && b[k] !== a[k]) choiceEvent(k, a[k]);
  }
});

const hourPart = (h: number) => (h < 6 ? 'night' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening');
const CODECS = new Set(['AV1', 'VP9', 'H.264']);
const top = (m: Record<string, number>) => Object.entries(m).sort((x, y) => y[1] - x[1])[0]?.[0];

/** Yesterday as ranges (never per video), then today's settings as switches and choices. */
const dailyReport: DailyReport = async () => {
  const out: Awaited<ReturnType<DailyReport>> = [];
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const t = noonOf(localDay(d));
  const key = `${DAY_PREFIX}${dayKey(d)}`;
  const stats = (await chrome.storage.local.get(key))[key] as DayStats | undefined;
  const sum = summarize(stats);
  const minutesSaved = Math.round(sum.savedMs / 60_000);
  if (minutesSaved) out.push({ n: 'minutes_saved', t, c: minutesSaved });
  if (sum.videos) out.push({ n: 'videos_watched', t, c: sum.videos });
  if (stats && (stats.watchMs > 0 || stats.activeMs > 0)) {
    const vids = Object.values(stats.videos);
    const vidWatchMs = vids.reduce((a, v) => a + v.watchMs, 0);
    const res = top(stats.resolutionMs);
    const codec = top(stats.codecMs);
    const peak = stats.hourlyWatchMs.indexOf(Math.max(...stats.hourlyWatchMs));
    out.push({
      n: 'day_summary',
      t,
      p: {
        watch: minutesBucket(stats.watchMs / 60_000),
        active: minutesBucket(stats.activeMs / 60_000),
        sessions: countBucket(stats.sessions),
        longest: minutesBucket(stats.longestSessionMs / 60_000),
        avg_speed: vidWatchMs > 0 ? speedBucket((stats.contentSec * 1000) / vidWatchMs) : 'none',
        completed: countBucket(vids.filter((v) => v.durationSec > 0 && v.maxPosSec >= v.durationSec * 0.9).length),
        resolution: res && /^\d{3,4}p$/.test(res) ? res : 'none',
        codec: codec ? (CODECS.has(codec) ? codec : 'other') : 'none',
      },
    });
    out.push({
      n: 'day_quality',
      t,
      p: {
        ads: minutesBucket(stats.adMs / 60_000),
        stalls: countBucket(stats.stalls),
        peak: stats.watchMs > 0 ? hourPart(peak) : 'none',
        dropped_pct: stats.totalFrames > 0 ? Math.round((stats.droppedFrames / stats.totalFrames) * 1000) / 10 : 0,
      },
    });
    if (stats.searches) out.push({ n: 'searches', t, c: stats.searches });
  }

  const sync = await chrome.storage.sync.get([STORAGE_KEY, SPEED_KEY]);
  const s: Settings = withDefaults(sync[STORAGE_KEY] as Partial<Settings> | undefined);
  const sp: SpeedSettings = withSpeedDefaults(sync[SPEED_KEY] as Partial<SpeedSettings> | undefined);
  const siteSpeeds = ((await chrome.storage.local.get(SITE_SPEEDS_KEY))[SITE_SPEEDS_KEY] ?? {}) as Record<string, number>;
  const now = Date.now();
  const snap = (n: string, p: Record<string, unknown>) => {
    const clean: Props = {};
    for (const [k, v] of Object.entries(p)) {
      const value = settingValue(v);
      if (value !== undefined) clean[k] = value;
    }
    out.push({ n, t: now, p: clean });
  };
  snap('settings_layout', {
    view_mode: s.viewMode,
    classic: s.classicLayout,
    compact_sidebar: s.compactSidebar,
    description: s.restoreDescription,
    no_big_theater: s.noBigTheater,
    old_controls: s.revertPlayerControls,
    square_corners: s.squareCorners,
    sidebar: s.sidebarWidth ? 'custom' : 'default',
  });
  snap('settings_declutter', {
    hide_shorts: s.hideShorts,
    redirect_shorts: s.redirectShorts,
    hide_ai: s.hideAI,
    hide_endscreen: s.hideEndscreen,
    no_previews: s.disableHoverPreviews,
    no_ambient: s.disableAmbient,
    autoplay_off: s.autoplayOff,
    auto_continue: s.autoContinue,
  });
  snap('settings_playback', {
    hide_related: s.hideRelated,
    hide_comments: s.hideComments,
    grid_per_row: s.gridItemsPerRow,
    quality: s.defaultQuality,
    codec_mode: s.codecMode,
    anti_buffer: s.antiBuffer,
    theater_height: s.theaterHeight ? 'custom' : 'default',
  });
  snap('settings_stats', { stats: s.statsEnabled, badge: s.statsBadge, daily_limit: s.dailyLimitMinutes });
  snap('settings_speed', {
    enabled: sp.enabled,
    remember: sp.rememberSpeed,
    per_site: sp.perSiteSpeed,
    force: sp.forceSpeed,
    audio: sp.workOnAudio,
    start_hidden: sp.startHidden,
    opacity: sp.opacity,
    decimals: String(sp.speedDecimals),
  });
  snap('settings_shortcuts', {
    count: sp.shortcuts.filter((x) => x.code).length,
    preferred: sp.shortcuts.filter((x) => x.action === 'preferred' && x.code).length,
    custom: JSON.stringify(sp.shortcuts) !== JSON.stringify(DEFAULT_SPEED_SETTINGS.shortcuts),
    sites_off: sp.blacklist.split('\n').filter((l) => l.trim()).length,
    saved_sites: Object.keys(siteSpeeds).length,
  });
  snap('settings_ramp', {
    on: sp.ramp,
    step: sp.rampStep,
    every_sec: sp.rampEverySec,
    max: sp.rampMax,
    carry_over: sp.rampCarryOver,
    on_manual: sp.rampOnManual,
    min_video_min: sp.rampMinVideoMin,
    ease_on_rewind: sp.rampEaseOnRewind,
  });
  snap('settings_ramp_quiet', { quiet: sp.rampQuiet, from: sp.rampQuietFrom, to: sp.rampQuietTo });
  return out;
};
// First send after 10 minutes (keeps short test runs quiet), then every 6 hours.
void chrome.alarms.create('usage', { delayInMinutes: 10, periodInMinutes: 360 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'usage') void usageFlush(dailyReport).catch(bgCrash);
});
// Tests can't wait for the alarm; unpacked builds expose the flush.
if (!('update_url' in chrome.runtime.getManifest())) (globalThis as Record<string, unknown>).btUsageFlush = () => usageFlush(dailyReport);

// ---------- development: reload automatically after a rebuild ----------
// Unpacked builds only (no update_url). build.mjs writes build.json on every
// build; when it changes, reload so Brave picks up the new files without a
// trip to brave://extensions. Open tabs then show "Reload this tab".
const isUnpacked = !('update_url' in chrome.runtime.getManifest());
const BUILD_KEY = 'dev:buildId';

async function checkForNewBuild() {
  try {
    const { builtAt } = await (await fetch(chrome.runtime.getURL('build.json'), { cache: 'no-store' })).json();
    const known = (await chrome.storage.session.get(BUILD_KEY))[BUILD_KEY];
    if (!known) await chrome.storage.session.set({ [BUILD_KEY]: builtAt });
    else if (known !== builtAt) chrome.runtime.reload();
  } catch {
    // build.json missing (packaged build)
  }
}

if (isUnpacked) {
  void chrome.alarms.create('dev-reload', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === 'dev-reload') void checkForNewBuild();
  });
  void checkForNewBuild();
}
