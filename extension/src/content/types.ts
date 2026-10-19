import type { VideoInfo } from '../shared/bridge';
import type { CheckStatus } from '../shared/diagnostics';
import type { Settings } from '../shared/settings';

export interface PageInfo {
  path: string;
  isWatch: boolean;
  videoId: string | null;
}

export interface Ctx {
  settings: Settings;
  page: PageInfo;
  /** Current video as reported by the MAIN-world player bridge. */
  video: VideoInfo | null;
  /** Incognito window: work as usual, record nothing. */
  incognito: boolean;
}

export interface Check {
  label: string;
  status: CheckStatus;
  detail?: string;
}

/**
 * A feature. `css` is re-evaluated whenever settings change; the hooks read
 * `ctx.settings` live, so a disabled feature simply returns early.
 */
export interface Module {
  id: string;
  css?(s: Settings): string;
  init?(ctx: Ctx): void;
  onSettings?(ctx: Ctx): void;
  /** Called on first load and after every in-app (SPA) navigation. */
  onPage?(ctx: Ctx): void;
  onVideo?(ctx: Ctx, info: VideoInfo): void;
  /** Health checks shown in the popup's Diagnostics tab. */
  check?(ctx: Ctx): Check[];
}
