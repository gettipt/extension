export const PIN_KEY = 'spark_pin';
export const WALLET_KEY = 'spark_wallet';
// SECURITY NOTE: The PIN is held plaintext in chrome.storage.session so that
// the background service worker can decrypt the wallet on 402 challenges
// without user interaction. Improving this requires a UX change (e.g. an
// explicit "allow background payments" opt-in). Tracked separately.
export const SESSION_PIN_KEY = 'spark_session_pin';
export const SENTINEL = 'spark_wallet_v1';
export const PIN_LENGTH = 5;
export const TRANSFERS_CACHE_KEY = 'spark_transfers_cache';

export const PIN_ATTEMPTS_KEY = 'spark_pin_attempts';
export const PIN_LOCKOUT_THRESHOLDS = [5, 10, 15];
export const PIN_LOCKOUT_DURATIONS_MS = [30_000, 5 * 60_000, 60 * 60_000];

export interface PinAttemptsState {
  count: number;
  lockedUntil: number;
}
