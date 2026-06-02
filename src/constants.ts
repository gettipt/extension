export const PIN_KEY = 'spark_pin';
export const WALLET_KEY = 'spark_wallet';

// SECURITY: We no longer persist the plaintext PIN anywhere. The
// PIN-derived non-extractable AES-GCM CryptoKey is cached in shared
// IndexedDB via src/lib/key-store.ts; that key is the only thing the
// offscreen/background contexts need to decrypt the wallet. The constant
// below is retained ONLY so the popup and background can clean up the
// legacy `spark_session_pin` entry on installs that pre-date the change.
export const LEGACY_SESSION_PIN_KEY = 'spark_session_pin';

export const SENTINEL = 'spark_wallet_v1';
export const PIN_LENGTH = 5;
export const TRANSFERS_CACHE_KEY = 'spark_transfers_cache';
export const BTC_USD_RATE_CACHE_KEY = 'spark_btc_usd_rate';

export const PIN_ATTEMPTS_KEY = 'spark_pin_attempts';
export const PIN_LOCKOUT_THRESHOLDS = [5, 10, 15];
export const PIN_LOCKOUT_DURATIONS_MS = [30_000, 5 * 60_000, 60 * 60_000];

export interface PinAttemptsState {
  count: number;
  lockedUntil: number;
}
