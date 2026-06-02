/// <reference types="chrome" />

// Single source of truth for creating/ensuring the offscreen document.
// Used by both the popup (via wallet-client) and the background service
// worker. The previous duplicate implementations diverged on small details
// (string vs enum for `reasons`, idempotency tracking).

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const OFFSCREEN_JUSTIFICATION =
  'Process Spark SDK wallet operations outside the service worker runtime.';

let ensurePromise: Promise<void> | null = null;
let ensured = false;

function reasons(): chrome.offscreen.Reason[] {
  // Some Chrome versions only ship the enum object in extension page contexts.
  // Fall back to the documented string value if the enum is missing.
  const reason =
    (chrome.offscreen as { Reason?: { LOCAL_STORAGE?: chrome.offscreen.Reason } }).Reason
      ?.LOCAL_STORAGE ?? ('LOCAL_STORAGE' as chrome.offscreen.Reason);
  return [reason];
}

export async function ensureOffscreen(): Promise<void> {
  if (ensured) return;
  if (!ensurePromise) {
    ensurePromise = (async () => {
      if (!chrome.offscreen?.createDocument) return;
      if (chrome.offscreen.hasDocument) {
        const exists = await chrome.offscreen.hasDocument();
        if (exists) {
          ensured = true;
          return;
        }
      }
      try {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_DOCUMENT_PATH,
          reasons: reasons(),
          justification: OFFSCREEN_JUSTIFICATION,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Another concurrent call may have created the document first; that's
        // not a real failure — verify and continue if so.
        if (!message.includes('Only a single offscreen document may be created')) throw error;
      }
      ensured = true;
    })().finally(() => {
      ensurePromise = null;
    });
  }
  await ensurePromise;
}
