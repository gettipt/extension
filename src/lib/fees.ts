const FEE_BPS_NUMER = 17;
const FEE_BPS_DENOM = 10_000;
const MIN_FEE_SATS = 25;

export function getMaxFeeSats(amountSats: number): number {
  return Math.max(MIN_FEE_SATS, Math.ceil((amountSats * FEE_BPS_NUMER) / FEE_BPS_DENOM));
}

// Largest amount `a` such that a + getMaxFeeSats(a) <= balance.
// Solved algebraically; falls back to a tiny correction loop only at the boundary.
export function getMaxSpendableSats(balanceSats: number): number {
  if (balanceSats <= MIN_FEE_SATS) return 0;

  // Algebraic estimate: a + ceil(a * 17/10000) <= balance
  // Use floor((balance - MIN_FEE_SATS) * 10000 / 10017) as initial guess.
  let candidate = Math.floor(((balanceSats - MIN_FEE_SATS) * FEE_BPS_DENOM) / (FEE_BPS_DENOM + FEE_BPS_NUMER));
  candidate = Math.min(candidate, balanceSats - MIN_FEE_SATS);
  if (candidate < 0) return 0;

  // Tiny correction (rarely needed because ceil/min interact at the boundary).
  while (candidate > 0 && candidate + getMaxFeeSats(candidate) > balanceSats) candidate -= 1;
  // Try expanding once in case algebra under-estimated due to MIN_FEE clamp.
  while (candidate + 1 + getMaxFeeSats(candidate + 1) <= balanceSats) candidate += 1;
  return candidate;
}
