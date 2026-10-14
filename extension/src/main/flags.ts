// Overrides YouTube experiment flags before the app bundle reads them, so
// YouTube itself renders the older layout / player. Flags are read once per
// full page load, so changes here need a reload.
import type { Settings } from '../shared/settings';

type FlagValue = boolean | string;

/** Every flag we changed: name → original and new value. Shown in diagnostics. */
export const appliedFlags: Record<string, { from: unknown; to: unknown }> = {};

function pageFlagOverrides(s: Settings): Record<string, FlagValue> {
  const o: Record<string, FlagValue> = {};
  if (s.classicLayout) {
    // 2024 "grid" watch page (description + comments in the right column)
    o.kevlar_watch_grid = false;
    o.kevlar_watch_grid_hide_chips = false;
    // 2026 side-rail layout (seen on a signed-in account, Oct 2026). In YouTube's code:
    // - side-rail dismissible panels turn on the big-thumbnail 2-column up-next grid,
    //   and together with disable_theater_mode make the size button collapse panels
    //   instead of toggling theater; default-dismissed panels start every video wide;
    o.web_side_rail_dismissible_panels = false;
    o.web_side_rail_default_dismissed_panels = false;
    o.disable_theater_mode = false;
    // - split scroll pins up-next as a fixed, separately scrolling box;
    o.web_watch_split_scroll = false;
    o.swatcheroo_split_scroll = false;
    o.web_watch_fixed_default_panels = false;
    o.web_fixed_panel_watch_next_grid_swap = false;
    // - percentage sidebar widths (27.5–32.5% of the window) instead of the classic 402px.
    o.web_watch_use_sidebar_width_percentage = false;
    o.web_watch_use_secondary_max_width_percent = false;
  }
  if (s.disableAmbient) o.kevlar_watch_cinematics = false;
  if (s.squareCorners) {
    o.web_rounded_containers = false;
    o.web_rounded_thumbnails = false;
    o.web_watch_rounded_player_large = false;
  }
  return o;
}

function playerFlagOverrides(s: Settings): Record<string, string> {
  const o: Record<string, string> = {};
  if (s.revertPlayerControls) {
    // 2025 "Delhi" bubble-style player controls
    o.delhi_modern_web_player = 'false';
    o.delhi_modern_web_player_icons = 'false';
  }
  return o;
}

function record(name: string, from: unknown, to: unknown) {
  if (!(name in appliedFlags)) appliedFlags[name] = { from, to };
}

function patchStore(store: any, s: Settings) {
  const flags = store?.EXPERIMENT_FLAGS;
  if (flags && typeof flags === 'object') {
    for (const [k, v] of Object.entries(pageFlagOverrides(s))) {
      if (flags[k] !== v) {
        record(k, flags[k], v);
        flags[k] = v;
      }
    }
  }
  const playerOverrides = playerFlagOverrides(s);
  const configs = store?.WEB_PLAYER_CONTEXT_CONFIGS;
  if (configs && typeof configs === 'object' && Object.keys(playerOverrides).length) {
    for (const cfg of Object.values<any>(configs)) {
      if (typeof cfg?.serializedExperimentFlags !== 'string') continue;
      const params = new URLSearchParams(cfg.serializedExperimentFlags);
      let changed = false;
      for (const [k, v] of Object.entries(playerOverrides)) {
        if (params.get(k) !== v) {
          record(`player:${k}`, params.get(k), v);
          params.set(k, v);
          changed = true;
        }
      }
      if (changed) cfg.serializedExperimentFlags = params.toString();
    }
  }
}

export function installFlagOverrides(getSettings: () => Settings) {
  const w = window as any;
  const patch = () => {
    const s = getSettings();
    patchStore(w.ytcfg?.data_, s);
    if (w.yt?.config_ !== w.ytcfg?.data_) patchStore(w.yt?.config_, s);
    // Re-patch whenever YouTube merges more config in.
    if (w.ytcfg?.set && !w.ytcfg.set.__bettertube) {
      const orig = w.ytcfg.set;
      w.ytcfg.set = function (...args: unknown[]) {
        const result = orig.apply(this, args);
        patch();
        return result;
      };
      w.ytcfg.set.__bettertube = true;
    }
  };

  // Inline <script>s call ytcfg.set() during parsing; the app bundle (a later
  // external script) reads the flags. Patching on every inserted <script>
  // lands between the two.
  const observer = new MutationObserver((records) => {
    if (records.some((r) => [...r.addedNodes].some((n) => n.nodeName === 'SCRIPT'))) patch();
  });
  observer.observe(document, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => {
    patch();
    setTimeout(() => observer.disconnect(), 10_000);
  });
  document.addEventListener('yt-navigate-finish', patch);
  patch();
}
