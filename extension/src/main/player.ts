// Talks to YouTube's undocumented #movie_player API, which only exists in the
// page's own JS world.
import { sendToIsolated, type MainRecon, type PlayerStats, type VideoInfo } from '../shared/bridge';
import { resolveCodecMode, type Quality, type Settings } from '../shared/settings';
import { appliedFlags } from './flags';

const QUALITY_ORDER = ['hd2160', 'hd1440', 'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'];
const QUALITY_NAMES: Record<Exclude<Quality, 'auto'>, string> = {
  '2160': 'hd2160',
  '1440': 'hd1440',
  '1080': 'hd1080',
  '720': 'hd720',
  '480': 'large',
  '360': 'medium',
};

const player = (): any => document.getElementById('movie_player');

function videoInfo(): VideoInfo | null {
  const p = player();
  const data = p?.getVideoData?.();
  if (!data?.video_id) return null;
  const response = p.getPlayerResponse?.();
  const details = response?.videoDetails;
  // getPlayerResponse can lag behind on SPA navigation; trust it only if it matches.
  const same = details?.videoId === data.video_id;
  const micro = response?.microformat?.playerMicroformatRenderer;
  const views = Number(same ? details?.viewCount : NaN);
  return {
    videoId: data.video_id,
    channelId: (same && details?.channelId) || '',
    author: data.author ?? '',
    title: data.title ?? '',
    description: (same && details?.shortDescription) || '',
    viewCount: Number.isFinite(views) ? views : null,
    publishDate: (same && (micro?.publishDate || micro?.uploadDate)) || null,
    lengthSeconds: Number((same && details?.lengthSeconds) || p.getDuration?.() || 0),
    isLive: Boolean(same && details?.isLive),
  };
}

const number = (v: unknown) => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

function codecName(raw: string | undefined): string | null {
  if (!raw) return null;
  const video = raw.split('/')[0].trim().toLowerCase();
  if (video.startsWith('av01')) return 'AV1';
  if (video.startsWith('vp09') || video.startsWith('vp9')) return 'VP9';
  if (video.startsWith('avc1')) return 'H.264';
  return video.split(/[ .]/)[0] || null;
}

function playerStats(): PlayerStats | null {
  try {
    const s = player()?.getStatsForNerds?.();
    if (!s) return null;
    return {
      codec: codecName(s.codecs),
      bandwidthKbps: number(s.bandwidth_kbps),
      bufferHealthSec: number(s.buffer_health_seconds),
    };
  } catch {
    return null;
  }
}

async function applyQuality(q: Quality) {
  if (q === 'auto') return;
  const target = QUALITY_ORDER.indexOf(QUALITY_NAMES[q]);
  // Levels are empty until the player has loaded the video's formats.
  for (let attempt = 0; attempt < 20; attempt++) {
    const levels: string[] = player()?.getAvailableQualityLevels?.() ?? [];
    const pick = levels.find((l) => QUALITY_ORDER.indexOf(l) >= target);
    if (pick) {
      const p = player();
      p.setPlaybackQualityRange?.(pick, pick);
      p.setPlaybackQuality?.(pick);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const QUALITY_LABELS: Record<string, string> = {
  hd2160: '2160p',
  hd1440: '1440p',
  hd1080: '1080p',
  hd720: '720p',
  large: '480p',
  medium: '360p',
  small: '240p',
  tiny: '144p',
};

/** Two mid-playback stalls within 90 s → drop one quality level for this video. */
function installAntiBuffer(getSettings: () => Settings) {
  let stalls: number[] = [];
  document.addEventListener(
    'waiting',
    (e) => {
      const video = e.target;
      if (!getSettings().antiBuffer || !(video instanceof HTMLVideoElement)) return;
      if (!video.closest('#movie_player') || video.seeking || video.currentTime < 1) return;
      if (document.querySelector('#movie_player.ad-showing')) return;
      const now = Date.now();
      stalls = stalls.filter((t) => now - t < 90_000);
      stalls.push(now);
      if (stalls.length < 2) return;
      stalls = [];
      const p = player();
      const current: string | undefined = p?.getPlaybackQuality?.();
      const levels: string[] = (p?.getAvailableQualityLevels?.() ?? []).filter((l: string) => l !== 'auto');
      const next = current ? levels[levels.indexOf(current) + 1] : undefined;
      if (!next || levels.indexOf(current!) < 0) return;
      p.setPlaybackQualityRange?.(next, next);
      p.setPlaybackQuality?.(next);
      sendToIsolated({ type: 'toast', text: `Buffering: lowered quality to ${QUALITY_LABELS[next] ?? next}` });
    },
    true,
  );
  document.addEventListener('yt-navigate-finish', () => (stalls = []));
}

export function installPlayerBridge(getSettings: () => Settings) {
  installAntiBuffer(getSettings);
  let lastVideoId = '';

  const onVideoMaybeChanged = () => {
    const info = videoInfo();
    if (!info || info.videoId === lastVideoId) return;
    // Wait until the channel id is known so per-channel features work.
    if (!info.channelId) return;
    lastVideoId = info.videoId;
    sendToIsolated({ type: 'video', info });
    void applyQuality(getSettings().defaultQuality);
  };

  // Media events don't bubble, but capture listeners on document see them.
  document.addEventListener('loadeddata', onVideoMaybeChanged, true);
  document.addEventListener('playing', onVideoMaybeChanged, true);
  document.addEventListener('yt-navigate-finish', () => setTimeout(onVideoMaybeChanged, 300));

  // Feed codec / bandwidth / buffer numbers to the stats tracker while playing.
  setInterval(() => {
    const video = player()?.querySelector?.('video') as HTMLVideoElement | undefined;
    if (!getSettings().statsEnabled || !video || video.paused) return;
    const stats = playerStats();
    if (stats) sendToIsolated({ type: 'player-stats', stats });
  }, 10_000);
}

export function collectRecon(getSettings: () => Settings): MainRecon {
  const w = window as any;
  const p = player();
  const store = w.ytcfg?.data_ ?? w.yt?.config_;
  const playerConfigs = store?.WEB_PLAYER_CONTEXT_CONFIGS;
  const watchConfig =
    playerConfigs?.WEB_PLAYER_CONTEXT_CONFIG_ID_KEVLAR_WATCH ??
    (playerConfigs ? Object.values<any>(playerConfigs)[0] : null);
  let currentCodecs: string | null = null;
  try {
    const s = p?.getStatsForNerds?.();
    currentCodecs = s ? `${s.codecs} · buffer ${s.buffer_health_seconds} · ${s.bandwidth_kbps}` : null;
  } catch {
    // Not available on every player build.
  }
  return {
    appliedFlags,
    experimentFlags: store?.EXPERIMENT_FLAGS ?? null,
    playerFlags: watchConfig?.serializedExperimentFlags ?? null,
    codecMode: resolveCodecMode(getSettings()),
    currentCodecs,
    qualityLevels: p?.getAvailableQualityLevels?.() ?? null,
    currentQuality: p?.getPlaybackQuality?.() ?? null,
    video: videoInfo(),
  };
}
