import { SparkWallet } from '@buildonspark/spark-sdk'
import { decryptText, deriveKey, hexToBuf } from './crypto'

const SENTINEL = 'spark_wallet_v1';

interface PinPayload {
  salt: string;
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

  const maybeWallet = wallet as unknown as {
    cleanup?: () => Promise<void> | void;
    disconnect?: () => Promise<void> | void;
    stop?: () => Promise<void> | void;
  };

  try {
    await Promise.resolve(maybeWallet.cleanup?.());
  } catch {
    // Best-effort cleanup.
  }

  try {
    await Promise.resolve(maybeWallet.disconnect?.());
  } catch {
    // Best-effort cleanup.
  }

  try {
    await Promise.resolve(maybeWallet.stop?.());
  } catch {
    // Best-effort cleanup.
  }
}

async function decryptMnemonicFromCredentials(sessionPin: string, pinRaw: string, walletRaw: string): Promise<string> {
  const pinPayload = JSON.parse(pinRaw) as PinPayload;
  const walletPayload = JSON.parse(walletRaw) as WalletPayload;
  const key = await deriveKey(sessionPin, hexToBuf(pinPayload.salt));
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

const WALLET_IDLE_TIMEOUT_MS = 90_000;

let cachedWallet: SparkWallet | null = null;
let walletInitPromise: Promise<SparkWallet> | null = null;
let walletIdleTimer: ReturnType<typeof setTimeout> | undefined;

function touchWalletIdleTimer() {
  if (walletIdleTimer !== undefined) {
    clearTimeout(walletIdleTimer);
  }

  walletIdleTimer = setTimeout(() => {
    const walletToDispose = cachedWallet;
    cachedWallet = null;
    walletInitPromise = null;
    void disposeWallet(walletToDispose);
  }, WALLET_IDLE_TIMEOUT_MS);
}

async function getOrCreateWallet(sessionPin: string, pinRaw: string, walletRaw: string): Promise<SparkWallet> {
  if (cachedWallet) {
    touchWalletIdleTimer();
    return cachedWallet;
  }

  if (!walletInitPromise) {
    walletInitPromise = (async () => {
      const mnemonic = await decryptMnemonicFromCredentials(sessionPin, pinRaw, walletRaw);
      const initialized = await SparkWallet.initialize({ mnemonicOrSeed: mnemonic, options: { network: 'MAINNET' } });
      cachedWallet = initialized.wallet;
      touchWalletIdleTimer();
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

function getRecommendedMaxFeeSats(amountSats: number): number {
  return Math.max(5, Math.ceil(amountSats * 0.0017));
}

export async function payInvoiceFromSession(
  invoice: string,
  sessionPin: string,
  pinRaw: string,
  walletRaw: string,
): Promise<{ preimage: string }> {
  const wallet = await getOrCreateWallet(sessionPin, pinRaw, walletRaw);

  let maxFeeSats = 50; // conservative fallback
  try {
    const feeEstimate = await (wallet as unknown as {
      getLightningSendFeeEstimate: (params: { encodedInvoice: string }) => Promise<Record<string, unknown>>;
    }).getLightningSendFeeEstimate({ encodedInvoice: invoice });

    const estimatedFee = feeEstimate?.feeEstimate ?? feeEstimate?.fee ?? feeEstimate?.estimatedFee;
    const amountSats = feeEstimate?.amountSats ?? feeEstimate?.amount;

    if (typeof estimatedFee === 'number' && Number.isFinite(estimatedFee)) {
      maxFeeSats = Math.max(5, estimatedFee);
    } else if (typeof amountSats === 'number' && Number.isFinite(amountSats)) {
      maxFeeSats = getRecommendedMaxFeeSats(amountSats);
    }
  } catch {
    // Fee estimate unavailable; proceed with fallback.
  }

  const paymentResult = await wallet.payLightningInvoice({ invoice, maxFeeSats });

  // payLightningInvoice returns immediately after initiating. The preimage is
  // populated asynchronously by the SSP; poll until it arrives or we time out.
  const immediate = getResultString(paymentResult as unknown as Record<string, unknown>, [
    'paymentPreimage',
    'preimage',
    'payment_preimage',
  ]);
  if (immediate) {
    touchWalletIdleTimer();
    return { preimage: immediate };
  }

  const requestId = getResultString(paymentResult as unknown as Record<string, unknown>, ['id']);
  if (!requestId) {
    throw new Error('Payment initiated but no request ID returned to poll for preimage.');
  }

  const preimage = await pollForPreimage(wallet, requestId);
  touchWalletIdleTimer();
  return { preimage };
}