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

export async function payInvoiceFromSession(invoice: string): Promise<{ preimage: string }> {
  let wallet: SparkWallet | null = null;

  try {
    const mnemonic = await decryptMnemonicFromStorage();
    const initialized = await SparkWallet.initialize({ mnemonicOrSeed: mnemonic });
    wallet = initialized.wallet;

    const paymentResult = await wallet.payLightningInvoice({ invoice, maxFeeSats: 200 });
    const preimage = getResultString(paymentResult, ['preimage', 'paymentPreimage', 'payment_preimage']);
    if (!preimage) {
      throw new Error('Payment succeeded but no preimage was returned.');
    }

    return { preimage };
  } finally {
    await disposeWallet(wallet);
  }
}