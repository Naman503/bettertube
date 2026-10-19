// Incognito: BetterTube works as usual but records nothing permanently.
// Speeds and pause states live in chrome.storage.session under the
// "incognito:" prefix (memory only, never written to disk); the background
// wipes them when the last incognito tab closes. Stats and layout snapshots
// are not recorded at all.

export const INCOGNITO_PREFIX = 'incognito:';
/** Unpacked builds only: lets tests simulate incognito (real incognito needs a manual toggle). */
export const SIMULATE_INCOGNITO_KEY = 'dev:simulateIncognito';

const isUnpacked = () => !('update_url' in chrome.runtime.getManifest());

export async function isIncognito(): Promise<boolean> {
  try {
    if (chrome.extension?.inIncognitoContext) return true;
    if (!isUnpacked()) return false;
    return (await chrome.storage.local.get(SIMULATE_INCOGNITO_KEY))[SIMULATE_INCOGNITO_KEY] === true;
  } catch {
    return false;
  }
}
