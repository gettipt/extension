export type WalletTransfer = Record<string, unknown>;

export function getTransferString(transfer: WalletTransfer, keys: string[]): string | null {
  for (const key of keys) {
    const value = transfer[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

export function getTransferAmountSatsLabel(transfer: WalletTransfer): string {
  const nestedAmount = (typeof transfer.totalAmount === 'object' && transfer.totalAmount !== null)
    ? (transfer.totalAmount as { originalValue?: unknown; value?: unknown }).originalValue
      ?? (transfer.totalAmount as { originalValue?: unknown; value?: unknown }).value
    : undefined;

  const rawAmount = transfer.totalValue
    ?? transfer.amountSats
    ?? transfer.amountSat
    ?? transfer.amount
    ?? transfer.totalAmountSats
    ?? transfer.total_amount_sats
    ?? transfer.value
    ?? transfer.creditAmountSats
    ?? transfer.debitAmountSats
    ?? nestedAmount;

  if (typeof rawAmount === 'bigint') return `\u20bf${rawAmount.toLocaleString('en-US')}`;
  if (typeof rawAmount === 'number' && Number.isFinite(rawAmount)) return `\u20bf${Math.trunc(rawAmount).toLocaleString('en-US')}`;
  if (typeof rawAmount === 'string' && /^-?\d+$/.test(rawAmount)) {
    const num = Number(rawAmount);
    return `\u20bf${num.toLocaleString('en-US')}`;
  }
  return '₿ --';
}

export function getTransferDate(transfer: WalletTransfer): Date | null {
  const rawDate = transfer.createdTime
    ?? transfer.createdAt
    ?? transfer.timestamp
    ?? transfer.created_at
    ?? transfer.updatedAt
    ?? transfer.updated_at;

  let date: Date | null = null;

  if (rawDate instanceof Date) {
    date = rawDate;
  } else if (typeof rawDate === 'number') {
    const ts = rawDate < 1_000_000_000_000 ? rawDate * 1000 : rawDate;
    date = new Date(ts);
  } else if (typeof rawDate === 'string') {
    if (/^\d+$/.test(rawDate)) {
      const asNumber = Number(rawDate);
      const ts = asNumber < 1_000_000_000_000 ? asNumber * 1000 : asNumber;
      date = new Date(ts);
    } else {
      date = new Date(rawDate);
    }
  } else if (typeof rawDate === 'object' && rawDate !== null) {
    const timestampLike = rawDate as { seconds?: number | string; nanos?: number };
    if (timestampLike.seconds !== undefined) {
      const seconds = typeof timestampLike.seconds === 'string'
        ? Number(timestampLike.seconds)
        : timestampLike.seconds;
      if (Number.isFinite(seconds)) {
        const nanos = Number.isFinite(timestampLike.nanos) ? timestampLike.nanos! : 0;
        date = new Date((seconds * 1000) + Math.floor(nanos / 1_000_000));
      }
    }
  }

  return date && !Number.isNaN(date.getTime()) ? date : null;
}

export function getTransferDayLabel(transfer: WalletTransfer): string {
  const date = getTransferDate(transfer);
  if (!date) return 'Unknown date';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function getTransferTimeLabel(transfer: WalletTransfer): string {
  const date = getTransferDate(transfer);
  if (!date) return '';
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function groupTransfersByDay(transfers: WalletTransfer[]): { day: string; transfers: WalletTransfer[] }[] {
  const groups: { day: string; transfers: WalletTransfer[] }[] = [];
  for (const t of transfers) {
    const day = getTransferDayLabel(t);
    const last = groups[groups.length - 1];
    if (last && last.day === day) {
      last.transfers.push(t);
    } else {
      groups.push({ day, transfers: [t] });
    }
  }
  return groups;
}
