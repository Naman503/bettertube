// MAIN-world entry. Runs at document_start, before any YouTube script.
import { onMainMessage, sendToIsolated } from '../shared/bridge';
import { readMirror, resolveCodecMode } from '../shared/settings';
import { installCodecFilter } from './codecs';
import { installFlagOverrides } from './flags';
import { collectRecon, installPlayerBridge } from './player';

// chrome.storage is async and unavailable here, so start from the copy the
// isolated script mirrored into localStorage on the previous page load.
let settings = readMirror();
const getSettings = () => settings;

installCodecFilter(() => resolveCodecMode(settings));
installFlagOverrides(getSettings);
installPlayerBridge(getSettings);

// "Video paused. Continue watching?" fires when YouTube thinks you've been idle;
// _lact is its last-activity timestamp.
setInterval(() => {
  if (settings.autoContinue) (window as any)._lact = Date.now();
}, 60_000);

onMainMessage((msg) => {
  if (msg.type === 'settings') settings = msg.settings;
  else if (msg.type === 'recon') {
    sendToIsolated({ type: 'recon-result', id: msg.id, data: collectRecon(getSettings) });
  }
});
