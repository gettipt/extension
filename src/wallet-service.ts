import { SparkWallet } from '@buildonspark/spark-sdk'
import { decryptText, deriveKey, hexToBuf } from './crypto'

const PIN_KEY = 'spark_pin';
const WALLET_KEY = 'spark_wallet';
const SESSION_PIN_KEY = 'spark_session_pin';
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

async function getSyncString(key: string): Promise<string | null> {
  const items = await chrome.storage.sync.get([key]);
  const value = items[key];
  return typeof value === 'string' ? value : null;
}

async function getSessionString(key: string): Promise<string | null> {
  const items = await chrome.storage.session.get([key]);
  const value = items[key];
  return typeof value === 'string' ? value : null;
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

async function decryptMnemonicFromStorage(): Promise<string> {
  const sessionPin = await getSessionString(SESSION_PIN_KEY);
  if (!sessionPin) {
    throw new Error('Wallet is locked. Open TIPT and unlock first.');
  }

  const pinRaw = await getSyncString(PIN_KEY);
  if (!pinRaw) {
    throw new Error('PIN verifier not found.');
  }

  const walletRaw = await getSyncString(WALLET_KEY);
  if (!walletRaw) {
    throw new Error('Encrypted wallet not found.');
  }

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

async function pollForPreimage(
  wallet: SparkWallet,
  requestId: string,
  maxWaitMs = 60_000,
  intervalMs = 1_500,
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

export async function payInvoiceFromSession(invoice: string): Promise<{ preimage: string }> {
  let wallet: SparkWallet | null = null;

  try {
    const mnemonic = await decryptMnemonicFromStorage();
    const initialized = await SparkWallet.initialize({ mnemonicOrSeed: mnemonic, options: { network: 'MAINNET' } });
    wallet = initialized.wallet;

    const paymentResult = await wallet.payLightningInvoice({ invoice, maxFeeSats: 200 });

    // payLightningInvoice returns immediately after initiating. The preimage is
    // populated asynchronously by the SSP; poll until it arrives or we time out.
    const immediate = getResultString(paymentResult as unknown as Record<string, unknown>, [
      'paymentPreimage',
      'preimage',
      'payment_preimage',
    ]);
    if (immediate) {
      return { preimage: immediate };
    }

    const requestId = getResultString(paymentResult as unknown as Record<string, unknown>, ['id']);
    if (!requestId) {
      throw new Error('Payment initiated but no request ID returned to poll for preimage.');
    }

    const preimage = await pollForPreimage(wallet, requestId);
    return { preimage };
  } finally {
    await disposeWallet(wallet);
  }
}