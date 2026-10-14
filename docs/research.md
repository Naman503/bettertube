# YouTube desktop UI: research notes (2026-10-08)

Labels: **[C]** confirmed by a primary source or several sources · **[R]** only reports or secondary sources · **[U]** unverified, check in DevTools.

## Timeline of redesigns
- **2024-04: watch-page "grid" test** (`ytd-watch-grid`) [C]. Description and comments moved to the right column and recommendations went below the player. It was reverted after backlash, then ran as a Premium experiment until July 2024.
  - [9to5Google](https://9to5google.com/2024/04/11/youtube-sidebar-redesign-test/), [revert](https://9to5google.com/2024/04/25/youtube-redesign-reverted-backlash/)
- **2025-04: big home-grid thumbnails** [C], with 2–3 per row. YouTube defended it in Sep 2026, saying it raised long-form engagement.
  - [Android Authority](https://androidauthority.com/youtube-large-thumbnails-3545453), [SEJ](https://searchenginejournal.com/youtube-bigger-thumbnails-long-form-engagement/588102)
- **2025-07 test → global from 2025-10-13: "Delhi" player** [C]. Pill-shaped bubble controls with translucent "glass" styling. You can no longer scroll the wheel over the volume control, and contrast is poor. The embed player got the same treatment in Mar 2026.
  - [9to5Google](https://9to5google.com/2025/07/10/youtube-video-player-redesign-test), [Neowin](https://www.neowin.net/news/pointless-and-bad-youtubes-new-player-ui-draws-criticism-from-users/), [Android Authority](https://www.androidauthority.com/youtube-ui-changes-global-rollout-3607075)
- **2025-09: theater "big mode"** (`ytp-big-mode`) [R]. The Miniplayer button was missing for some users. [PiunikaWeb](https://piunikaweb.com/2025/09/09/youtube-big-theater-mode-ui-and-miniplayer-placement-experiment/)
- **2025-10: theater becomes pseudo-fullscreen** [R]. Scrolling shows recommendations, and comments sit behind a button. [PiunikaWeb](https://piunikaweb.com/2025/10/29/youtube-theater-mode-new-ui-change/)
- **2026-01→04: giant sidebar thumbnails** [R], with titles cut to 2–3 words. [PiunikaWeb](https://piunikaweb.com/2026/04/13/youtube-sidebar-thumbnails-bigger-ui-test/)
- **2026-02: Subscriptions list view removed** [R].
- **2026-04/05: RAM runaway bug** (about 7 GB per tab) [R]. Caused by a layout loop in the action bar. The reported workaround is the uBO filter `www.youtube.com###menu`. [Creator Handbook](https://www.creatorhandbook.net/youtube-bug-sends-browser-ram-usage-soaring/)
- **2026-09: new watch-page side menu test** [R]. Control Panel for YouTube v1.36 hides it.
- **2026-10-07: the comments-sidebar layout is back for a broader group** [C, several outlets]. The player takes about the left half, the right panel holds the description and comments, and recommendations sit below. There is no opt-out.
  - [Ubergizmo](https://www.ubergizmo.com/2026/10/youtube-tests-desktop-redesign-comments-moved-to-right-panel/), [Gagadget](https://gagadget.com/en/729150-youtube-is-testing-a-sidebar-layout-for-desktop-again/), [Android Authority](https://www.androidauthority.com/youtube-desktop-comments-sidebar-redesign-3720193/)

## Theater mode persistence
- Theater mode is remembered in the **`wide` cookie** (`wide=1` theater, `0` default) [C, community].
- [U] In the DOM it shows as `ytd-watch-flexy[theater]`, with the player moved into `#player-full-bleed-container`. Other attributes: `[full-bleed-player]`, `.ytp-big-mode`.
- "Theater is now the default" was **not** confirmed as an official YouTube change.

## Other irritants
- AI auto-dubbing has no global off switch. You switch to the original track per video. [MediaNama](https://www.medianama.com/2025/09/223-youtube-ai-dubbing-backlash-default-setting/)
- Titles are auto-translated. Prior art: yt-anti-translate.
- Gemini AI features: the "Ask" button and AI summaries.
- Shorts flood search results. The official Shorts limit is mobile-first.
- Smaller ones: the "Continue watching?" popup, the pink progress bar, hover previews, Ambient mode, Stable Volume, end-screen cards, number keys seeking by accident.

## Existing extensions
- **Control Panel for YouTube** (insin): the best maintained fixer in 2026. It handles flag stripping, Delhi revert, Miniplayer, theater control, related-sidebar restore, items per row, Shorts, AI, ambient mode, original audio, square corners. Weakness: it depends on locale strings. [releases](https://github.com/insin/control-panel-for-youtube/releases)
- **Enhancer for YouTube**: still on the Chrome Web Store (v3.0.19, Jul 2026, MV3, about 2M users). It is closed source and was delisted from Firefox for a while in 2025.
- **Improve YouTube!**: huge feature set, but about 1.3k open issues and it needs maintainers.
- **Unhook** and **Unhook NG**: distraction removal. RYS paywalled features.
- **SponsorBlock**, **DeArrow**, **Return YouTube Dislike**: stable, and loved as the core trio.
- **BlockTube**: alive (Feb 2026).
- **Iridium**: dormant since 2024.
- **enhanced-h264ify**: dormant since 2024.
- **Userscripts:** OldYTPlayer (Oct 2025), YouTube Non-Rounded Design (updated 2026-10-01), YouTube Redux.
- The Chrome Web Store removed all MV2 extensions on 2026-08-31.

## Performance
- The site is a Polymer/web-components SPA ("Kevlar").
- Main costs: Ambient mode, hover previews, live chat (about 60 repaints a second), animations, the action-bar layout loop, and large thumbnail grids.
- On Macs: H.264 is hardware-decoded everywhere, VP9 is hardware-decoded on Apple Silicon, and AV1 is hardware-decoded only on **M3 and later**. Block AV1 on M1, M2 and Intel. [Jellyfin doc](https://jellyfin.org/docs/general/post-install/transcoding/hardware-acceleration/apple)
- Codec filter technique: in the MAIN world at `document_start`, wrap `MediaSource.isTypeSupported` and `HTMLMediaElement.prototype.canPlayType` to reject `av01`, `vp09`, `vp9`, `vp8` and `webm`.

## Technical notes
- **Manifest pattern (CPfYT):**
  - isolated `content.js` plus MAIN-world `page.js` (`"world":"MAIN"`), both at `document_start`;
  - `embed.js` for `/embed/*` with `all_frames`;
  - only the `storage` permission;
  - the two scripts talk through `postMessage` init, then a `BroadcastChannel` with a random UUID name.
- **Data patching:**
  - proxy `fetch` and the `XMLHttpRequest` response getters;
  - redefine `ytInitialData`, `ytInitialPlayerResponse` and `ytInitialReelWatchSequenceResponse` with setters;
  - listen for `yt-page-data-fetched`.
- **Navigation:** SponsorBlock (maze-utils) uses `yt-navigate-finish`, Navigation API `navigate` and a MutationObserver on `#movie_player .html5-video-container`. `yt-page-data-updated` is also common.
- **Experiment flags:**
  - Player flags live in `yt.config_.WEB_PLAYER_CONTEXT_CONFIGS[*].serializedExperimentFlags`. Strip `delhi_modern_web_player=true` and `delhi_modern_web_player_icons=true` to revert the Delhi player, retrying for about 12 s.
  - Page flags live in `yt.config_.EXPERIMENT_FLAGS`:

| Flag(s) | Effect |
|---|---|
| `kevlar_watch_grid`, `kevlar_watch_grid_hide_chips` | Watch-page grid layout |
| `web_rounded_containers`, `web_rounded_thumbnails`, `web_watch_rounded_player_large` | Rounded corners |
| `kevlar_watch_cinematics` | Ambient mode |
| `kevlar_watch_max_player_width` | Player width |
| `wn_grid_min_item_width`, `wn_grid_max_item_width` | Grid item sizing |
| `web_watch_theater_chat`, `web_watch_theater_fixed_chat` | Theater chat |

  - The flag for the Oct 2026 sidebar test is **unknown**. Find it by comparing an affected account with an unaffected one.
- **Forcing theater or default view:** click `.ytp-size-button` depending on whether the player is in `#player-full-bleed-container`, or set the `wide` cookie before load. Remove `ytp-big-mode`.
- **Restoring the related sidebar** with CSS: `--ytd-watch-flexy-sidebar-width: 402px` plus small thumbnails.
- **Selectors [U]:** `#movie_player`, `ytd-watch-flexy`, `#primary`, `#secondary`, `#related`, `ytd-watch-next-secondary-results-renderer`, `#below`, `ytd-comments`.
  - Engagement panels: `ytd-engagement-panel-section-list-renderer[target-id=engagement-panel-searchable-transcript | engagement-panel-structured-description | engagement-panel-comments-section]`.
- **`movie_player` API** (undocumented, page world):
  - Confirmed: `getAvailableQualityLevels`, `setPlaybackQualityRange`. Quality setting only works once quality levels are populated, so retry after `onStateChange`.
  - Unverified: `getStatsForNerds`, `getVideoData`, `getPlayerResponse`, `getCurrentTime`, `seekTo`, `setPlaybackRate`.
- **Trusted Types** is enforced in the MAIN world. Don't use `innerHTML`, and never create a "default" policy.

## Developer feature prior art
- Notes: NoteFrames, YT Timestamp Notes.
- Transcript: TubeMD, Video2Source.
- OCR: Video Text & Code OCR, CodeSnap, Selectext.
- Speed memory: ytSpeedControl, TurboTube.
- A–B loop: YouTube Looper, LoopIt.

The gap is a single private, local-only bundle that does all of these.

## UX critique takeaways
- Keep the player stable, with nothing clickable directly under the controls.
- Comments should scroll independently, and be spoiler-safe.
- Let users choose density and see full titles.
- Restore direct-manipulation controls.
- Make theater mode "wide but scrollable".
- Elizabeth Laraki's 2006 YouTube usability notes ([2024 repost](https://elizlaraki.substack.com/p/make-youtube-better)): autoplay is intrusive, users want better seek and skip, and related videos should actually be related.
