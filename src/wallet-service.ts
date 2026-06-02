/// <reference lib="dom" />

import { SparkWallet } from '@buildonspark/spark-sdk';
import { decryptText } from './crypto';
import { loadUnlockKey } from './lib/key-store';

interface WalletPayload {
  iv: string;
  ct: string;
}

function getResultString(result: unknown, keys: string[]): string | null {
  if (!result || typeof result !== 'object') {
    return null;
  }

  const data = result as Record<string, unknown>;
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return null;
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
  } catch (error) {
    walletInitPromise = null;
    throw error;
  } finally {
    if (cachedWallet) walletInitPromise = null;
  }
}

async function pollForPreimage(
  wallet: SparkWallet,
  requestId: string,
  maxWaitMs = 60_000,
  intervalMs = 750,
): Promise<string> {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));

    const req = await (wallet as unknown as {
      getLightningSendRequest: (id: string) => Promise<Record<string, unknown> | null>;
    }).getLightningSendRequest(requestId);

    if (!req) {
      continue;
    }

    const preimage = getResultString(req, ['paymentPreimage', 'preimage', 'payment_preimage']);
    if (preimage) {
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
  if (!cachedWallet) {
    if (!options.walletRaw) {
      throw new Error('Wallet not initialized and no encrypted blob provided to re-initialize.');
    }
    await ensureWalletFromBlob(options.walletRaw);
  }

  const wallet = cachedWallet;
  if (!wallet) throw new Error('Wallet not initialized.');

  let maxFeeSats = options.maxFeeSats;
  if (maxFeeSats === undefined) {
    const estimated = await getWalletFeeEstimateRaw(invoice);
    maxFeeSats = estimated !== null ? Math.max(25, Math.ceil(estimated * 2)) : 50;
  }

  const result = await wallet.payLightningInvoice({ invoice, maxFeeSats });
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

type WalletEventListener = (event: 'transfer:claimed' | 'deposit:confirmed', balance: bigint) => void;
const walletEventListeners = new Set<WalletEventListener>();

export function registerWalletEventListener(fn: WalletEventListener): () => void {
  walletEventListeners.add(fn);
  return () => {
    walletEventListeners.delete(fn);
  };
}

function emitWalletEvent(event: 'transfer:claimed' | 'deposit:confirmed', balance: bigint) {
  for (const listener of walletEventListeners) {
    try { listener(event, balance); } catch { /* ignore listener errors */ }
  }
}

function subscribeWalletEvents(wallet: SparkWallet) {
  wallet.on('transfer:claimed', (_id: string, balance: bigint) => emitWalletEvent('transfer:claimed', balance));
  wallet.on('deposit:confirmed', (_id: string, balance: bigint) => emitWalletEvent('deposit:confirmed', balance));
}

export async function getWalletBalance(): Promise<bigint> {
  if (!cachedWallet) throw new Error('Wallet not initialized.');
  const result = await cachedWallet.getBalance();
  return result.balance;
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
  // Normalize through JSON so the result is safely transported via
  // chrome.runtime.sendMessage. The Spark SDK's getTransfers occasionally
  // returns objects whose values contain bigints (uint64 fields from the
  // underlying proto), which silently break message serialization and would
  // otherwise make transactions never appear in the popup.
  const safe = JSON.parse(JSON.stringify(transfers, (_key, value) => {
    if (typeof value === 'bigint') return value.toString();
    return value;
  })) as unknown[];
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
