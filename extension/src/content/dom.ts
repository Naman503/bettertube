export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector<T>(sel);

export const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolves with the first element matching `sel`, or null after `timeout` ms. */
export function waitFor<T extends Element = HTMLElement>(
  sel: string,
  { root = document as ParentNode, timeout = 10_000 } = {},
): Promise<T | null> {
  const found = root.querySelector<T>(sel);
  if (found) return Promise.resolve(found);
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const el = root.querySelector<T>(sel);
      if (!el) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve(el);
    });
    observer.observe(root as Node, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeout);
  });
}

export const isVisible = (el: Element | null) => !!el && el.getClientRects().length > 0;

export const mainVideo = () =>
  $<HTMLVideoElement>('#movie_player video.html5-main-video') ?? $<HTMLVideoElement>('#movie_player video');

/** "ytd-watch-flexy > #columns > #secondary > #related" — where an element sits. */
export function pathOf(el: Element | null, stopAt = 'ytd-app'): string | null {
  if (!el) return null;
  const parts: string[] = [];
  for (let n: Element | null = el; n && n.localName !== stopAt; n = n.parentElement) {
    if (n.id) parts.unshift(`#${n.id}`);
    else if (n.localName.includes('-')) parts.unshift(n.localName);
  }
  return parts.join(' > ');
}

export function setCookie(name: string, value: string, days = 400) {
  const attrs = `path=/; max-age=${days * 86400}; secure; samesite=lax`;
  // Write both host-only and domain-wide copies so whichever YouTube reads agrees.
  document.cookie = `${name}=${value}; ${attrs}`;
  document.cookie = `${name}=${value}; domain=.youtube.com; ${attrs}`;
}

export const getCookie = (name: string) =>
  document.cookie
    .split('; ')
    .filter((c) => c.startsWith(`${name}=`))
    .map((c) => c.slice(name.length + 1));

let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** A short message over the player (top-left). */
export function toast(text: string) {
  const player = $('#movie_player');
  if (!player) return;
  let node = $('.bt-toast', player);
  if (!node) {
    node = document.createElement('div');
    node.className = 'bt-toast';
    player.append(node);
  }
  node.textContent = text;
  node.classList.add('bt-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node!.classList.remove('bt-visible'), 3500);
}

/**
 * False once BetterTube has been reloaded or updated: scripts already in an
 * open tab are then cut off, and any chrome.* call throws "Extension context
 * invalidated". Timers check this and go quiet instead.
 */
export function alive() {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}
