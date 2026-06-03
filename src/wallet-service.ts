/// <reference lib="dom" />

import { SparkWallet } from '@buildonspark/spark-sdk';
import { decryptText } from './crypto';
import { loadUnlockKey } from './lib/key-store';
import { log } from './lib/logger';
import { getStringField } from './lib/object-helpers';

interface WalletPayload {
  iv: string;
  ct: string;
}

const TERMINAL_FAILURE_STATUSES = new Set([
  'LIGHTNING_PAYMENT_FAILED',
  'PREIMAGE_PROVIDING_FAILED',
  'USER_TRANSFER_VALIDATION_FAILED',
]);

let cachedWallet: SparkWallet | null = null;
let walletInitPromise: Promise<SparkWallet> | null = null;

// Unified teardown for the SparkWallet SDK instance. Best-effort: we never
// want a dispose failure to surface to the user.
async function teardownWallet(wallet: SparkWallet | null): Promise<void> {
  if (!wallet) return;
  const w = wallet as unknown as { cleanupConnections?: () => Promise<void> | void };
  try {
    if (typeof w.cleanupConnections === 'function') {
      await Promise.resolve(w.cleanupConnections());
    }
  } catch { /* best-effort */ }
  try { wallet.removeAllListeners?.(); } catch { /* best-effort */ }
}

// Decrypt the wallet mnemonic using the AES-GCM key cached in IndexedDB
// (see lib/key-store.ts). Throws if the user has not unlocked since
// browser startup, since that's when we wipe the IDB key.
async function decryptMnemonicWithCachedKey(walletRaw: string): Promise<string> {
  const key = await loadUnlockKey();
  if (!key) {
    throw new Error('Wallet is locked. Open TIPT and unlock first.');
  }
  const walletPayload = JSON.parse(walletRaw) as WalletPayload;
  return decryptText(key, walletPayload.iv, walletPayload.ct);
}

async function initFromMnemonicInternal(mnemonic?: string): Promise<SparkWallet> {
  // Caller is expected to have torn down any previous instance.
  const result = await SparkWallet.initialize({
    ...(mnemonic ? { mnemonicOrSeed: mnemonic } : {}),
    options: { network: 'MAINNET' },
  });
  cachedWallet = result.wallet;
  subscribeWalletEvents(result.wallet);
  return result.wallet;
}

// Ensure the SDK is initialised from the encrypted blob, decrypting with the
// IndexedDB-cached unlock key. Idempotent: returns the cached wallet if it
// already exists. Used by the unified payment path when the offscreen
// document has been torn down between the popup unlock and the pay call.
export async function ensureWalletFromBlob(walletRaw: string): Promise<SparkWallet> {
  if (cachedWallet) return cachedWallet;

  if (!walletInitPromise) {
    walletInitPromise = (async () => {
      const mnemonic = await decryptMnemonicWithCachedKey(walletRaw);
      return initFromMnemonicInternal(mnemonic);
    })();
  }

  try {
    return await walletInitPromise;
  } finally {
    walletInitPromise = null;
  }
}

async function pollForPreimage(
  wallet: SparkWallet,
  requestId: string,
  maxWaitMs = 60_000,
): Promise<string> {
  const startedAt = Date.now();
  const deadline = startedAt + maxWaitMs;
  // Exponential backoff capped at 1 s (was 5 s — the 5 s ceiling could leave
  // the user waiting up to ~5 s of pure idle time between the moment the
  // preimage actually landed and the moment we next polled). The first poll
  // still fires at 250 ms because most real Lightning routes settle in
  // under ~500 ms; smaller intervals would hammer the SDK without payoff.
  let intervalMs = 250;
  const maxIntervalMs = 1_000;
  let polls = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    intervalMs = Math.min(intervalMs * 2, maxIntervalMs);
    polls += 1;

    const req = await (wallet as unknown as {
      getLightningSendRequest: (id: string) => Promise<Record<string, unknown> | null>;
    }).getLightningSendRequest(requestId);

    if (!req) {
      continue;
    }

    const preimage = getStringField(req, ['paymentPreimage', 'preimage', 'payment_preimage']);
    if (preimage) {
      log(`[TIPT-OFFSCREEN] preimage acquired after ${polls} polls in ${Date.now() - startedAt} ms`);
      return preimage;
    }

    const status = typeof req.status === 'string' ? req.status : '';
    if (TERMINAL_FAILURE_STATUSES.has(status)) {
      throw new Error(`Lightning payment failed with status: ${status}`);
    }
  }

  throw new Error('Timed out waiting for payment preimage.');
}

async function getWalletFeeEstimateRaw(invoice: string): Promise<number | null> {
  if (!cachedWallet) return null;
  const wallet = cachedWallet as unknown as {
    getLightningSendFeeEstimate: (p: { encodedInvoice: string }) => Promise<number>;
  };
  try {
    const fee = await wallet.getLightningSendFeeEstimate({ encodedInvoice: invoice });
    return typeof fee === 'number' && Number.isFinite(fee) ? fee : null;
  } catch {
    return null;
  }
}

export interface PayOptions {
  // Encrypted wallet blob — supplied so the offscreen can recover its SDK
  // instance if Chrome reclaimed the document since the last call.
  walletRaw?: string;
  // Pre-computed maximum fee from the caller. When omitted, we ask the SDK
  // for a fee estimate and apply the standard headroom multiplier.
  maxFeeSats?: number;
  // If true, the result is guaranteed to contain `preimage` — we poll the
  // Lightning send request until the SDK exposes one. Used by the 402 path.
  pollPreimage?: boolean;
}

export interface PayResult {
  txId?: string;
  preimage?: string;
}

// Single unified payment entry point used by both the popup (TIPT_PAY_INVOICE)
// and the background 402 flow (TIPT_OFFSCREEN_PAY_INVOICE). All recovery,
// fee estimation, and preimage handling is centralised here.
export async function payInvoice(invoice: string, options: PayOptions = {}): Promise<PayResult> {
  const tStart = Date.now();
  if (!cachedWallet) {
    if (!options.walletRaw) {
      throw new Error('Wallet not initialized and no encrypted blob provided to re-initialize.');
    }
    await ensureWalletFromBlob(options.walletRaw);
  }
  const tWalletReady = Date.now();

  const wallet = cachedWallet;
  if (!wallet) throw new Error('Wallet not initialized.');

  let maxFeeSats = options.maxFeeSats;
  if (maxFeeSats === undefined) {
    const estimated = await getWalletFeeEstimateRaw(invoice);
    maxFeeSats = estimated !== null ? Math.max(25, Math.ceil(estimated * 2)) : 50;
  }
  const tFeeReady = Date.now();

  const result = await wallet.payLightningInvoice({ invoice, maxFeeSats });
  const tPayReturned = Date.now();
  const r = result as unknown as Record<string, unknown>;
  const txId = typeof r.id === 'string' ? r.id
    : typeof r.transferSparkId === 'string' ? r.transferSparkId
    : undefined;
  let preimage = typeof r.paymentPreimage === 'string' ? r.paymentPreimage
    : typeof r.preimage === 'string' ? r.preimage
    : typeof r.payment_preimage === 'string' ? r.payment_preimage
    : undefined;

  if (options.pollPreimage && !preimage) {
    if (!txId) {
      throw new Error('Payment initiated but no request ID returned to poll for preimage.');
    }
    if (!cachedWallet) throw new Error('Wallet disposed before preimage was available.');
    preimage = await pollForPreimage(cachedWallet, txId);
  }
  const tDone = Date.now();

  log(
    `[TIPT-OFFSCREEN] payInvoice timing (ms): walletReady=${tWalletReady - tStart}`,
    `feeEstimate=${tFeeReady - tWalletReady}`,
    `payLightningInvoice=${tPayReturned - tFeeReady}`,
    `preimage=${tDone - tPayReturned}`,
    `total=${tDone - tStart}`,
  );

  return { txId, preimage };
}

// Initial wallet creation / recovery path. The popup decrypts the mnemonic
// locally (using the freshly-derived unlock key) and hands the plaintext
// mnemonic over so the SDK can initialise. The encrypted blob never crosses
// the IPC boundary on this path.
export async function initWalletFromMnemonic(
  mnemonic?: string,
): Promise<{ mnemonic: string; balanceSats: bigint }> {
  await teardownWallet(cachedWallet);
  cachedWallet = null;
  walletInitPromise = null;

  const wallet = await initFromMnemonicInternal(mnemonic);
  const returnedMnemonic = ((wallet as unknown) as { mnemonic?: string }).mnemonic ?? mnemonic ?? '';
  const bal = await wallet.getBalance();
  return { mnemonic: returnedMnemonic, balanceSats: bal.balance };
}

export async function disposeWallet(): Promise<void> {
  const walletToDispose = cachedWallet;
  cachedWallet = null;
  walletInitPromise = null;
  await teardownWallet(walletToDispose);
}

export type WalletEventName = 'transfer:claimed' | 'deposit:confirmed' | 'balance:update';
type WalletEventListener = (event: WalletEventName, balance: bigint) => void;
const walletEventListeners = new Set<WalletEventListener>();

export function registerWalletEventListener(fn: WalletEventListener): () => void {
  walletEventListeners.add(fn);
  return () => {
    walletEventListeners.delete(fn);
  };
}

function emitWalletEvent(event: WalletEventName, balance: bigint) {
  for (const listener of walletEventListeners) {
    try { listener(event, balance); } catch { /* ignore listener errors */ }
  }
}

function subscribeWalletEvents(wallet: SparkWallet) {
  wallet.on('transfer:claimed', (_id: string, balance: bigint) => emitWalletEvent('transfer:claimed', balance));
  wallet.on('deposit:confirmed', (_id: string, balance: bigint) => emitWalletEvent('deposit:confirmed', balance));
  // BalanceUpdate is the SDK's catch-all balance-changed event — it fires for
  // claims, swaps, deposits and outgoing transfers alike. Critically for the
  // restore flow, it fires for transfers the SDK's background claim loop
  // settles *during* SparkWallet.initialize(), which is exactly the window
  // where the popup hasn't yet rendered its first balance and the
  // transfer:claimed events were being missed. Subscribing to it here means
  // a restored wallet's balance now self-corrects within the same popup
  // session, instead of only after a popup close/reopen cycle.
  wallet.on('balance:update', (b: { available: bigint }) => {
    if (typeof b?.available === 'bigint') emitWalletEvent('balance:update', b.available);
  });
}

export async function getWalletBalance(): Promise<bigint> {
  if (!cachedWallet) throw new Error('Wallet not initialized.');
  const result = await cachedWallet.getBalance();
  return result.balance;
}

// Spark address (bech32m-encoded identity, e.g. sp1qq…). Stable for the
// lifetime of the wallet so callers may freely cache it. The SDK call is
// resolved entirely from the cached identity material — no Spark cluster
// round trip — so this is cheap to invoke from the popup settings menu.
export async function getSparkAddress(): Promise<string> {
  if (!cachedWallet) throw new Error('Wallet not initialized.');
  return cachedWallet.getSparkAddress();
}

export interface SparkTransferOptions {
  // Same cold-restart semantics as `PayOptions.walletRaw` — the background
  // hands the encrypted blob across the IPC boundary so the offscreen can
  // re-initialise the SDK if Chrome reclaimed the document since the last
  // call. The PIN never crosses the boundary; decryption happens locally
  // via the IndexedDB-cached AES-GCM key (see decryptMnemonicWithCachedKey).
  walletRaw?: string;
}

export interface SparkTransferResult {
  // Spark transfer id (WalletTransfer.id) — opaque to TIPT, useful only as
  // a receipt the page can quote back to the merchant. There is no
  // Lightning preimage on this path.
  txId: string;
}

// Spark-native transfer to a receiver Spark address. Mirrors `payInvoice`'s
// cold-restart pattern (ensureWalletFromBlob + timing logs) so the prewarm
// fastpath benefits both settlement types identically. We *do not* attempt
// to validate the address here — the SDK rejects malformed addresses with
// a structured error which we surface to the caller as-is.
export async function payToSparkAddress(
  receiverSparkAddress: string,
  amountSats: number,
  options: SparkTransferOptions = {},
): Promise<SparkTransferResult> {
  const tStart = Date.now();
  if (!Number.isFinite(amountSats) || amountSats <= 0 || !Number.isInteger(amountSats)) {
    throw new Error('Spark transfer requires a positive integer amountSats.');
  }
  if (!cachedWallet) {
    if (!options.walletRaw) {
      throw new Error('Wallet not initialized and no encrypted blob provided to re-initialize.');
    }
    await ensureWalletFromBlob(options.walletRaw);
  }
  const tWalletReady = Date.now();

  const wallet = cachedWallet;
  if (!wallet) throw new Error('Wallet not initialized.');

  const result = await wallet.transfer({ amountSats, receiverSparkAddress });
  const tTransferReturned = Date.now();

  const r = result as unknown as Record<string, unknown>;
  const txId = typeof r.id === 'string' ? r.id : '';
  if (!txId) {
    throw new Error('Spark transfer completed but no transfer id was returned.');
  }

  log(
    `[TIPT-OFFSCREEN] payToSparkAddress timing (ms): walletReady=${tWalletReady - tStart}`,
    `transfer=${tTransferReturned - tWalletReady}`,
    `total=${tTransferReturned - tStart}`,
  );

  return { txId };
}

// Recursive in-place walk that converts every `bigint` to its decimal
// string and clones objects/arrays. The Spark SDK occasionally surfaces
// bigint values (uint64 proto fields) that silently break
// `chrome.runtime.sendMessage` serialisation if forwarded as-is. The
// previous implementation used `JSON.parse(JSON.stringify(...,replacer))`
// which doubled the work and allocated twice the memory.
//
// Special cases that the generic `Object.entries` recursion would silently
// destroy:
//   - Date: enumerable own keys are empty, so we'd serialise to `{}` and
//     the renderer would render "Unknown date" for every transfer.
//   - Map / Set: same problem (no enumerable own keys).
//   - Uint8Array / ArrayBuffer: not JSON-serialisable; not currently emitted
//     by SDK transfer payloads, but we pass them through untouched so callers
//     that intentionally use them aren't corrupted.
function normaliseBigints(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of value.entries()) out[String(k)] = normaliseBigints(v);
    return out;
  }
  if (value instanceof Set) return Array.from(value, normaliseBigints);
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return value;
  if (Array.isArray(value)) return value.map(normaliseBigints);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normaliseBigints(v);
    }
    return out;
  }
  return value;
}

export async function getWalletTransfers(limit: number, offset: number): Promise<unknown[]> {
  if (!cachedWallet) throw new Error('Wallet not initialized.');
  const walletWithTransfers = cachedWallet as unknown as {
    getTransfers?: (limit: number, offset: number) => Promise<unknown>;
  };
  if (typeof walletWithTransfers.getTransfers !== 'function') return [];
  const response = await walletWithTransfers.getTransfers(limit, offset);
  const transfers =
    typeof response === 'object' && response !== null && 'transfers' in response
      ? (response as { transfers?: unknown }).transfers
      : response;
  if (!Array.isArray(transfers)) return [];
  const safe = normaliseBigints(transfers) as unknown[];
  return safe.filter((item) => typeof item === 'object' && item !== null);
}

export async function createWalletInvoice(amountSats: number): Promise<string> {
  if (!cachedWallet) throw new Error('Wallet not initialized.');
  const r = await cachedWallet.createLightningInvoice({ amountSats });
  return (r as unknown as { invoice: { encodedInvoice: string } }).invoice.encodedInvoice;
}

export async function getWalletFeeEstimate(encodedInvoice: string): Promise<number> {
  if (!cachedWallet) throw new Error('Wallet not initialized.');
  const wallet = cachedWallet as unknown as {
    getLightningSendFeeEstimate: (p: { encodedInvoice: string }) => Promise<number>;
  };
  const fee = await wallet.getLightningSendFeeEstimate({ encodedInvoice });
  if (typeof fee === 'number' && Number.isFinite(fee)) return fee;
  throw new Error('Could not determine fee estimate.');
}

// Synchronous-style introspection used by the popup to decide whether to
// show a loading spinner before requesting the first balance. Deliberately
// does NOT round-trip to the Spark cluster — the previous implementation
// called getBalance() and made every popup open slow.
export function hasCachedWallet(): boolean {
  return cachedWallet !== null;
}
