# Changelog

All notable changes to BetterTube. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.8.0] — 2026-11-25

### Added
- **Redesigned dashboard:** cleaner cards, the Inter font, interactive charts (Apache ECharts) with hover details, and small trend lines in the four headline cards. Light and dark follow your system.
- **Pick any dates on the dashboard:** a date-range calendar (easepick) with presets (today, yesterday, last 7 / 30 / 90 days, this month, last month, this year, all time), any custom from–to range, and ‹ › to step back and forward by the same length.
- **Compared with the previous period:** watch time, videos, time saved, average speed and time on YouTube show the change (▲ 12% vs previous 30 days).
- **More analysis:**
  - a trend chart switchable between watch time, time saved, videos and speed, with average and daily-limit lines, the previous period as a dashed line, and zoom for long ranges (weekly columns past 3 months);
  - an activity calendar with days watched, best day, average and longest run;
  - a weekday × hour heatmap;
  - average watch time by weekday;
  - the speeds you watch at (donut);
  - video length: finished vs. not;
  - top videos;
  - new tiles (average speed, channels, videos per day, days over the limit);
  - streaks, weekend and late-night share.
- **Video log:** search titles and channels, sort by any column.

### Fixed
- **"Saved by speed" showed 0 on longer ranges.** A video YouTube reported as playing but that never moved (a frozen or forgotten tab) counted as watch time, up to 12 hours a day, which swamped the time saved. Such playback is no longer counted. Already-recorded stuck playback is left out of the dashboard, popup, badge and daily limit, with a note saying how much (nothing is deleted).

## [0.7.0] — 2026-11-04

### Added
- **Daily limit pop-up.** Going over your daily limit pauses the video and asks: **Okay for today** (quiet until tomorrow), **Remind me in 15 min** (`Esc` too), or **Stop watching** (closes the tab). Answering in one tab closes it in the others. Switch: Popup → YouTube → Watch stats → "Pop up when I go over the limit" (on by default).
- **Set the daily limit to any time, to the minute** (1 min – 24 h): an on/off switch, hours and minutes boxes (typing 95 minutes becomes 1h 35m), −5 / +5 buttons, and quick picks (15m to 4h). Replaces the fixed list.

### Changed
- **Over the limit is now hard to miss:** the top-bar badge turns red with an hourglass pill (`+15m`), and its card leads with "Over your daily limit by 15m". The popup and dashboard show the same in red with an hourglass, instead of a small grey line. Under the limit they show time left.

## [0.6.0] — 2026-10-26

### Added
- **Richer anonymous usage** (same off switch, same 6-hour schedule): how speeds are changed (keys, overlay buttons, wheel, slider, chips, typed value, the site's own menu), shortcut actions used, overlay panel opens, gradual speed-up steps / pauses / resumes, popup tabs, quick toggles and presets, dashboard opens, layout fixes applied (view corrections, Shorts redirects, autoplay off, quality changes), a daily "was used" ping, a daily settings snapshot (switches and choices only), and yesterday's watch time, sessions and ads as ranges. Never video IDs, titles, channels, sites, URLs or anything typed; nothing from incognito.
- **Error reports** from BetterTube's own code (service worker, YouTube scripts, speed controller, popup, dashboard), with addresses and quoted text stripped, at most one per bug per day.

## [0.5.0] — 2026-10-25

### Added
- **Share anonymous usage** (popup → YouTube → Watch stats), on by default: feature switches used, speed changes by range, minutes saved and videos watched per day, and setup milestones, with a random id. Never video IDs, titles, channels, sites or incognito. Turning it off deletes what was sent. Adds the API host permission for sending.

### Added
- **Stop gradual speed-up for this video** (`Q`, toggle) and **pause it for a set time** (`W`, default 10 min, any duration). Both are in the speed panel and the popup too. A timed pause carries across videos and tabs and ends by itself; any resume key ends it early. Saved shortcut lists get `Q`/`W` once, if those keys are free.
- **Incognito mode.** Everything works, but nothing is recorded: no watch stats, no diagnostics snapshot, and your normal site speeds and pause state stay untouched. Incognito speeds start from your normal ones, live in memory only, and are forgotten when the last incognito tab closes. The badge and popup say "Incognito · not recorded". This needs **Allow in Incognito** turned on.
- **Per-site on/off switch** at the top of **Popup → Speed**. A turned-off site is left completely alone (no overlay, no shortcuts, no page hooks).
- **Netflix support:** jumps (`Z`/`X`, mark/jump) go through Netflix's own player, since setting the time directly makes Netflix stop with an error.

### Fixed
- **Netflix showed a black screen** (see below: its video was pulled out of the player).
- **Videos a page plays before attaching them** were pulled into a hidden holder, which could leave the player empty or without the speed overlay. Only off-page audio is held now.
- **The popup's speed card never appeared on sites other than YouTube** (it needed the tab's address, which only YouTube grants).
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
