// Service worker: merges stats ticks from every YouTube tab into the day's
// record, and opens the dashboard.
import { DAY_PREFIX, RETENTION_DAYS, SESSION_GAP_MS, dayKey, emptyDay, type DayStats, type Tick } from './shared/stats';

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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'stats:tick') {
    queue = queue.then(() => record(msg as Tick)).catch((err) => console.error('[BetterTube] stats', err));
  } else if (msg?.type === 'open-dashboard') {
    void chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  }
});

chrome.runtime.onStartup.addListener(() => void pruneOldDays());
chrome.runtime.onInstalled.addListener(() => void pruneOldDays());

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
