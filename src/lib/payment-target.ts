// Classifies a string supplied via `mpp:payRequest.detail.invoice` (or the
// popup's Send field) as either a BOLT11 Lightning invoice or a Spark
// address. Used to route the payment to the right SDK call:
//
//   * lightning → wallet.payLightningInvoice(invoice)
//   * spark     → wallet.transfer({ receiverSparkAddress, amountSats })
//
// The two prefix families are disjoint — Lightning HRPs always start with
// "ln" and Spark addresses always start with "sp" — so a prefix-only check
// is sufficient and never ambiguous. Anything else returns 'unknown' so
// the caller can fail closed.
//
// Spark address prefixes are taken from the SDK constants:
//   AddressNetwork       = { MAINNET: 'spark',   TESTNET: 'sparkt',  REGTEST: 'sparkrt', SIGNET: 'sparks', LOCAL: 'sparkl' }
//   LegacyAddressNetwork = { MAINNET: 'sp',      TESTNET: 'spt',     REGTEST: 'sprt',    SIGNET: 'sps',    LOCAL: 'spl'    }
// — see node_modules/@buildonspark/spark-sdk/.../address.cjs. All variants
// follow `<prefix>1<bech32m-data>`. Spark invoices (issued via
// `createSatsInvoice`) share the same address format and prefix family.
//
// BOLT11 HRPs:
//   lnbc (mainnet), lntb (testnet), lntbs (signet), lnbcrt (regtest)
// All BOLT11 invoices match /^ln(bc|tb|tbs|bcrt)/i — pre-filter so we
// don't accidentally classify a malformed input that just happens to
// start with "ln" as Lightning. (`getBolt11AmountSats` in lib/bolt11.ts
// will independently reject anything that isn't a real invoice.)

export type PaymentKind = 'lightning' | 'spark' | 'unknown';

// SDK bech32m limit is 1024 chars for Spark addresses; BOLT11 invoices
// can be a few KB. The shared cap at the page boundary is 8192 chars
// (see content.ts / background.ts MAX_INVOICE_LEN). Anything longer
// than 8192 chars was already rejected upstream — this is defense in
// depth so a future caller can't sneak megabytes past us.
const MAX_TARGET_LEN = 8192;

const SPARK_PREFIXES = [
  'spark1', 'sparkt1', 'sparkrt1', 'sparks1', 'sparkl1',
  'sp1', 'spt1', 'sprt1', 'sps1', 'spl1',
];

const BOLT11_PREFIX_RE = /^ln(bc|tb|tbs|bcrt)/i;

export function classifyPaymentTarget(value: string): PaymentKind {
  if (typeof value !== 'string') return 'unknown';
  if (value.length === 0 || value.length > MAX_TARGET_LEN) return 'unknown';
  const lower = value.toLowerCase();
  if (BOLT11_PREFIX_RE.test(lower)) return 'lightning';
  for (const prefix of SPARK_PREFIXES) {
    // Match `${prefix}1…` exactly — the trailing `1` is the bech32
    // separator. Without it, "sps1abc…" would also match "sp1" and we'd
    // mis-route a signet address to mainnet semantics. Each prefix in the
    // list already includes its `1` separator, so a straight startsWith
    // check is precise.
    if (lower.startsWith(prefix) && lower.length > prefix.length) return 'spark';
  }
  return 'unknown';
}

// Human-readable label for the confirm popup. Kept here so the prefix list
// and the label stay together — adding a new network only touches one file.
export function paymentKindLabel(kind: PaymentKind): string {
  switch (kind) {
    case 'lightning': return 'Lightning';
    case 'spark': return 'Spark';
    default: return 'Unknown';
  }
}
