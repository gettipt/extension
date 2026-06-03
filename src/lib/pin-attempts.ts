import { getItem, setItem, removeItem, getSynced } from './storage';
import { deriveKey, decryptText, hexToBuf, PBKDF2_ITERATIONS_LEGACY } from '../crypto';
import {
  PIN_ATTEMPTS_KEY,
  PIN_KEY,
  PIN_LOCKOUT_THRESHOLDS,
  PIN_LOCKOUT_DURATIONS_MS,
  PIN_LENGTH,
  SENTINEL,
  type PinAttemptsState,
} from '../constants';

export async function getPinAttempts(): Promise<PinAttemptsState> {
  const raw = await getItem('local', PIN_ATTEMPTS_KEY);
  if (!raw) return { count: 0, lockedUntil: 0 };
  try { return JSON.parse(raw) as PinAttemptsState; } catch { return { count: 0, lockedUntil: 0 }; }
}

export async function setPinAttempts(state: PinAttemptsState): Promise<void> {
  await setItem('local', PIN_ATTEMPTS_KEY, JSON.stringify(state));
}

export async function clearPinAttempts(): Promise<void> {
  await removeItem('local', PIN_ATTEMPTS_KEY);
}

export function getLockoutForAttempts(count: number): number {
  if (count < PIN_LOCKOUT_THRESHOLDS[0]) return 0;
  let duration = 0;
  for (let i = 0; i < PIN_LOCKOUT_THRESHOLDS.length; i++) {
    if (count >= PIN_LOCKOUT_THRESHOLDS[i]) duration = PIN_LOCKOUT_DURATIONS_MS[i];
  }
  return duration;
}

export type VerifyPinResult =
  | { ok: true; key: CryptoKey; iterations: number }
  | { ok: false; reason: 'locked'; lockedUntil: number }
  | { ok: false; reason: 'no-data' }
  | { ok: false; reason: 'wrong-pin' }
  | { ok: false; reason: 'too-short' };

// Single source of truth for "verify the user knows the PIN". Both the
// initial unlock screen and the in-app re-prompt modal use this. Encapsulates
// the lockout check, salt + iterations lookup, key derivation, SENTINEL
// decryption, and attempt-counter book-keeping — all of which were
// duplicated in App.handlePinUnlock and the old inline/action PIN flows
// before this extraction, and which had drifted out of sync (the action
// flow didn't update
// the lockout counter on a wrong-PIN salt/verifier shape mismatch).
export async function verifyPin(pin: string): Promise<VerifyPinResult> {
  if (pin.length < PIN_LENGTH) return { ok: false, reason: 'too-short' };
  const attempts = await getPinAttempts();
  const now = Date.now();
  if (attempts.lockedUntil > now) {
    return { ok: false, reason: 'locked', lockedUntil: attempts.lockedUntil };
  }
  const pinRaw = await getSynced(PIN_KEY);
  if (!pinRaw) return { ok: false, reason: 'no-data' };
  let parsed: { salt?: unknown; verifier?: { iv?: unknown; ct?: unknown }; iterations?: unknown };
  try {
    parsed = JSON.parse(pinRaw);
  } catch {
    return { ok: false, reason: 'no-data' };
  }
  const salt = typeof parsed.salt === 'string' ? parsed.salt : null;
  const iv = parsed.verifier && typeof parsed.verifier.iv === 'string' ? parsed.verifier.iv : null;
  const ct = parsed.verifier && typeof parsed.verifier.ct === 'string' ? parsed.verifier.ct : null;
  if (!salt || !iv || !ct) return { ok: false, reason: 'no-data' };
  const iterations = typeof parsed.iterations === 'number' && Number.isFinite(parsed.iterations)
    ? parsed.iterations
    : PBKDF2_ITERATIONS_LEGACY;
  const key = await deriveKey(pin, hexToBuf(salt), iterations);
  let plain: string;
  try {
    plain = await decryptText(key, iv, ct);
  } catch {
    await bumpAttempts(attempts.count, now);
    return { ok: false, reason: 'wrong-pin' };
  }
  if (plain !== SENTINEL) {
    await bumpAttempts(attempts.count, now);
    return { ok: false, reason: 'wrong-pin' };
  }
  await clearPinAttempts();
  return { ok: true, key, iterations };
}

async function bumpAttempts(currentCount: number, now: number): Promise<void> {
  const newCount = currentCount + 1;
  const lockoutMs = getLockoutForAttempts(newCount);
  await setPinAttempts({ count: newCount, lockedUntil: lockoutMs ? now + lockoutMs : 0 });
}

