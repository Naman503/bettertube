// Compact up-next list with full titles, home grid columns, and hiding the
// related list / comments entirely. (Sidebar width lives in playerSize.)
import { $ } from '../dom';
import type { Module } from '../types';

// Up-next items are "lockup" view models. Their class names changed from
// kebab-case (`yt-lockup-view-model-wiz__content-image`) to camelCase
// (`ytLockupViewModelContentImage`) in 2026, so match both.
const LOCKUP = ':is(#related, ytd-watch-next-secondary-results-renderer) yt-lockup-view-model';
const COMPACT_SIDEBAR = `
${LOCKUP} :is(.ytLockupViewModelVertical, [class*="lockup-view-model"][class*="--vertical"]) {
  display: flex !important; flex-direction: row !important; align-items: flex-start !important;
}
${LOCKUP} :is(.ytLockupViewModelContentImage, [class*="lockup-view-model"][class*="content-image"]) {
  width: auto !important; min-width: 0 !important; max-width: none !important;
  flex: none !important; padding-right: 8px !important; margin: 0 !important;
}
/* YouTube sizes the thumbnail with padding-top: 56.25%; use aspect-ratio instead. */
${LOCKUP} yt-thumbnail-view-model {
  width: 168px !important; height: auto !important; min-width: 0 !important;
  padding: 0 !important; aspect-ratio: 16 / 9 !important;
}
${LOCKUP} :is(.ytLockupViewModelMetadata, [class*="lockup-view-model"][class*="metadata"]) {
  flex: 1 1 auto !important; min-width: 0 !important; width: auto !important;
}
${LOCKUP} :is(.ytLockupMetadataViewModelTitle, [class*="lockup-metadata"][class*="title"]) {
  -webkit-line-clamp: 3 !important; max-height: none !important; white-space: normal !important;
  font-size: 1.4rem !important; line-height: 2rem !important;
}
${LOCKUP} .ytLockupViewModelVertical .ytLockupMetadataViewModelAvatar { display: none !important; }
/* The 2026 layout lays up-next out as a 2-column grid; force a single list. */
ytd-watch-next-secondary-results-renderer[use-dynamic-secondary-columns] :is(#items, #contents.ytd-item-section-renderer) {
  grid-template-columns: 1fr !important;
}
ytd-watch-next-secondary-results-renderer[use-dynamic-secondary-columns] .lockup { margin-bottom: 0 !important; }
`;

export const density: Module = {
  id: 'density',

  css(s) {
    let css = '';
    if (s.compactSidebar) css += COMPACT_SIDEBAR;
    if (s.gridItemsPerRow) {
      css += `ytd-rich-grid-renderer { --ytd-rich-grid-items-per-row: ${s.gridItemsPerRow} !important; }\n`;
    }
    if (s.hideRelated) css += `ytd-watch-flexy #related { display: none !important; }\n`;
    if (s.hideComments) css += `ytd-watch-flexy :is(ytd-comments#comments, #comments) { display: none !important; }\n`;
    return css;
  },

  check(ctx) {
    if (!ctx.page.isWatch) return [];
    const lockup = $('#related yt-lockup-view-model');
    const legacy = $('#related ytd-compact-video-renderer');
    return [
      {
        label: 'Up-next item type',
        status: lockup || legacy ? 'ok' : 'warn',
        detail: lockup ? 'yt-lockup-view-model' : legacy ? 'ytd-compact-video-renderer' : 'none found',
      },
    ];
  },
};
