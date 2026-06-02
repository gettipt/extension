import { SparkWallet } from '@buildonspark/spark-sdk'
import { decryptText, deriveKey, hexToBuf, PBKDF2_ITERATIONS_LEGACY } from './crypto'

const SENTINEL = 'spark_wallet_v1';

interface PinPayload {
  salt: string;
  iterations?: number;
  verifier: { iv: string; ct: string };
}

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

async function disposeWallet(wallet: SparkWallet | null) {
  if (!wallet) return;
  const w = wallet as unknown as { cleanupConnections?: () => Promise<void> | void };
  try {
    if (typeof w.cleanupConnections === 'function') {
      await Promise.resolve(w.cleanupConnections());
    }
  } catch { /* best-effort */ }
  try { wallet.removeAllListeners?.(); } catch { /* best-effort */ }
}

async function decryptMnemonicFromCredentials(sessionPin: string, pinRaw: string, walletRaw: string): Promise<string> {
  const pinPayload = JSON.parse(pinRaw) as PinPayload;
  const walletPayload = JSON.parse(walletRaw) as WalletPayload;
  const iterations = typeof pinPayload.iterations === 'number' && Number.isFinite(pinPayload.iterations)
    ? pinPayload.iterations
    : PBKDF2_ITERATIONS_LEGACY;
  const key = await deriveKey(sessionPin, hexToBuf(pinPayload.salt), iterations);
  const verifier = await decryptText(key, pinPayload.verifier.iv, pinPayload.verifier.ct);
  if (verifier !== SENTINEL) {
    throw new Error('Session PIN is invalid. Unlock TIPT again.');
  }
  return decryptText(key, walletPayload.iv, walletPayload.ct);
}

const TERMINAL_FAILURE_STATUSES = new Set([
  'LIGHTNING_PAYMENT_FAILED',
  'PREIMAGE_PROVIDING_FAILED',
  'USER_TRANSFER_VALIDATION_FAILED',
]);

let cachedWallet: SparkWallet | null = null;
let walletInitPromise: Promise<SparkWallet> | null = null;

async function getOrCreateWallet(sessionPin: string, pinRaw: string, walletRaw: string): Promise<SparkWallet> {
  if (cachedWallet) {
    return cachedWallet;
  }

  if (!walletInitPromise) {
    walletInitPromise = (async () => {
      const mnemonic = await decryptMnemonicFromCredentials(sessionPin, pinRaw, walletRaw);
      const initialized = await SparkWallet.initialize({ mnemonicOrSeed: mnemonic, options: { network: 'MAINNET' } });
      cachedWallet = initialized.wallet;
      subscribeWalletEvents(initialized.wallet);
      return initialized.wallet;
    })();
  }

  try {
    return await walletInitPromise;
  } catch (error) {
    walletInitPromise = null;
    throw error;
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

export async function ensureWalletForSession(sessionPin: string, pinRaw: string, walletRaw: string): Promise<SparkWallet> {
  return getOrCreateWallet(sessionPin, pinRaw, walletRaw);
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

export async function payInvoiceFromSession(
  invoice: string,
  sessionPin: string,
  pinRaw: string,
  walletRaw: string,
): Promise<{ preimage: string }> {
  // Ensure wallet is initialized (decrypt mnemonic + connect SDK if not cached).
  await ensureWalletForSession(sessionPin, pinRaw, walletRaw);

  // Use the SDK's fee estimate (in sats) plus a buffer to give the router
  // headroom. If the estimate call fails, fall back to a conservative ceiling.
  let maxFeeSats = 50;
  const estimatedFee = await getWalletFeeEstimateRaw(invoice);
  if (estimatedFee !== null) {
    maxFeeSats = Math.max(25, Math.ceil(estimatedFee * 2));
  }

  // Pay via the unified path.
  const payResult = await payWalletInvoice(invoice, maxFeeSats);

  // For the 402 flow we need the preimage. Some Spark responses include it
  // immediately on payLightningInvoice; in our unified path we lose that
  // detail. We poll the lightning send request by id to get the preimage.
  if (payResult.preimage) {
    return { preimage: payResult.preimage };
  }
  if (!payResult.txId) {
    throw new Error('Payment initiated but no request ID returned to poll for preimage.');
  }
  if (!cachedWallet) throw new Error('Wallet disposed before preimage was available.');
  const preimage = await pollForPreimage(cachedWallet, payResult.txId);
  return { preimage };
}

export async function initWalletFromMnemonic(mnemonic?: string): Promise<{ mnemonic: string; balanceSats: bigint }> {
  await disposeWallet(cachedWallet);
  cachedWallet = null;
  walletInitPromise = null;

  const result = await SparkWallet.initialize({
    ...(mnemonic ? { mnemonicOrSeed: mnemonic } : {}),
    options: { network: 'MAINNET' },
  });
  cachedWallet = result.wallet;
  const returnedMnemonic = (result as { mnemonic?: string }).mnemonic ?? mnemonic ?? '';
  subscribeWalletEvents(result.wallet);
  const bal = await result.wallet.getBalance();
  return { mnemonic: returnedMnemonic, balanceSats: bal.balance };
}

export async function disposeCachedWallet(): Promise<void> {
  const walletToDispose = cachedWallet;
  cachedWallet = null;
  walletInitPromise = null;
  await disposeWallet(walletToDispose);
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

export async function payWalletInvoice(invoice: string, maxFeeSats: number): Promise<{ txId?: string; preimage?: string }> {
  if (!cachedWallet) throw new Error('Wallet not initialized.');
  const result = await cachedWallet.payLightningInvoice({ invoice, maxFeeSats });
  const r = result as unknown as Record<string, unknown>;
  const txId = typeof r.id === 'string' ? r.id : typeof r.transferSparkId === 'string' ? r.transferSparkId : undefined;
  const preimage = typeof r.paymentPreimage === 'string' ? r.paymentPreimage
    : typeof r.preimage === 'string' ? r.preimage
    : typeof r.payment_preimage === 'string' ? r.payment_preimage
    : undefined;
  return { txId, preimage };
}

export async function hasCachedWallet(): Promise<{ hasWallet: boolean; balanceSats?: bigint }> {
  if (!cachedWallet) return { hasWallet: false };
  try {
    const balance = await cachedWallet.getBalance();
    return { hasWallet: true, balanceSats: balance.balance };
  } catch {
    return { hasWallet: false };
  }
}