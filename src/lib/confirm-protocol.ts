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
  // For Lightning payments this is the BOLT11 invoice; for Spark transfers
  // it's the receiver Spark address. Kept as a single field so the existing
  // chrome.storage.session record shape stays stable — the popup decides
  // how to display it based on `paymentKind`.
  invoice: string;
  amountSats: number | null;
  expiresAt: number;
  // Discriminates the payment branch the background picked from
  // classifyPaymentTarget(). Older confirm entries written before this
  // field was added would deserialise as `undefined` — the popup treats
  // that as 'lightning' for back-compat with any in-flight prompts that
  // straddle the extension update.
  paymentKind?: 'lightning' | 'spark';
}
