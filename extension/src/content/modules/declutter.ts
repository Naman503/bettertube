// AI buttons, end-screen cards, hover previews, ambient glow, autoplay, and the
// "Video paused. Continue watching?" dialog.
import { $, isVisible, waitFor } from '../dom';
import type { Module } from '../types';
import { track } from '../../shared/track';

// Best-effort: these elements are new and their names are unconfirmed.
// The Diagnostics tab shows whether they matched anything.
const AI_SELECTORS = [
  ':is(yt-button-view-model, ytd-button-renderer):has(button[aria-label="Ask" i])',
  'ytd-engagement-panel-section-list-renderer[target-id="PAyouchat"]',
  'ytd-expandable-metadata-renderer',
];

const ENDSCREEN_SELECTORS = [
  '.ytp-ce-element',
  '.ytp-ce-covering-overlay',
  '.ytp-cards-teaser',
  '.ytp-cards-button',
  '.ytp-endscreen-content',
  '.ytp-fullscreen-grid',
  '.ytp-suggested-action',
].map((s) => `#movie_player ${s}`);

const HOVER_PREVIEW_SELECTORS = [
  'ytd-video-preview',
  '#video-preview',
  'ytd-moving-thumbnail-renderer',
  'ytd-thumbnail-overlay-loading-preview-renderer',
];

const AMBIENT_SELECTORS = ['#cinematics', '#cinematics-container'];

const hide = (selectors: string[]) => `${selectors.join(',\n')} { display: none !important; }\n`;

let autoplayHandled = false;

export const declutter: Module = {
  id: 'declutter',

  css(s) {
    let css = '';
    if (s.hideAI) css += hide(AI_SELECTORS);
    if (s.hideEndscreen) css += hide(ENDSCREEN_SELECTORS);
    if (s.disableHoverPreviews) css += hide(HOVER_PREVIEW_SELECTORS);
    if (s.disableAmbient) css += hide(AMBIENT_SELECTORS);
    return css;
  },

  init(ctx) {
    // Backup for the MAIN-world _lact keep-alive: if the idle dialog still
    // appears right after an automatic pause, confirm it and resume.
    document.addEventListener(
      'pause',
      (e) => {
        const video = e.target;
        if (!ctx.settings.autoContinue || !(video instanceof HTMLVideoElement)) return;
        if (!video.closest('#movie_player')) return;
        setTimeout(() => {
          const dialog = $('ytd-popup-container yt-confirm-dialog-renderer');
          if (!isVisible(dialog)) return;
          $('#confirm-button button, #confirm-button', dialog!)?.click();
          track('idle_dialog_dismissed');
          void video.play();
        }, 500);
      },
      true,
    );
  },

  async onPage(ctx) {
    if (!ctx.page.isWatch || !ctx.settings.autoplayOff || autoplayHandled) return;
    // Turn autoplay off once per page load; YouTube remembers it from there.
    const toggle = await waitFor('#movie_player .ytp-autonav-toggle-button');
    if (!toggle) return;
    autoplayHandled = true;
    if (toggle.getAttribute('aria-checked') === 'true') {
      toggle.click();
      track('autoplay_turned_off');
    }
  },

  check(ctx) {
    if (!ctx.page.isWatch) return [];
    const toggle = $('#movie_player .ytp-autonav-toggle-button');
    return [
      {
        label: 'Autoplay toggle',
        status: toggle ? 'ok' : ctx.settings.autoplayOff ? 'warn' : 'info',
        detail: toggle ? `autoplay ${toggle.getAttribute('aria-checked') === 'true' ? 'on' : 'off'}` : 'not found',
      },
      {
        label: 'AI elements matched (hidden)',
        status: 'info',
        detail: String(document.querySelectorAll(AI_SELECTORS.join(',')).length),
      },
    ];
  },
};
