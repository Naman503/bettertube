// Anonymous usage from content scripts and extension pages: counts are batched
// in memory and handed to the service worker (src/usage.ts), which applies the
// off switch and drops anything from incognito tabs. Errors from our own files
// are forwarded the same way. Nothing here ever carries page content.
import { buildCrash, isOurs, type CrashReport, type Props } from './usageCore';

let off = false;
/** Incognito (or a test that simulates it): count nothing, report nothing. */
export const setTrackingOff = (v: boolean) => void (off = v);

let delay = 2000;
/** Short-lived pages (the popup) send almost at once. */
export const setTrackDelay = (ms: number) => void (delay = ms);

const batch = new Map<string, { n: string; p?: Props; c: number }>();
let timer: ReturnType<typeof setTimeout> | undefined;

function send(msg: unknown) {
  try {
    void chrome.runtime.sendMessage(msg)?.catch?.(() => {});
  } catch {
    // extension reloaded; this script is orphaned
  }
}

export function flushTrack() {
  clearTimeout(timer);
  timer = undefined;
  if (!batch.size) return;
  const items = [...batch.values()];
  batch.clear();
  if (!off) send({ type: 'usage:batch', items });
}

/** Count one use of `name` today. Props must be fixed enums, never page text. */
export function track(name: string, props?: Props, n = 1) {
  if (off) return;
  const key = props ? `${name}|${JSON.stringify(props)}` : name;
  const item = batch.get(key) ?? { n: name, ...(props ? { p: props } : {}), c: 0 };
  item.c += n;
  batch.set(key, item);
  timer ??= setTimeout(flushTrack, delay);
}

let sentCrashes = 0;
export function reportError(surface: string, err: unknown, fatal = false) {
  if (off || sentCrashes >= 5) return;
  sentCrashes++;
  let crash: CrashReport;
  try {
    const base = chrome.runtime.getURL('');
    crash = buildCrash(surface, err instanceof Error ? err : String(err ?? 'unknown'), base, fatal);
  } catch {
    return;
  }
  send({ type: 'usage:crash', crash });
}

/**
 * Uncaught errors and unhandled rejections from our own bundles (`files`) only:
 * content scripts share `window` with the page, whose errors are none of ours.
 */
export function installErrorCapture(surface: string, files: string[]) {
  let base = '';
  try {
    base = chrome.runtime.getURL('');
  } catch {
    return;
  }
  addEventListener('error', (e) => {
    const err = e.error as Error | undefined;
    if (isOurs(e.filename, err?.stack, base, files)) reportError(surface, err ?? e.message, true);
  });
  addEventListener('unhandledrejection', (e) => {
    const r = e.reason as Error | undefined;
    if (r instanceof Error && isOurs(undefined, r.stack, base, files)) reportError(surface, r);
  });
  addEventListener('pagehide', flushTrack);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushTrack();
  });
}
