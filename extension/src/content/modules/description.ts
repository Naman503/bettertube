// Shows the video description under the title when YouTube's own description
// box isn't there. In the 2026 side-menu layout it moved behind the
// "Description" icon on the right. The text comes from the player response,
// so this works whatever layout YouTube serves.
import { track } from '../../shared/track';
import type { VideoInfo } from '../../shared/bridge';
import { $, isVisible, mainVideo, waitFor } from '../dom';
import type { Module } from '../types';

const BOX_ID = 'bt-description';
const TOKEN = /(https?:\/\/[^\s<>"]+)|(\b(?:\d{1,2}:)?\d{1,2}:\d{2}\b)|(#[\p{L}\p{N}_]+)/gu;

const youtubeBoxVisible = () => {
  const box = $('ytd-watch-metadata #description');
  return isVisible(box) && box!.getBoundingClientRect().height > 30;
};

function toSeconds(stamp: string) {
  return stamp.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
}

/** Description text → nodes with clickable links, timestamps and hashtags (no innerHTML). */
function richText(text: string): Node[] {
  const nodes: Node[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index! > last) nodes.push(document.createTextNode(text.slice(last, m.index)));
    const [token, url, stamp, tag] = m;
    const a = document.createElement('a');
    a.textContent = token;
    if (url) {
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    } else if (stamp) {
      a.href = `#t=${toSeconds(stamp)}`;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const video = mainVideo();
        if (video) {
          track('description_timestamp');
          video.currentTime = toSeconds(stamp);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      });
    } else if (tag) {
      a.href = `/hashtag/${encodeURIComponent(tag.slice(1))}`;
    }
    nodes.push(a);
    last = m.index! + token.length;
  }
  if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
  return nodes;
}

function metaLine(info: VideoInfo) {
  const parts: string[] = [];
  if (info.viewCount !== null) parts.push(`${info.viewCount.toLocaleString()} views`);
  if (info.publishDate) {
    const date = new Date(info.publishDate);
    if (!Number.isNaN(date.getTime())) {
      parts.push(date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }));
    }
  }
  return parts.join(' · ');
}

function build(info: VideoInfo) {
  const box = document.createElement('div');
  box.id = BOX_ID;
  box.dataset.videoId = info.videoId;
  box.className = 'bt-desc bt-collapsed';

  const meta = document.createElement('div');
  meta.className = 'bt-desc-meta';
  meta.textContent = metaLine(info);

  const body = document.createElement('div');
  body.className = 'bt-desc-text';
  body.append(...richText(info.description || 'No description.'));

  const toggle = document.createElement('button');
  toggle.className = 'bt-desc-toggle';
  toggle.textContent = 'Show more';
  const setCollapsed = (collapsed: boolean) => {
    if (!collapsed && box.classList.contains('bt-collapsed')) track('description_expanded');
    box.classList.toggle('bt-collapsed', collapsed);
    toggle.textContent = collapsed ? 'Show more' : 'Show less';
  };
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    setCollapsed(!box.classList.contains('bt-collapsed'));
  });
  // Clicking the collapsed box expands it, like YouTube's own.
  box.addEventListener('click', (e) => {
    if (box.classList.contains('bt-collapsed') && !(e.target as Element).closest('a')) setCollapsed(false);
  });

  box.append(meta, body, toggle);
  return box;
}

async function render(info: VideoInfo) {
  const metadata = await waitFor('ytd-watch-flexy ytd-watch-metadata');
  if (!metadata) return;
  const existing = document.getElementById(BOX_ID);
  if (existing?.dataset.videoId === info.videoId) return;
  existing?.remove();
  const box = build(info);
  metadata.after(box);
  track('description_shown');
  // Hide the toggle if the text fits without collapsing.
  requestAnimationFrame(() => {
    const text = box.querySelector<HTMLElement>('.bt-desc-text')!;
    if (text.scrollHeight <= text.clientHeight + 2) box.classList.add('bt-short');
  });
}

let lastInfo: VideoInfo | null = null;

async function update(enabled: boolean) {
  const info = lastInfo;
  if (!enabled || !info) {
    document.getElementById(BOX_ID)?.remove();
    return;
  }
  // YouTube renders its own box a moment after the video loads; give it a chance.
  await new Promise((r) => setTimeout(r, 1200));
  if (info !== lastInfo) return;
  if (youtubeBoxVisible()) document.getElementById(BOX_ID)?.remove();
  else void render(info);
}

export const description: Module = {
  id: 'description',

  css: () => `
#${BOX_ID} {
  margin: 12px 0 0; padding: 12px; border-radius: 12px;
  background: var(--bt-chip);
  color: var(--bt-text);
  font: 400 1.4rem/2rem Roboto, Arial, sans-serif;
}
#${BOX_ID}.bt-collapsed { cursor: pointer; }
#${BOX_ID}.bt-collapsed:hover { background: var(--bt-chip-hover); }
#${BOX_ID} .bt-desc-meta { font-weight: 500; margin-bottom: 4px; }
#${BOX_ID} .bt-desc-text { white-space: pre-wrap; overflow-wrap: anywhere; }
#${BOX_ID}.bt-collapsed .bt-desc-text {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden;
}
#${BOX_ID} a { color: var(--bt-link); text-decoration: none; }
#${BOX_ID} a:hover { text-decoration: underline; }
#${BOX_ID} .bt-desc-toggle {
  margin-top: 6px; padding: 0; border: 0; background: none; cursor: pointer;
  color: var(--bt-text); font: 500 1.4rem/2rem Roboto, Arial, sans-serif;
}
#${BOX_ID}.bt-short .bt-desc-toggle { display: none; }
`,

  onVideo(ctx, info) {
    lastInfo = info;
    void update(ctx.settings.restoreDescription);
  },

  onPage(ctx) {
    if (!ctx.page.isWatch) {
      lastInfo = null;
      document.getElementById(BOX_ID)?.remove();
    }
  },

  onSettings(ctx) {
    void update(ctx.settings.restoreDescription);
  },

  check(ctx) {
    if (!ctx.page.isWatch) return [];
    const ours = document.getElementById(BOX_ID);
    return [
      {
        label: 'Description under video',
        status: youtubeBoxVisible() || ours ? 'ok' : ctx.settings.restoreDescription ? 'warn' : 'info',
        detail: youtubeBoxVisible() ? "YouTube's own box" : ours ? 'BetterTube box' : 'none',
      },
    ];
  },
};
