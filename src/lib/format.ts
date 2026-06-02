export function formatSats(value: bigint | number | null): string {
  if (value === null || value === undefined) return '--';
  const v = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  return v.toLocaleString('en-US');
}

export function formatUsd(value: number | null): string {
  if (value === null) return '--';
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
