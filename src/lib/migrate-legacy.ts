/// <reference types="chrome" />

import { LEGACY_SESSION_PIN_KEY } from '../constants';

// Best-effort scrub of pre-S7 plaintext-PIN entries from chrome.storage.session.
// Called from background.onStartup (browser restart) and from the popup
// bootstrap (in-session upgrade where the user has the extension open while
// updating). Centralising the call site means we only ever have to touch
// one place if we add another legacy key — and it documents the invariant
// that this is best-effort (a failure here MUST NOT block the unlock flow).
export function scrubLegacyState(): void {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.session) return;
    void chrome.storage.session.remove(LEGACY_SESSION_PIN_KEY).catch(() => { /* ignore */ });
  } catch { /* ignore */ }
}
