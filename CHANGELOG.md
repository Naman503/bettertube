# Changelog

All notable changes to BetterTube. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Stop gradual speed-up for this video** (`Q`, toggle) and **pause it for a set time** (`W`, default 10 min, any duration). Both are in the speed panel and the popup too. A timed pause carries across videos and tabs and ends by itself; any resume key ends it early. Saved shortcut lists get `Q`/`W` once, if those keys are free.
- **Incognito mode.** Everything works, but nothing is recorded: no watch stats, no diagnostics snapshot, and your normal site speeds and pause state stay untouched. Incognito speeds start from your normal ones, live in memory only, and are forgotten when the last incognito tab closes. The badge and popup say "Incognito · not recorded". This needs **Allow in Incognito** turned on.

### Fixed
- **Netflix showed a black screen.** BetterTube no longer runs on Netflix.
- **Videos a page plays before attaching them** were pulled into a hidden holder, which could leave the player empty or without the speed overlay. Only off-page audio is held now.
- **On-video messages wrapped one word per line** (e.g. "Speed-up stopped for this video").

## [0.4.0] — 2026-10-15

### Added
- **Gradual speed-up.** Speed rises by a small step while a video actually plays, up to a max you set. Step, interval (s / min / h) and short-video cutoff accept any value.
  - **Carry-over:** the next video continues where the last one got to.
  - **Rewinds:** jumping back eases the speed down and pauses the climb for a minute.
  - **Per-shortcut control:** each shortcut can pause or resume the climb (R pauses; preferred speeds and D resume). A pause lasts across videos and tabs.
  - **Quiet zone:** no climbing between two speeds you choose, e.g. 1–2× for music.
- **Per-site speed memory.** Each site keeps its own last speed, and a new site starts at your last speed anywhere. Embedded videos follow the page they're on. Saved sites are listed in the popup.
- **Speed controller reaches all media:**
  - audio played without being on the page (`new Audio()`);
  - media inside web components (shadow DOM);
  - players in embedded frames, with keys passed between the page and the frame.

  Audio shows a corner badge with the new speed.
- **Decimal places** for the on-video speed (Auto, 0–3; display only).
- **Dashboard explanation:** "Saved by speed" now shows its math ("9h 51m of video in 4h 27m · average 2.21×").

### Fixed
- **Gradual speed-up stuck at 3.01×** with +0.005× steps (two-decimal rounding). Speeds now keep three decimals.
- **Speed-up intervals ran long** (e.g. every ~3 s instead of 2 s); leftover time now carries over.
- **Shortcuts going to the wrong media** when several were playing. They now go to what's playing, audible and on-screen, so muted previews lose.
- **Saved-by-speed counted jumps (X / +10 s) as watched video**, and dropped real playback when the speed changed mid-sample.
- **Fullscreen with F was undone** by the theater guard.

## [0.3.0] — 2026-10-09

### Added
- **Speed controller for every site,** replacing Video Speed Controller:
  - an on-video overlay;
  - a panel with slider, presets and exact entry (0.07–16×);
  - your shortcuts, an editor, and a per-site off list.
- **Redesigned popup:** Home, YouTube, Speed and Health tabs; it doubles as the options page.
- **Watch-stats dashboard and top-bar badge.**
- **Self-reload** for unpacked builds, and an "updated, reload this tab" notice.

### Fixed
- **YouTube's 2026 side-rail / split-scroll layout:** BetterTube now turns off the experiment flags behind it, which fixes theater-on-open, the two-column up-next grid over the player, and the hidden description.

## [0.2.0] — 2026-10-08

### Added
- **Resizable player** (drag the divider).
- **Description under the video** when YouTube hides it.
- **Avoid buffering:** steps the quality down when a video keeps buffering.
- **First version of watch stats.**

## [0.1.0] — 2026-10-08

### Added
- **First release:**
  - opens videos in normal view;
  - classic watch layout and a compact up-next list;
  - hides Shorts and AI clutter;
  - codec filter for Mac battery life;
  - diagnostics.
