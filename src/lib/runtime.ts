/// <reference types="chrome" />

// Shared helper used by every onMessage listener in the extension. Returns
// true only for messages whose sender is our own extension context. The
// runtime never delivers external messages unless `externally_connectable`
// is configured (we don't), but enforcing the invariant explicitly hardens
// the contract against config drift.
export function isInternalSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id;
}
