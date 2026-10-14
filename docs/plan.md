# BetterTube (working name): Plan

A Manifest V3 extension for Brave and Chrome that does four things:

- puts the YouTube watch page back the way you liked it;
- removes clutter;
- makes YouTube lighter on your Mac;
- adds tools for watching technical videos: notes, transcript, code OCR, chapters and stats.

Status: **v0.1 built (phases 1–3)**, 2026-10-08. See [README.md](README.md). Next step: phase 0 recon on your signed-in account, using the popup's "Copy diagnostics" button. Then phase 4. Research sources are in [`docs/research.md`](docs/research.md).

**Stack change from this plan:** plain TypeScript + esbuild + a hand-written manifest instead of WXT. It has fewer moving parts, and every piece of build behavior is visible in `build.mjs`.

---

## 1. What's going on with YouTube right now

Your two complaints map onto YouTube changes that are live as of October 2026.

| What you see | What it actually is |
|---|---|
| **Description and comments on the right, where "Up next" videos used to be** | YouTube restarted its **"comments sidebar" watch-page test** around 2026-10-07. The player sits in about the left half, the title, description and comments go in the right panel, and large recommendation thumbnails sit below the player. It first appeared in 2024, was reverted after backlash, and is back for a broader group. There is no setting to turn it off. |
| **Every video opens in theater mode** | YouTube has not officially made theater mode the default. Theater mode is remembered through a **`wide` cookie** (`wide=1`), and in late 2025 theater mode became a near-full-screen "big mode" (`ytp-big-mode`) with controls drawn larger. The new layout test also makes the player behave differently. We'll fix all three paths. |

What other people complain about, roughly ranked by how often it comes up:

1. Watch-page layout reshuffles.
2. The 2025 "Delhi" player: pill-shaped bubble controls, no scrolling the mouse wheel over volume, a missing Miniplayer button, low contrast.
3. Giant thumbnails with few items per row, and sidebar titles cut to 2–3 words.
4. Shorts everywhere, including search results.
5. The big full-bleed theater mode.
6. AI auto-dubbing and auto-translated titles.
7. The Gemini "Ask" button and AI summaries.
8. RAM and CPU use: a 2026 bug pushed tabs to about 7 GB.
9. Smaller annoyances: the "Continue watching?" popup, autoplay, Ambient mode, hover previews, rounded corners, end-screen cards.

**What's missing in existing extensions:**

- **Control Panel for YouTube** is the best maintained, but it's mostly about hiding things.
- **Enhancer for YouTube** is closed source.
- **Improve YouTube!** is drowning in issues and asking for maintainers.
- **Unhook** breaks after redesigns.
- **The developer tools** (notes, OCR, transcript) are spread across tiny single-purpose extensions.

Our angle is **one open, local-only, fast-to-fix extension** that combines layout fixes, cleanup and a learning toolkit, with a built-in **health check** that tells you exactly what broke when YouTube changes something.

---

## 2. Architecture

### Stack

| Piece | Choice |
|---|---|
| Framework | **WXT**: Vite-based, MV3, TypeScript, hot reload, cross-browser builds |
| Side panel UI | Preact or Solid (small); everything else is plain DOM |
| Storage | `chrome.storage.sync` for settings, `chrome.storage.local` and IndexedDB for notes and screenshots |
| Permissions | `storage`, `sidePanel`, host access to `*.youtube.com` only. Optionally `downloads`. No remote code, no analytics. |

### Folder layout

```
youtube-better-ui-extension/
  PLAN.md
  docs/research.md           sources and technical notes
  docs/flags.md              known YouTube experiment flags and what they do (kept up to date)
  extension/                 WXT project
    entrypoints/
      main-world.content.ts   world: MAIN, run_at: document_start
                              (flag overrides, ytInitialData patching, codec filter, movie_player API)
      isolated.content.ts     settings, CSS injection, DOM fixes, keyboard shortcuts, overlays
      embed.content.ts        /embed/* (all_frames)
      background.ts           service worker: messaging, commands, side panel, context menus
      sidepanel/              Notes · Transcript · Chapters · Screenshots · OCR
      popup/                  quick toggles and preset switcher
      options/                full settings, import/export, health check
    modules/                  one folder per feature: { id, defaults, css, init(ctx), destroy() }
    lib/yt/                   navigation events, selectors registry, player bridge, flag utils
  tests/                      Playwright (loads the unpacked extension) + saved-page fixtures
```

### Core design decisions

1. **Module system.** Every feature is a module that can be turned on or off without a page reload where possible. Modules declare their CSS, their selectors and an `init`/`destroy` pair.
2. **Two worlds, bridged.**
   - The **MAIN-world** script runs at `document_start`, before YouTube's own code. It overrides experiment flags (`yt.config_.EXPERIMENT_FLAGS`, `serializedExperimentFlags`), patches `ytInitialData` and `fetch` responses to strip Shorts and AI shelves before they render, filters codecs (`MediaSource.isTypeSupported`), and talks to the `#movie_player` API.
   - The **isolated** script does everything else.
   - The two talk through a `BroadcastChannel` with a random name, the same pattern Control Panel for YouTube uses.
3. **Three-layer fixes for each layout problem.** We try them in order:
   - (a) **experiment flags**, which make YouTube render the old layout itself;
   - (b) **DOM relocation**, which moves `#related` back into `#secondary` and the description and comments back below the player;
   - (c) **CSS only**.

   This way one YouTube change can't take the whole feature down.
4. **Selector registry.** Every selector lives in one file (`lib/yt/selectors.ts`) with fallbacks. The **health check** page tests each selector and flag on the live page and shows ✅ or ❌, so a fix takes minutes.
5. **SPA navigation.** YouTube switches pages without reloading. We listen to `yt-navigate-finish`, `yt-page-data-updated` and the Navigation API, plus a debounced URL check, and re-apply modules on every change.
6. **Trusted Types safe.** We never use `innerHTML` in the MAIN world and build DOM nodes directly.
7. **Side panel for heavy UI.** Notes, transcript and OCR live in `chrome.sidePanel`, not inside YouTube's page. They survive redesigns and don't fight YouTube's CSS. OCR (Tesseract.js, bundled WebAssembly) runs on the extension page, not in YouTube's page.

---

## 3. Features

Features are grouped by module. ★ marks MVP.

### A. Layout fixer (your main pain)
- ★ **Default view on open**, with three choices: *normal*, *theater* or *remember last*. Sets the `wide` cookie at `document_start`, clicks `.ytp-size-button` if the page loads in the wrong mode, and removes `ytp-big-mode`.
- ★ **Classic watch layout:** up-next/related videos in the right sidebar, with description and comments below the player.
- ★ **Compact related sidebar:** small thumbnails, full titles, a configurable sidebar width.
- **Home grid density:** 3–6 videos per row, and thumbnail size.
- **Classic player controls:** strip the Delhi player flags, bring back mouse-wheel-over-volume and the Miniplayer button, opaque high-contrast controls.
- **Square corners** (optional).
- **Sticky mini player** when you scroll down to the comments.
- **Wide but scrollable theater:** a big player with content below it, instead of the near-full-screen version.

### B. Declutter
- ★ Shorts: hide them everywhere (home, search, subscriptions, sidebar), or open them in the normal player.
- ★ Hide the AI "Ask" button and AI summaries.
- ★ Auto-dismiss "Video paused. Continue watching?"
- ★ Autoplay off by default. End-screen cards and overlays off.
- Spoiler-safe comments: collapsed until you click.
- **Original audio always**, which undoes auto-dubbing.
- **Original titles**, which undoes auto-translation.
- Hide sections: Explore, Trending, Merch, Members-only shelves, low-view related videos.
- Hover previews off. Ambient mode off.
- Block channels and keywords (BlockTube-lite).

### C. Player power
- ★ **Speed control:** 0.25–4× in 0.05 steps, an on-screen badge, `Shift + < >` keys, and **per-channel memory**.
- ★ **Default quality** (for example "1080p, or the highest available ≤ 1440p on battery"), and remember volume.
- **Volume boost** above 100% (Web Audio gain) and scroll-wheel volume.
- **A–B loop** with saved named ranges, plus **loop this chapter**.
- **Frame step** (`,` and `.`) with a frame counter, and the **current-frame timestamp copied as a link**.
- **Screenshot frame** to the clipboard or a file, auto-named `channel_title_mm-ss.png`.
- **Resume where you left off** on any video.
- Your own keyboard shortcut map.

### D. Developer and learning toolkit (side panel)
- ★ **Timestamped notes** for each video. Press `N` to add a note at the current time. Markdown is supported, and `[12:34](https://youtu.be/ID?t=754)` links work.
  - Export to Markdown in an Obsidian-friendly format, with chapter headings inserted automatically.
- **Transcript search:**
  - fuzzy search, click to jump;
  - "copy this chapter's transcript";
  - export to Markdown or SRT.
- **Copy code from frame (OCR):** select a region of the paused video and get text with indentation kept and line numbers removed. Runs locally with Tesseract.js.
- **Chapters panel** with next/previous chapter hotkeys and a progress bar for each chapter.
- **Screenshot gallery** per video, which you can drop into notes.
- **Stats HUD:** codec (H.264, VP9 or AV1), resolution, dropped frames, buffer and bandwidth, as a small overlay. A friendlier "Stats for nerds".
- **Learning queue:** a "watch later for learning" list with progress for each video, and course-style playlists.
- Global search across all your notes.

### E. Performance and battery (Mac focused)
- ★ **Smart codec mode.** The extension reads your Mac's chip from the WebGL renderer string (for example `Apple M1 Pro`).
  - On M1/M2 and Intel Macs it blocks AV1, which those chips decode in software and which burns CPU.
  - An optional "max battery" mode forces H.264.
- ★ Ambient mode and hover-preview animations off.
- Live chat cap or slowdown for streams.
- `content-visibility: auto` on long comment and related lists, and lazy-loaded comments.
- Guard against the 2026 action-bar layout loop: detect it and neutralize `#menu`.
- A "Low-power profile" preset that bundles all of the above.

### F. Settings and quality of life
- ★ The popup holds **presets**:
  - *Classic*: old layout and default view;
  - *Focus*: no recommendations, Shorts or comments;
  - *Learning*: notes and transcript open, speed memory.
- An options page with search, plus settings import and export.
- ★ **Health check page.** It loads a video and checks every selector, flag and module with ✅ or ❌. It is the first thing to look at when YouTube changes something.
- A "refresh required" badge when a flag-based setting changes.

---

## 4. Phases and timeline

Estimates are in focused working days, solo with Claude.

| Phase | What | Days | Done when |
|---|---|---|---|
| **0. Recon** | Capture your account's real watch-page DOM, the `EXPERIMENT_FLAGS` and the `wide` cookie (snippet below). Save page fixtures. Find the flag behind the Oct 2026 sidebar test by comparing with a logged-out or other profile. | 1 | `docs/flags.md` written |
| **1. Skeleton** | WXT project, both content-script worlds plus the bridge, module system, settings storage, popup, navigation handling | 2 | A dummy module toggles live |
| **2. Layout fixer** ★ | Default view, classic layout (flags → DOM → CSS), compact sidebar, health check v1 | 3–4 | **Your two complaints are gone** |
| **3. Declutter + basics** ★ | Shorts, AI, popups, autoplay, speed memory, quality, codec mode | 2–3 | **MVP (v0.1), used daily** |
| **4. Player power** | A–B loop, frame step, screenshot, volume boost, resume, Delhi-player revert, shortcuts | 3–4 | v0.2 |
| **5. Learning side panel** | Notes and Markdown export, transcript search, chapters, screenshots gallery, stats HUD | 5–6 | v0.3 |
| **6. OCR + performance** | Tesseract OCR, chat cap, content-visibility, low-power profile, learning queue | 3–4 | v0.4 |
| **7. Hardening** | Playwright tests, fixtures for both layouts, a weekly "did YouTube break us" check, packaging (`.zip` for Brave via load unpacked; Chrome Web Store optional) | 2–3 | v1.0 |

**Total:** about **1 week to an MVP that fixes your daily annoyances (phases 0–3)** and about **4–5 weeks for everything**.

### Phase 0 recon snippet

Run this in the DevTools console on a YouTube watch page in Brave, while signed in:

```js
copy(JSON.stringify({
  wideCookie: document.cookie.split('; ').find(c => c.startsWith('wide=')),
  watchEl: [...document.querySelectorAll('ytd-watch-flexy, ytd-watch-grid')].map(e => e.tagName + ' ' + [...e.attributes].map(a => a.name).join(',')),
  bigMode: !!document.querySelector('.ytp-big-mode'),
  flags: yt.config_.EXPERIMENT_FLAGS,
  playerFlags: Object.values(yt.config_.WEB_PLAYER_CONTEXT_CONFIGS || {})[0]?.serializedExperimentFlags,
}, null, 2))
```

It copies a JSON dump to the clipboard. Paste it into `docs/recon-signed-in.json`. That tells us exactly which variant your account is in.

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| YouTube renames elements or flags every few weeks | Selector registry, three-layer fixes, health check page, Playwright smoke test against live YouTube |
| A/B tests differ between accounts | Recon on your own account, plus fallbacks for both `ytd-watch-flexy` and `ytd-watch-grid` layouts |
| Moving Polymer DOM nodes can break YouTube's own scripts | Prefer flags, then CSS. Only move nodes YouTube doesn't re-render, and re-check after navigation. |
| Conflicts with other extensions (uBO, SponsorBlock, Control Panel for YouTube) | Avoid touching ads. Namespace our CSS classes. Add a "disable overlapping modules" hint in the health check. |
| Chrome Web Store review (if published) | Narrow permissions, no remote code, everything local |

## 6. Works well alongside
Keep using **SponsorBlock**, **DeArrow**, **Return YouTube Dislike** and **uBlock Origin**. We won't duplicate them.

The **PiP Anywhere** project (`../mac-pip-anywhere`) will reuse this extension's video-detection and messaging code, and later the two can share one extension.
