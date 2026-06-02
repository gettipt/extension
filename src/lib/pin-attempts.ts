import { getItem, setItem, removeItem } from './storage';
import {
  PIN_ATTEMPTS_KEY,
  PIN_LOCKOUT_THRESHOLDS,
  PIN_LOCKOUT_DURATIONS_MS,
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
