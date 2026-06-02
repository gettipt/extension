// Cross-extension helpers for fishing well-typed values out of loose
// objects (Spark SDK results, page-supplied payloads, untrusted JSON).
// Centralised so we don't keep re-inventing the same `typeof` dance.

export function getStringField(
  source: unknown,
  keys: readonly string[],
): string | null {
  if (!source || typeof source !== 'object') return null;
  const obj = source as Record<string, unknown>;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

// Tiny convenience for "is this a non-empty string?" — returns the value
// itself or null. Used at every untrusted-input boundary where we want a
// string-or-fail-closed rather than `typeof v === 'string'` scattered around.
export function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
