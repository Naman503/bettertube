// MAIN-world helper for the speed controller (every site, every frame).
// The controller finds media through their events at the document. Two kinds
// never reach it: media played without ever being put on the page
// (`new Audio(url).play()`, common in podcast and music players), and media
// inside a web component's shadow DOM (their events don't cross the shadow
// boundary). Seeing every play() call fixes both:
//  - off-page audio is parked in a hidden <bt-media-holder>, so its events
//    reach the document like any other (never video: a player may play a
//    video before attaching it, and moving it would leave a black screen);
//  - shadow-DOM media announce themselves with a composed "bt-media" event.
const proto = HTMLMediaElement.prototype;
const originalPlay = proto.play;
let holder: HTMLElement | null = null;

proto.play = function (this: HTMLMediaElement, ...args: []) {
  try {
    if (!this.isConnected && this instanceof HTMLAudioElement) {
      if (!holder) {
        holder = document.createElement('bt-media-holder');
        holder.hidden = true;
        holder.setAttribute('aria-hidden', 'true');
      }
      if (!holder.isConnected) (document.documentElement ?? document.body)?.append(holder);
      holder.append(this);
    } else if (this.getRootNode() instanceof ShadowRoot) {
      this.dispatchEvent(new CustomEvent('bt-media', { bubbles: true, composed: true }));
    }
  } catch {
    // never break the page's own playback
  }
  return originalPlay.apply(this, args);
};
