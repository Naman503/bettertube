// Daily watch limit: where today stands, and the "you're over" prompt's state.
import { fmtDuration } from './stats';

/** storage.local: the day (YYYY-MM-DD) "Okay for today" was chosen. */
export const LIMIT_ACK_KEY = 'limit:ackDay';
/** storage.local: no prompt before this time (ms), after "Remind me later". */
export const LIMIT_SNOOZE_KEY = 'limit:snoozeUntil';
export const LIMIT_SNOOZE_MIN = 15;

export type LimitLevel = 'none' | 'ok' | 'near' | 'over';

export interface LimitStatus {
  level: LimitLevel;
  ratio: number;
  limitMs: number;
  /** "Over by 15m" / "45m left" */
  headline: string;
  /** "117% of 1h 30m" */
  detail: string;
}

export function limitStatus(watchMs: number, limitMinutes: number): LimitStatus {
  const limitMs = limitMinutes * 60_000;
  if (!limitMs) return { level: 'none', ratio: 0, limitMs: 0, headline: '', detail: '' };
  const ratio = watchMs / limitMs;
  const level: LimitLevel = ratio >= 1 ? 'over' : ratio >= 0.8 ? 'near' : 'ok';
  const headline =
    level === 'over'
      ? watchMs - limitMs < 60_000
        ? 'Daily limit reached'
        : `Over your daily limit by ${fmtDuration(watchMs - limitMs)}`
      : `${fmtDuration(limitMs - watchMs)} left of your daily limit`;
  return { level, ratio, limitMs, headline, detail: `${Math.round(ratio * 100)}% of ${fmtDuration(limitMs)}` };
}

/** Icon paths (24×24, stroked) per level. */
export const LIMIT_ICONS: Record<Exclude<LimitLevel, 'none'>, string[]> = {
  over: [
    'M5 22h14',
    'M5 2h14',
    'M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22',
    'M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2',
  ],
  near: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'],
  ok: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M8.5 12l2.5 2.5 4.5-5'],
};
