// Messaging between the isolated content script and the MAIN-world script.
// Both worlds share the DOM, so CustomEvents on `document` reach both; the
// payload is a JSON string because object details don't reliably cross worlds.
import type { Settings } from './settings';

const TO_MAIN = 'bettertube:to-main';
const TO_ISOLATED = 'bettertube:to-isolated';

export interface VideoInfo {
  videoId: string;
  channelId: string;
  author: string;
  title: string;
  description: string;
  viewCount: number | null;
  publishDate: string | null; // ISO date
  lengthSeconds: number;
  isLive: boolean;
}

/** Periodic playback numbers from #movie_player.getStatsForNerds(). */
export interface PlayerStats {
  codec: string | null; // "VP9" | "AV1" | "H.264" | raw
  bandwidthKbps: number | null;
  bufferHealthSec: number | null;
}

export interface MainRecon {
  appliedFlags: Record<string, { from: unknown; to: unknown }>;
  experimentFlags: Record<string, unknown> | null;
  playerFlags: string | null;
  codecMode: string;
  currentCodecs: string | null;
  qualityLevels: string[] | null;
  currentQuality: string | null;
  video: VideoInfo | null;
}

export type ToMain =
  | { type: 'settings'; settings: Settings }
  | { type: 'recon'; id: string };

export type ToIsolated =
  | { type: 'video'; info: VideoInfo }
  | { type: 'player-stats'; stats: PlayerStats }
  | { type: 'toast'; text: string }
  /** Anonymous usage count from the MAIN world (fixed names and enums only). */
  | { type: 'usage'; n: string; p?: Record<string, string> }
  | { type: 'recon-result'; id: string; data: MainRecon };

function emit(name: string, msg: unknown) {
  document.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(msg) }));
}

function on<T>(name: string, fn: (msg: T) => void) {
  document.addEventListener(name, (e) => {
    const detail = (e as CustomEvent).detail;
    if (typeof detail !== 'string') return;
    try {
      fn(JSON.parse(detail) as T);
    } catch (err) {
      console.warn('[BetterTube] bad bridge message', err);
    }
  });
}

export const sendToMain = (msg: ToMain) => emit(TO_MAIN, msg);
export const sendToIsolated = (msg: ToIsolated) => emit(TO_ISOLATED, msg);
export const onMainMessage = (fn: (msg: ToMain) => void) => on(TO_MAIN, fn);
export const onIsolatedMessage = (fn: (msg: ToIsolated) => void) => on(TO_ISOLATED, fn);
