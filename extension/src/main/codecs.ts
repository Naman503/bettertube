// Hides codecs from YouTube's format selection (the h264ify technique). Must run
// at document_start, before the player asks what the browser can decode.
type Mode = 'off' | 'no-av1' | 'h264';

function isBlocked(mode: Mode, type: unknown): boolean {
  if (mode === 'off' || typeof type !== 'string') return false;
  const t = type.toLowerCase();
  if (t.includes('av01')) return true;
  if (mode === 'h264' && (/vp0?9|vp8/.test(t) || t.startsWith('video/webm'))) return true;
  return false;
}

export function installCodecFilter(getMode: () => Mode) {
  const ms = window.MediaSource;
  if (ms?.isTypeSupported) {
    const orig = ms.isTypeSupported.bind(ms);
    ms.isTypeSupported = (type: string) => !isBlocked(getMode(), type) && orig(type);
  }

  const proto = HTMLMediaElement.prototype;
  const origCanPlay = proto.canPlayType;
  proto.canPlayType = function (type: string) {
    return isBlocked(getMode(), type) ? '' : origCanPlay.call(this, type);
  };

  const mc = navigator.mediaCapabilities;
  if (mc?.decodingInfo) {
    const origInfo = mc.decodingInfo.bind(mc);
    mc.decodingInfo = (config: MediaDecodingConfiguration) => {
      if (isBlocked(getMode(), config?.video?.contentType)) {
        return Promise.resolve({
          supported: false,
          smooth: false,
          powerEfficient: false,
          keySystemAccess: null,
          configuration: config,
        } as unknown as MediaCapabilitiesDecodingInfo);
      }
      return origInfo(config);
    };
  }
}
