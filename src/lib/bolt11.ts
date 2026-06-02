// Minimal BOLT11 amount decoder. The full SDK can't run in the MV3 service
// worker (no WASM), so we extract the amount directly from the bolt11
// human-readable part:
//
//   ln<network><amount><multiplier>1<bech32 data>
//
// where `<amount>` is decimal digits and `<multiplier>` is one of
// m/u/n/p (milli/micro/nano/pico BTC). Returns sats rounded up so callers
// can safely use the value as an upper-bound for spend-cap enforcement.
// Returns null when the invoice has no amount field (payer-chooses) or the
// format is unrecognised — callers should treat null as "amount unknown" and
// fall back to a user prompt instead of auto-approving.

// Amount group rejects leading zeros (`lnbc0001m1...`) — only `0` or a
// non-zero-leading decimal is canonical per BOLT11. Non-canonical encodings
// shouldn't appear in real invoices; failing closed avoids edge cases where
// downstream callers treat `parseInt('00010', 10) === 10` as a valid amount.
// Amount group is mandatory: amount-less invoices (`lnbc1...`) intentionally
// fall through to `null` ("amount unknown") — the same behaviour as before.
const HRP_RE = /^ln(?:bc|tb|tbs|bcrt)(0|[1-9]\d*)([munp])?1/i;

// BOLT11 invoices are bounded by the on-wire bech32 limit (~7000 chars).
// Cap a bit higher to absorb whitespace / lightning: prefix without
// rejecting legitimate invoices, but reject obviously hostile inputs
// before the regex engine sees them.
const MAX_INVOICE_LENGTH = 8192;
// 19 digits keeps us safely under Number.MAX_SAFE_INTEGER even at the
// unit-less (per-BTC) multiplier. Larger inputs are almost certainly
// adversarial — fail closed instead of overflowing through the math
// path below.
const MAX_AMOUNT_DIGITS = 19;

export function decodeBolt11AmountSats(invoice: string): number | null {
  if (typeof invoice !== 'string' || invoice.length === 0) return null;
  if (invoice.length > MAX_INVOICE_LENGTH) return null;
  const match = HRP_RE.exec(invoice);
  if (!match) return null;
  if (match[1].length > MAX_AMOUNT_DIGITS) return null;
  const amount = parseInt(match[1], 10);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const multiplier = match[2]?.toLowerCase();

  // Work in pico-BTC units (the smallest BOLT11 unit) so all branches are
  // integer math; convert to sats at the end with ceiling rounding.
  //   1 BTC      = 1e12 pico-BTC = 1e8 sats
  //   1 milli    = 1e9 pico-BTC  = 1e5 sats
  //   1 micro    = 1e6 pico-BTC  = 1e2 sats
  //   1 nano     = 1e3 pico-BTC  = 1e-1 sats
  //   1 pico     = 1 pico-BTC    = 1e-4 sats
  // sats = pico / 10000
  let pico: number;
  switch (multiplier) {
    case 'm': pico = amount * 1_000_000_000; break;
    case 'u': pico = amount * 1_000_000; break;
    case 'n': pico = amount * 1_000; break;
    case 'p': pico = amount; break;
    case undefined: pico = amount * 1_000_000_000_000; break;
    default: return null;
  }

  if (!Number.isFinite(pico) || pico <= 0) return null;
  return Math.ceil(pico / 10_000);
}
