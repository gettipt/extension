// Shared protocol surface between background.ts (the producer) and
// ConfirmApp.tsx (the consumer) for per-request 402 confirm popups. Both
// sides need to agree on the chrome.storage.session prefix used to persist
// confirm details and the shape of those details — keeping both in one
// module guarantees they can't drift.

export const PENDING_CONFIRM_PREFIX = 'tipt_pending_confirm_';

export function pendingConfirmStorageKey(id: string): string {
  return `${PENDING_CONFIRM_PREFIX}${id}`;
}

// Details mirrored to chrome.storage.session so the confirm popup can
// rehydrate even if the service worker has been recycled since the
// request was opened.
export interface PersistedConfirmDetails {
  host: string;
  url: string;
  method: string;
  invoice: string;
  amountSats: number | null;
  expiresAt: number;
}
