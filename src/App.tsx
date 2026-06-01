import { useState, useEffect, useRef, useCallback } from 'react'
import { SparkWallet } from '@buildonspark/spark-sdk'
import { QRCodeSVG } from 'qrcode.react'
import { FaGear, FaRightLeft } from 'react-icons/fa6'
import {
  deriveKey, encryptText, decryptText, hexToBuf, bufToHex,
} from './crypto'
import { resolveLnurlPayInfo, fetchInvoiceFromCallback } from './lnurl'
import type { LnurlPayInfo } from './lnurl'

// Types
type AppState =
  | 'initializing'
  | 'pin-setup'
  | 'pin-lock'
  | 'idle'
  | 'creating'
  | 'recovering'
  | 'backup-prompt'
  | 'ready'
  | 'error';

type PinSetupStep = 'enter' | 'confirm';
type ActivePanel = 'send' | 'receive' | null;
type SendStep = 'input' | 'amount' | 'confirm' | 'sending' | 'success' | 'error';
type PendingWalletAction =
  | { type: 'create' }
  | { type: 'recover'; mnemonic: string; fromFile?: boolean }
  | null;

interface WalletData {
  wallet: SparkWallet;
  mnemonic: string;
  balanceSats: bigint;
  recovered: boolean;
}

type WalletTransfer = Record<string, unknown>;

interface BrowserStorageArea {
  get: (keys: string[], callback: (items: Record<string, unknown>) => void) => void;
  set: (items: Record<string, string>, callback?: () => void) => void;
  remove?: (keys: string | string[], callback?: () => void) => void;
}

const PIN_KEY = 'spark_pin';
const WALLET_KEY = 'spark_wallet';
const SESSION_PIN_KEY = 'spark_session_pin';
const SENTINEL = 'spark_wallet_v1';
const PIN_LENGTH = 5;
const TRANSFERS_CACHE_KEY = 'spark_transfers_cache';

function shouldSyncStorageKey(key: string) {
  return key !== TRANSFERS_CACHE_KEY;
}

function getSyncStorage(): BrowserStorageArea | null {
  const browserLike = globalThis as typeof globalThis & {
    chrome?: {
      storage?: {
        sync?: BrowserStorageArea;
      };
    };
  };

  return browserLike.chrome?.storage?.sync ?? null;
}

function getSessionStorage(): BrowserStorageArea | null {
  const browserLike = globalThis as typeof globalThis & {
    chrome?: {
      storage?: {
        session?: BrowserStorageArea;
      };
    };
  };

  return browserLike.chrome?.storage?.session ?? null;
}

async function getStoredItem(key: string): Promise<string | null> {
  const syncStorage = getSyncStorage();
  const shouldSync = shouldSyncStorageKey(key);

  if (syncStorage && shouldSync) {
    const syncValue = await new Promise<string | null>((resolve) => {
      syncStorage.get([key], (items) => {
        const value = items[key];
        resolve(typeof value === 'string' ? value : null);
      });
    });

    if (syncValue) {
      localStorage.setItem(key, syncValue);
      return syncValue;
    }
  }

  const localValue = localStorage.getItem(key);
  if (localValue && syncStorage && shouldSync) {
    await new Promise<void>((resolve) => {
      syncStorage.set({ [key]: localValue }, () => resolve());
    });
  }

  return localValue;
}

async function setStoredItem(key: string, value: string): Promise<void> {
  localStorage.setItem(key, value);

  if (!shouldSyncStorageKey(key)) return;

  const syncStorage = getSyncStorage();
  if (!syncStorage) return;

  await new Promise<void>((resolve) => {
    syncStorage.set({ [key]: value }, () => resolve());
  });
}

async function removeStoredItem(key: string): Promise<void> {
  localStorage.removeItem(key);

  if (!shouldSyncStorageKey(key)) return;

  const syncStorage = getSyncStorage();
  if (!syncStorage?.remove) return;

  await new Promise<void>((resolve) => {
    syncStorage.remove?.(key, () => resolve());
  });
}

async function getSessionItem(key: string): Promise<string | null> {
  const sessionStorage = getSessionStorage();
  if (!sessionStorage) return null;

  return new Promise<string | null>((resolve) => {
    sessionStorage.get([key], (items) => {
      const value = items[key];
      resolve(typeof value === 'string' ? value : null);
    });
  });
}

async function setSessionItem(key: string, value: string): Promise<void> {
  const sessionStorage = getSessionStorage();
  if (!sessionStorage) return;

  await new Promise<void>((resolve) => {
    sessionStorage.set({ [key]: value }, () => resolve());
  });
}

async function removeSessionItem(key: string): Promise<void> {
  const sessionStorage = getSessionStorage();
  if (!sessionStorage?.remove) return;

  await new Promise<void>((resolve) => {
    sessionStorage.remove?.(key, () => resolve());
  });
}

function getMaxFeeSats(amountSats: number) {
  return Math.max(5, Math.ceil(amountSats * 0.0017));
}

function getMaxSpendableSats(balanceSats: number) {
  if (balanceSats <= 5) return 0;

  let candidate = Math.max(0, Math.floor((balanceSats * 10000) / 10017));
  candidate = Math.min(candidate, balanceSats - 5);

  while (candidate > 0 && candidate + getMaxFeeSats(candidate) > balanceSats) {
    candidate -= 1;
  }

  return candidate;
}

function getTransferString(transfer: WalletTransfer, keys: string[]) {
  for (const key of keys) {
    const value = transfer[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

function getTransferAmountSatsLabel(transfer: WalletTransfer) {
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

function getTransferDate(transfer: WalletTransfer): Date | null {
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

function getTransferDayLabel(transfer: WalletTransfer) {
  const date = getTransferDate(transfer);
  if (!date) return 'Unknown date';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function getTransferTimeLabel(transfer: WalletTransfer) {
  const date = getTransferDate(transfer);
  if (!date) return '';
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function groupTransfersByDay(transfers: WalletTransfer[]): { day: string; transfers: WalletTransfer[] }[] {
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

function Spinner({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function PinInput({
  value, onChange, onSubmit, disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: (v: string) => void;
  disabled?: boolean;
}) {
  const refs = [
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
  ];
  const digits = value.split('').concat(Array(PIN_LENGTH).fill('')).slice(0, PIN_LENGTH);

  const handleKey = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      const next = value.slice(0, i > 0 && digits[i] === '' ? i - 1 : i);
      onChange(next);
      refs[Math.max(0, digits[i] === '' ? i - 1 : i)]?.current?.focus();
    } else if (e.key === 'Enter' && value.length === PIN_LENGTH) {
      onSubmit?.(value);
    }
  };

  const handleChange = (i: number, e: React.ChangeEvent<HTMLInputElement>) => {
    const d = e.target.value.replace(/\D/g, '').slice(-1);
    if (!d) return;
    const arr = digits.slice();
    arr[i] = d;
    const next = arr.join('').slice(0, PIN_LENGTH);
    onChange(next);
    if (i < PIN_LENGTH - 1) refs[i + 1]?.current?.focus();
    else if (next.length === PIN_LENGTH) onSubmit?.(next);
  };

  return (
    <div className="flex gap-2 justify-center">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={refs[i]}
          type="password"
          inputMode="numeric"
          maxLength={1}
          value={d}
          onChange={(e) => handleChange(i, e)}
          onKeyDown={(e) => handleKey(i, e)}
          disabled={disabled}
          autoFocus={i === 0}
          className="w-10 h-12 text-center text-lg font-mono rounded-lg border border-transparent bg-neutral-100 text-neutral-900 focus:outline-none focus:border-neutral-500 disabled:opacity-50 caret-transparent dark:bg-neutral-800 dark:text-white dark:focus:border-neutral-400"
        />
      ))}
    </div>
  );
}

export default function App() {
  const [appState, setAppState] = useState<AppState>('initializing');
  const [walletError, setWalletError] = useState<string | null>(null);

  const [pinInput, setPinInput] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [pinSetupStep, setPinSetupStep] = useState<PinSetupStep>('enter');
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinLoading, setPinLoading] = useState(false);

  const [walletData, setWalletData] = useState<WalletData | null>(null);
  const [btcUsdRate, setBtcUsdRate] = useState<number | null>(null);
  const [recoverInput, setRecoverInput] = useState('');
  const [showRecover, setShowRecover] = useState(false);
  const [backupDownloaded, setBackupDownloaded] = useState(false);
  const skipBackupRef = useRef(false);

  const [activePanel, setActivePanel] = useState<ActivePanel>(null);
  const [invoice, setInvoice] = useState<string | null>(null);
  const [fetchingInvoice, setFetchingInvoice] = useState(false);
  const walletRef = useRef<SparkWallet | null>(null);

  const [sendStep, setSendStep] = useState<SendStep>('input');
  const [sendInput, setSendInput] = useState('');
  const [resolvedInput, setResolvedInput] = useState('');
  const [sendAmountSats, setSendAmountSats] = useState('');
  const [lnurlPayInfo, setLnurlPayInfo] = useState<LnurlPayInfo | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [sendTxId, setSendTxId] = useState<string | null>(null);
  const [isSendMax, setIsSendMax] = useState(false);
  const [pendingBolt11, setPendingBolt11] = useState<string | null>(null);
  const [feeEstimateSats, setFeeEstimateSats] = useState<number | null>(null);
  const [pendingWalletAction, setPendingWalletAction] = useState<PendingWalletAction>(null);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  const [invoiceCopied, setInvoiceCopied] = useState(false);
  const [balanceFlash, setBalanceFlash] = useState(false);
  const [usdPrimary, setUsdPrimary] = useState(false);
  const [recentTransfers, setRecentTransfers] = useState<WalletTransfer[]>([]);
  const [loadingTransfers, setLoadingTransfers] = useState(false);
  const [transfersError, setTransfersError] = useState<string | null>(null);
  const [showAllTransfers, setShowAllTransfers] = useState(false);

  const prevBalanceRef = useRef<bigint | null>(null);
  const activePanelRef = useRef<ActivePanel>(null);
  activePanelRef.current = activePanel;
  const cryptoKeyRef = useRef<CryptoKey | null>(null);

  const disposeWallet = useCallback(async (wallet: SparkWallet | null) => {
    if (!wallet) return;

    const walletWithCleanup = wallet as SparkWallet & {
      cleanupConnections?: () => Promise<void>;
    };

    try {
      if (typeof walletWithCleanup.cleanupConnections === 'function') {
        await walletWithCleanup.cleanupConnections();
      } else {
        wallet.removeAllListeners();
      }
    } catch {
      wallet.removeAllListeners();
    }
  }, []);

  const downloadBackupFile = useCallback(() => {
    if (!walletData) return;
    const blob = new Blob([walletData.mnemonic], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'TIPT-Wallet-Backup.txt';
    a.click();
    URL.revokeObjectURL(url);
  }, [walletData]);

  useEffect(() => {
    if (!showSettingsMenu) return;
    const handler = (e: MouseEvent) => {
      if (settingsMenuRef.current && !settingsMenuRef.current.contains(e.target as Node)) {
        setShowSettingsMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSettingsMenu]);

  useEffect(() => {
    const current = walletData?.balanceSats ?? null;
    const prev = prevBalanceRef.current;
    if (current !== null && prev !== null && current > prev) {
      if (activePanelRef.current === 'receive') {
        setActivePanel(null);
        setInvoiceCopied(false);
        setInvoice(null);
      }
      setBalanceFlash(true);
      setTimeout(() => setBalanceFlash(false), 500);
    }
    if (walletData) {
      void loadTransfers(walletData.wallet);
    }
    prevBalanceRef.current = current;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletData?.balanceSats]);

  const doInitWallet = async (
    mnemonicOrSeed: string | undefined,
    key: CryptoKey,
    recovered: boolean,
  ) => {
    try {
      await disposeWallet(walletRef.current);
      walletRef.current = null;
      cryptoKeyRef.current = key;
      // Decrypt cached transfers in parallel with wallet init
      const cachedTransfersPromise = (async () => {
        try {
          const cachedRaw = await getStoredItem(TRANSFERS_CACHE_KEY);
          if (cachedRaw) {
            const { iv: cIv, ct: cCt } = JSON.parse(cachedRaw);
            const plain = await decryptText(key, cIv, cCt);
            const parsed = JSON.parse(plain) as WalletTransfer[];
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
          }
        } catch { /* ignore cache decryption errors */ }
        return null;
      })();
      const result = await SparkWallet.initialize({
        ...(mnemonicOrSeed ? { mnemonicOrSeed } : {}),
        options: { network: 'MAINNET' },
      });
      const wallet = result.wallet;
      const mnemonic: string = (result as unknown as { mnemonic?: string }).mnemonic ?? mnemonicOrSeed ?? '';
      const balance = await wallet.getBalance();
      const encrypted = await encryptText(key, mnemonic);
      await setStoredItem(WALLET_KEY, JSON.stringify(encrypted));
      const cachedTransfers = await cachedTransfersPromise;
      if (cachedTransfers) setRecentTransfers(cachedTransfers);
      setWalletData({ wallet, mnemonic, balanceSats: balance.balance, recovered });
      setActivePanel(null);
      setInvoice(null);
      if (!skipBackupRef.current) {
        setBackupDownloaded(false);
        setAppState('backup-prompt');
      } else {
        setAppState('ready');
      }
      subscribeToWalletEvents(wallet);
      void loadTransfers(wallet);
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : String(err));
      setAppState('error');
    }
  };

  const afterUnlock = useCallback(async (key: CryptoKey) => {
    const walletRaw = await getStoredItem(WALLET_KEY);
    if (!walletRaw) { setAppState('idle'); return; }
    skipBackupRef.current = true;
    setAppState('recovering');
    try {
      const { iv, ct } = JSON.parse(walletRaw);
      const mnemonic = await decryptText(key, iv, ct);
      await doInitWallet(mnemonic, key, true);
    } catch {
      setAppState('idle');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const storedWallet = await getStoredItem(WALLET_KEY);
      const sessionPin = await getSessionItem(SESSION_PIN_KEY);

      if (storedWallet && sessionPin) {
        try {
          const pinRaw = await getStoredItem(PIN_KEY);
          if (!pinRaw) throw new Error('PIN_NOT_FOUND');

          const { salt, verifier } = JSON.parse(pinRaw);
          const key = await deriveKey(sessionPin, hexToBuf(salt));
          const result = await decryptText(key, verifier.iv, verifier.ct);
          if (result !== SENTINEL) throw new Error('WRONG_SESSION_PIN');

          if (!cancelled) {
            await afterUnlock(key);
          }
          return;
        } catch {
          await removeSessionItem(SESSION_PIN_KEY);
        }
      }

      if (!cancelled) {
        setAppState(storedWallet ? 'pin-lock' : 'idle');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [afterUnlock]);

  useEffect(() => () => {
    const wallet = walletRef.current;
    walletRef.current = null;
    void disposeWallet(wallet);
  }, [disposeWallet]);

  const refreshBtcUsdRate= useCallback(async () => {
    try {
      const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
      if (!response.ok) return;
      const data = await response.json() as { bitcoin?: { usd?: number } };
      const nextRate = data.bitcoin?.usd;
      if (typeof nextRate === 'number' && Number.isFinite(nextRate)) {
        setBtcUsdRate(nextRate);
      }
    } catch {
      // Ignore transient pricing errors and keep the last known rate.
    }
  }, []);

  useEffect(() => {
    void refreshBtcUsdRate();
    const timer = setInterval(() => {
      void refreshBtcUsdRate();
    }, 300000);
    return () => clearInterval(timer);
  }, [refreshBtcUsdRate]);

  const loadTransfers = useCallback(async (wallet: SparkWallet) => {
    setLoadingTransfers(true);
    setTransfersError(null);
    try {
      const walletWithTransfers = wallet as unknown as {
        getTransfers?: (limit?: number, offset?: number) => Promise<unknown>;
      };
      if (typeof walletWithTransfers.getTransfers !== 'function') {
        setTransfersError('Transfer history is not available in this Spark SDK build.');
        setRecentTransfers([]);
        return;
      }

      const response = await walletWithTransfers.getTransfers(10, 0);
      const transfersValue =
        typeof response === 'object' && response !== null && 'transfers' in response
          ? (response as { transfers?: unknown }).transfers
          : [];

      if (!Array.isArray(transfersValue)) {
        setRecentTransfers([]);
        return;
      }

      const normalized = transfersValue
        .map((item) => (typeof item === 'object' && item !== null ? item as WalletTransfer : null))
        .filter((item): item is WalletTransfer => item !== null);
      setRecentTransfers(normalized);
      const key = cryptoKeyRef.current;
      if (key) {
        try {
          const encrypted = await encryptText(key, JSON.stringify(normalized));
          await setStoredItem(TRANSFERS_CACHE_KEY, JSON.stringify(encrypted));
        } catch { /* ignore encryption/quota errors */ }
      }
    } catch (err) {
      setTransfersError(err instanceof Error ? err.message : 'Failed to load transfer history.');
    } finally {
      setLoadingTransfers(false);
    }
  }, []);

  const subscribeToWalletEvents = useCallback((wallet: SparkWallet) => {
    // Clean up previous listeners if any
    const previousWallet = walletRef.current;
    previousWallet?.removeAllListeners();
    walletRef.current = wallet;

    // Use only the definitive events that fire once with the final settled balance.
    // Avoid 'balance:update' — it fires multiple times as individual leaves are
    // claimed, causing the displayed balance to tick up in chunks.
    wallet.on('transfer:claimed', (_transferId: string, updatedBalance: bigint) => {
      setWalletData((prev) => prev ? { ...prev, balanceSats: updatedBalance } : prev);
    });

    wallet.on('deposit:confirmed', (_depositId: string, updatedBalance: bigint) => {
      setWalletData((prev) => prev ? { ...prev, balanceSats: updatedBalance } : prev);
    });
  }, []);

  const handlePinSetupNext = (pin = pinInput) => {
    if (pin.length < PIN_LENGTH) { setPinError(`PIN must be exactly ${PIN_LENGTH} digits.`); return; }
    setPinSetupStep('confirm');
    setPinConfirm('');
    setPinError(null);
  };

  const handlePinSetupConfirm = async (confirmPin = pinConfirm) => {
    if (confirmPin.length < PIN_LENGTH) return;
    if (confirmPin !== pinInput) {
      setPinError('PINs do not match. Try again.');
      setPinConfirm('');
      return;
    }
    setPinLoading(true);
    setPinError(null);
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveKey(pinInput, salt);
      const verifier = await encryptText(key, SENTINEL);
      await setStoredItem(PIN_KEY, JSON.stringify({ salt: bufToHex(salt), verifier }));
      await setSessionItem(SESSION_PIN_KEY, pinInput);
      setPinInput('');
      setPinConfirm('');
      setPinSetupStep('enter');
      if (pendingWalletAction?.type === 'create') {
        skipBackupRef.current = false;
        setPendingWalletAction(null);
        setAppState('creating');
        await doInitWallet(undefined, key, false);
      } else if (pendingWalletAction?.type === 'recover') {
        skipBackupRef.current = !!pendingWalletAction.fromFile;
        setPendingWalletAction(null);
        setAppState('recovering');
        await doInitWallet(pendingWalletAction.mnemonic, key, true);
      } else {
        await afterUnlock(key);
      }
    } catch {
      setPinError('Failed to set up PIN. Please try again.');
    } finally {
      setPinLoading(false);
    }
  };

  const handlePinUnlock = async (pin = pinInput) => {
    if (pin.length < PIN_LENGTH) return;
    setPinLoading(true);
    setPinError(null);
    try {
      const pinRaw = await getStoredItem(PIN_KEY);
      if (!pinRaw) throw new Error('PIN_NOT_FOUND');
      const { salt, verifier } = JSON.parse(pinRaw);
      const key = await deriveKey(pin, hexToBuf(salt));
      const result = await decryptText(key, verifier.iv, verifier.ct);
      if (result !== SENTINEL) throw new Error('Wrong PIN.');
      await setSessionItem(SESSION_PIN_KEY, pin);
      setPinInput('');
      await afterUnlock(key);
    } catch (err) {
      setPinError(
        err instanceof Error && err.message === 'PIN_NOT_FOUND'
          ? 'Wallet found, but PIN data has not synced yet. Please try again shortly.'
          : 'Incorrect PIN. Please try again.',
      );
      setPinInput('');
    } finally {
      setPinLoading(false);
    }
  };

  const handleReceive = async () => {
    if (activePanel === 'receive') {
      setActivePanel(null);
      setInvoiceCopied(false);
      return;
    }
    setActivePanel('receive');
    setInvoiceCopied(false);
    if (!invoice && walletData) {
      setFetchingInvoice(true);
      try {
        const r = await walletData.wallet.createLightningInvoice({ amountSats: 0 });
        setInvoice((r as unknown as { invoice: { encodedInvoice: string } }).invoice.encodedInvoice);
      } catch {
        // Ignore invoice creation failures here and keep the receive panel open.
      } finally {
        setFetchingInvoice(false);
      }
    }
  };

  const handleSend = () => {
    if (activePanel === 'send') { setActivePanel(null); return; }
    setActivePanel('send');
    setSendStep('input');
    setSendInput('');
    setSendAmountSats('');
    setLnurlPayInfo(null);
    setSendError(null);
    setSendTxId(null);
    setPendingBolt11(null);
    setFeeEstimateSats(null);
    setIsSendMax(false);
  };

  const handleDeleteWalletAndReset = async () => {
    const confirmed = globalThis.confirm('Clicking OK will delete your wallet and cannot be undone.');
    if (!confirmed) return;

    setShowSettingsMenu(false);

    try {
      await Promise.all([
        removeStoredItem(PIN_KEY),
        removeStoredItem(WALLET_KEY),
        removeStoredItem(TRANSFERS_CACHE_KEY),
        removeSessionItem(SESSION_PIN_KEY),
      ]);

      await disposeWallet(walletRef.current);
      walletRef.current = null;

      cryptoKeyRef.current = null;
      setWalletData(null);
      setRecentTransfers([]);
      setInvoice(null);
      setInvoiceCopied(false);
      setActivePanel(null);
      setPendingWalletAction(null);
      setShowRecover(false);
      setRecoverInput('');
      setAppState('idle');

      globalThis.location.reload();
    } catch {
      setWalletError('Failed to delete wallet data. Please try again.');
    }
  };

  const handleSendPayment = async () => {
    if (!walletData) return;

    // If lnurlPayInfo not yet resolved, resolve first then validate amount.
    let payInfo = lnurlPayInfo;
    if (!payInfo) {
      if (!sendInput.trim()) return;
      setResolving(true);
      setSendError(null);
      try {
        const info = await resolveLnurlPayInfo(sendInput.trim());
        const minSendableSats = Math.ceil(info.minSendableMsats / 1000);
        const lnurlMaxSats = Math.floor(info.maxSendableMsats / 1000);
        const maxSpendableSats = getMaxSpendableSats(Number(walletData.balanceSats));
        const effectiveMaxSats = Math.min(lnurlMaxSats, maxSpendableSats);
        if (effectiveMaxSats < minSendableSats) {
          setSendError('Balance is too low to cover this payment plus network fees.');
          return;
        }
        setLnurlPayInfo(info);
        setResolvedInput(sendInput.trim());
        payInfo = info;
      } catch (err) {
        setSendError(err instanceof Error ? err.message : String(err));
        return;
      } finally {
        setResolving(false);
      }
      // If no amount entered yet, stop here so the user can enter one.
      if (!sendAmountSats.trim()) return;
    }
    const balanceSats = Number(walletData.balanceSats);
    let effectiveAmountSats: number;

    if (isSendMax) {
      // Deduct fee from balance so total never exceeds balance.
      const lnurlCap = payInfo ? Math.floor(payInfo.maxSendableMsats / 1000) : Infinity;
      effectiveAmountSats = Math.min(getMaxSpendableSats(balanceSats), lnurlCap);
      if (payInfo && effectiveAmountSats < Math.ceil(payInfo.minSendableMsats / 1000)) {
        setSendError('Balance is too low to cover this payment plus network fees.');
        return;
      }
    } else {
      const parsed = parseInt(sendAmountSats, 10);
      if (isNaN(parsed) || parsed <= 0) { setSendError('Enter a valid amount.'); return; }
      if (parsed > balanceSats) {
        setSendError('Amount exceeds your balance.');
        return;
      }
      if (payInfo) {
        const amountMsats = parsed * 1000;
        if (amountMsats < payInfo.minSendableMsats) {
          setSendError(`Minimum is ${Math.ceil(payInfo.minSendableMsats / 1000)} sats.`);
          return;
        }
        if (amountMsats > payInfo.maxSendableMsats) {
          setSendError(`Maximum is ${Math.floor(payInfo.maxSendableMsats / 1000)} sats.`);
          return;
        }
      }
      effectiveAmountSats = parsed;
    }

    setSendError(null);
    setResolving(true);
    try {
      if (!payInfo) { setSendError('Could not resolve payment destination.'); return; }
      let bolt11 = await fetchInvoiceFromCallback(payInfo.callback, effectiveAmountSats * 1000);
      let fee: number | null = null;
      try {
        fee = await (walletData.wallet as unknown as {
          getLightningSendFeeEstimate: (p: { encodedInvoice: string }) => Promise<number>;
        }).getLightningSendFeeEstimate({ encodedInvoice: bolt11 });
      } catch {
        fee = getMaxFeeSats(effectiveAmountSats);
      }
      const safeFee = fee ?? getMaxFeeSats(effectiveAmountSats);
      // If amount + fee would exceed balance, deduct the fee from the send amount and re-fetch.
      if (effectiveAmountSats + safeFee > balanceSats) {
        effectiveAmountSats = balanceSats - safeFee;
        if (effectiveAmountSats <= 0) {
          setSendError('Balance is too low to cover the network fee.');
          return;
        }
        if (payInfo && effectiveAmountSats * 1000 < payInfo.minSendableMsats) {
          setSendError(`Balance is too low. After fees, you can only send ${effectiveAmountSats} sats but minimum is ${Math.ceil(payInfo.minSendableMsats / 1000)} sats.`);
          return;
        }
        bolt11 = await fetchInvoiceFromCallback(payInfo.callback, effectiveAmountSats * 1000);
        // Re-estimate fee for the adjusted amount; reuse safeFee if SDK call fails.
        try {
          fee = await (walletData.wallet as unknown as {
            getLightningSendFeeEstimate: (p: { encodedInvoice: string }) => Promise<number>;
          }).getLightningSendFeeEstimate({ encodedInvoice: bolt11 });
        } catch {
          fee = safeFee;
        }
      }
      setSendAmountSats(String(effectiveAmountSats));
      setPendingBolt11(bolt11);
      setFeeEstimateSats(fee);
      setSendStep('confirm');
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setResolving(false);
    }
  };

  const handleConfirmPayment = async () => {
    if (!walletData || !pendingBolt11) return;
    setSendStep('sending');
    try {
      const result = await walletData.wallet.payLightningInvoice({
        invoice: pendingBolt11,
        maxFeeSats: feeEstimateSats !== null ? Math.max(feeEstimateSats, getMaxFeeSats(parseInt(sendAmountSats, 10))) : getMaxFeeSats(parseInt(sendAmountSats, 10)),
      });
      const txId =
        'id' in result ? (result as { id: string }).id
          : 'transferSparkId' in result ? (result as { transferSparkId?: string }).transferSparkId
            : null;
      setSendTxId(txId ?? null);
      setSendStep('success');
      const balance = await walletData.wallet.getBalance();
      setWalletData((prev) => prev ? { ...prev, balanceSats: balance.balance } : prev);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
      setSendStep('error');
    }
  };

  const isLoading = appState === 'creating' || appState === 'recovering';
  const usdBalance= walletData && btcUsdRate !== null
    ? (Number(walletData.balanceSats) / 100000000) * btcUsdRate
    : null;
  const satsDisplay = walletData ? walletData.balanceSats.toLocaleString('en-US') : '--';
  const usdDisplay = usdBalance === null
    ? '--'
    : usdBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="w-81 max-h-150 overflow-y-auto bg-white text-neutral-900 flex flex-col p-4 dark:bg-neutral-950 dark:text-neutral-100">

      {appState === 'initializing' && (
        <div className="flex flex-col items-center gap-4 py-8">
          <img src="/tiptgreen.svg" alt="TIPT" className="w-10 h-10" />
          <Spinner className="w-6 h-6 text-neutral-400" />
        </div>
      )}

      {appState === 'pin-setup' && (
        <div className="space-y-4 p-4">
          <div className="text-center">
            <img src="/tiptgreen.svg" alt="TIPT" className="w-10 h-10 mx-auto mb-3" />
            <h2 className="text-sm font-semibold text-neutral-900 dark:text-white">
              {pinSetupStep === 'enter' ? 'Create a PIN' : 'Confirm your PIN'}
            </h2>
            <p className="text-xs text-neutral-500 mt-1">
              {pinSetupStep === 'enter' ? `Choose a ${PIN_LENGTH}-digit PIN for your wallet.` : 'Re-enter your PIN to confirm.'}
            </p>
          </div>
          <PinInput
            key={pinSetupStep}
            value={pinSetupStep === 'enter' ? pinInput : pinConfirm}
            onChange={pinSetupStep === 'enter' ? setPinInput : setPinConfirm}
            onSubmit={pinSetupStep === 'enter' ? handlePinSetupNext : handlePinSetupConfirm}
            disabled={pinLoading}
          />
          {pinError && <p className="text-center text-xs text-neutral-500 dark:text-neutral-400">{pinError}</p>}
          <button
            onClick={() => {
              if (pinSetupStep === 'enter') handlePinSetupNext();
              else void handlePinSetupConfirm();
            }}
            disabled={pinLoading || (pinSetupStep === 'enter' ? pinInput.length < PIN_LENGTH : pinConfirm.length < PIN_LENGTH)}
            className="w-full py-2.5 text-sm font-semibold rounded-xl bg-neutral-900 text-white hover:bg-neutral-700 disabled:opacity-40 disabled:pointer-events-none transition-colors flex items-center justify-center gap-2 dark:bg-neutral-200 dark:text-neutral-950 dark:hover:bg-neutral-100"
          >
            {pinLoading ? (<><Spinner className="w-4 h-4" /> Setting up...</>) : pinSetupStep === 'enter' ? 'Next' : 'Confirm PIN'}
          </button>
          {pinSetupStep === 'confirm' ? (
            <button onClick={() => { setPinSetupStep('enter'); setPinConfirm(''); setPinError(null); }} className="w-full py-2 text-xs font-medium rounded-lg border border-neutral-300 text-neutral-500 hover:border-neutral-400 hover:text-neutral-800 transition-colors dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-600 dark:hover:text-neutral-200">
              Back
            </button>
          ) : (
            <button onClick={() => { setPendingWalletAction(null); setPinInput(''); setPinError(null); setAppState('idle'); }} className="block w-full text-center text-sm text-neutral-500 hover:text-neutral-900 underline underline-offset-2 transition-colors dark:text-neutral-600 dark:hover:text-neutral-100">
              Cancel
            </button>
          )}
        </div>
      )}

      {appState === 'pin-lock' && (
        <div className="space-y-4 p-4">
          <div className="text-center">
            <img src="/tiptgreen.svg" alt="TIPT" className="w-10 h-10 mx-auto mb-3" />
            <h2 className="text-sm font-semibold text-neutral-900 dark:text-white">Enter your PIN</h2>
            <p className="text-xs text-neutral-500 mt-1">Your wallet is locked.</p>
          </div>
          <PinInput value={pinInput} onChange={setPinInput} onSubmit={handlePinUnlock} disabled={pinLoading} />
          {pinError && <p className="text-center text-xs text-neutral-500 dark:text-neutral-400">{pinError}</p>}
          <button
            onClick={() => { void handlePinUnlock(); }}
            disabled={pinLoading || pinInput.length < PIN_LENGTH}
            className="w-full py-2.5 text-sm font-semibold rounded-xl bg-neutral-900 text-white hover:bg-neutral-700 disabled:opacity-40 disabled:pointer-events-none transition-colors flex items-center justify-center gap-2 dark:bg-neutral-200 dark:text-neutral-950 dark:hover:bg-neutral-100"
          >
            {pinLoading ? (<><Spinner className="w-4 h-4" /> Unlocking...</>) : 'Unlock'}
          </button>
        </div>
      )}

      {isLoading && (
        <div className="flex flex-col items-center gap-4 py-8">
          <img src="/tiptgreen.svg" alt="TIPT" className="w-10 h-10" />
          <Spinner className="w-6 h-6 text-neutral-400" />
          <span className="text-neutral-400 text-sm">{appState === 'recovering' ? 'Recovering wallet...' : 'Creating wallet...'}</span>
        </div>
      )}

      {appState === 'error' && (
        <div className="space-y-3 text-center">
          <div className="p-4 rounded-xl bg-neutral-100 border border-neutral-300 text-neutral-700 dark:bg-neutral-800/50 dark:border-neutral-600/30 dark:text-neutral-300">
            <p className="font-semibold text-sm mb-1">Something went wrong</p>
            <p className="text-xs font-mono break-all">{walletError}</p>
          </div>
          <button onClick={() => setAppState('idle')} className="px-5 py-2.5 text-sm font-semibold rounded-xl bg-neutral-900 text-white hover:bg-neutral-700 transition-colors dark:bg-neutral-200 dark:text-neutral-950 dark:hover:bg-neutral-100">
            Try Again
          </button>
        </div>
      )}

      {appState === 'idle' && (
        <div className="space-y-4 p-4">
          <div className="text-center">
            <img src="/tiptgreen.svg" alt="TIPT" className="w-10 h-10 mx-auto mb-3" />
            <h2 className="text-sm font-semibold text-neutral-900 dark:text-white">{showRecover ? 'Recover Wallet' : 'Get Started'}</h2>
            <p className="text-xs text-neutral-500 mt-1">{showRecover ? 'Enter your seed phrase or upload your backup file to restore your wallet.' : 'Create a new wallet or recover an existing one.'}</p>
          </div>
          {!showRecover ? (
            <>
              <button onClick={() => {
                setPendingWalletAction({ type: 'create' });
                setPinInput('');
                setPinConfirm('');
                setPinError(null);
                setPinSetupStep('enter');
                setAppState('pin-setup');
              }} className="w-full py-3 text-sm font-semibold rounded-xl bg-neutral-900 text-white hover:bg-neutral-700 active:bg-neutral-950 transition-colors dark:bg-neutral-200 dark:text-neutral-950 dark:hover:bg-neutral-100 dark:active:bg-neutral-300">
                Create Wallet
              </button>
              <button onClick={() => setShowRecover(true)} className="w-full py-2.5 text-sm font-semibold rounded-xl border border-neutral-300 text-neutral-700 hover:border-neutral-400 hover:bg-neutral-100 transition-colors dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-500 dark:hover:bg-neutral-800">
                Recover Wallet
              </button>
              <a href="#" onClick={(e) => e.preventDefault()} className="block w-full text-center text-sm text-neutral-500 hover:text-neutral-900 underline underline-offset-2 transition-colors dark:text-neutral-600 dark:hover:text-neutral-100">
                Setup Instructions
              </a>
            </>
          ) : (
            <div className="space-y-3">
              <textarea
                autoFocus
                value={recoverInput}
                onChange={(e) => setRecoverInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const t = recoverInput.trim();
                    if (!t) return;
                    setPendingWalletAction({ type: 'recover', mnemonic: t });
                    setShowRecover(false);
                    setRecoverInput('');
                    setPinInput('');
                    setPinConfirm('');
                    setPinError(null);
                    setPinSetupStep('enter');
                    setAppState('pin-setup');
                  }
                }}
                placeholder="Enter your seed phrase..."
                rows={3}
                className="w-full px-3 py-2 rounded-lg bg-white border border-neutral-300 text-xs text-neutral-800 placeholder-neutral-400 font-mono resize-none focus:outline-none focus:border-neutral-500/50 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-400 dark:placeholder-neutral-600 dark:focus:border-neutral-400/50"
              />
              <button
                onClick={() => {
                  const t = recoverInput.trim();
                  if (!t) return;
                  setPendingWalletAction({ type: 'recover', mnemonic: t });
                  setShowRecover(false);
                  setRecoverInput('');
                  setPinInput('');
                  setPinConfirm('');
                  setPinError(null);
                  setPinSetupStep('enter');
                  setAppState('pin-setup');
                }}
                disabled={!recoverInput.trim()}
                className="w-full py-2.5 text-sm font-semibold rounded-xl bg-neutral-900 text-white hover:bg-neutral-700 disabled:opacity-40 disabled:pointer-events-none transition-colors dark:bg-neutral-200 dark:text-neutral-950 dark:hover:bg-neutral-100"
              >
                Recover
              </button>
              <label className="flex items-center justify-center gap-1.5 w-full py-2.5 text-sm font-medium rounded-xl border border-dashed border-neutral-300 text-neutral-500 hover:border-neutral-400 hover:text-neutral-800 cursor-pointer transition-colors dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-600 dark:hover:text-neutral-200">
                <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5-5m0 0l5 5m-5-5v12" /></svg>
                Upload Backup File
                <input
                  type="file"
                  accept=".txt,.text,text/plain"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = () => {
                      const text = (reader.result as string).trim();
                      if (!text) return;
                      setPendingWalletAction({ type: 'recover', mnemonic: text, fromFile: true });
                      setShowRecover(false);
                      setRecoverInput('');
                      setPinInput('');
                      setPinConfirm('');
                      setPinError(null);
                      setPinSetupStep('enter');
                      setAppState('pin-setup');
                    };
                    reader.readAsText(file);
                    e.target.value = '';
                  }}
                />
              </label>
              <button onClick={() => { setShowRecover(false); setRecoverInput(''); }} className="block w-full text-center text-sm text-neutral-500 hover:text-neutral-900 underline underline-offset-2 transition-colors dark:text-neutral-600 dark:hover:text-neutral-100">
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {appState === 'backup-prompt' && walletData && (
        <div className="space-y-4 p-4">
          <div className="text-center">
            <img src="/tiptgreen.svg" alt="TIPT" className="w-10 h-10 mx-auto mb-3" />
            <h2 className="text-sm font-semibold text-neutral-900 dark:text-white">Back Up Your Wallet</h2>
            <p className="text-xs text-neutral-500 mt-1">
              Download your backup file and store it somewhere safe. It will help you recover your wallet if you lose access.
            </p>
          </div>
          <button
            onClick={() => {
              downloadBackupFile();
              setBackupDownloaded(true);
            }}
            className="w-full py-3 text-sm font-semibold rounded-xl bg-neutral-900 text-white hover:bg-neutral-700 active:bg-neutral-950 transition-colors dark:bg-neutral-200 dark:text-neutral-950 dark:hover:bg-neutral-100 dark:active:bg-neutral-300"
          >
            Backup Wallet
          </button>
          <button
            onClick={() => setAppState('ready')}
            disabled={!backupDownloaded}
            className="w-full py-2.5 text-sm font-semibold rounded-xl border border-neutral-300 text-neutral-700 hover:border-neutral-400 hover:bg-neutral-100 disabled:opacity-40 disabled:pointer-events-none transition-colors dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-500 dark:hover:bg-neutral-800"
          >
            Continue to Wallet
          </button>
        </div>
      )}

      {appState === 'ready' && walletData && (
        <div className="flex flex-col flex-1 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <img src="/tiptgreen.svg" alt="TIPT" className="w-7 h-7" />
              <h1 className="text-lg font-bold text-neutral-900 dark:text-neutral-200">WALLET</h1>
              {/* <h1 className="text-lg font-bold text-neutral-900 dark:text-neutral-400">| WALLET</h1> */}
            </div>
            <div className="relative" ref={settingsMenuRef}>
              <>
                <button
                  onClick={() => setShowSettingsMenu((v) => !v)}
                  title="Settings"
                  className="p-1.5 rounded-lg text-neutral-500 hover:text-neutral-900 hover:bg-neutral-200 transition-colors dark:text-neutral-400 dark:hover:text-neutral-100 dark:hover:bg-neutral-800"
                >
                  <FaGear className="w-4 h-4" />
                </button>
                {showSettingsMenu && (
                  <div className="absolute right-0 top-9 z-10 min-w-30 p-2 rounded-lg bg-white border border-neutral-200 shadow-sm dark:bg-neutral-900 dark:border-neutral-800">
                    <div className="flex flex-col items-start gap-1">
                      <button
                        onClick={() => {
                          downloadBackupFile();
                          setShowSettingsMenu(false);
                        }}
                        className="text-xs text-neutral-700 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-white"
                      >
                        Backup Wallet
                      </button>
                      <button
                        onClick={() => {
                          void handleDeleteWalletAndReset();
                        }}
                        className="text-xs text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                      >
                        Delete Wallet
                      </button>
                    </div>
                  </div>
                )}
              </>
            </div>
          </div>

          <>
            <div className="px-4 py-3 rounded-xl bg-neutral-100 dark:bg-neutral-900">
              <div>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">BALANCE</p>
              </div>
              <div>
                {usdPrimary ? (
                      <>
                        <p className={`mb-2 text-5xl leading-none font-bold transition-colors duration-300 ${balanceFlash ? 'text-green-500' : 'text-neutral-900 dark:text-neutral-200'}`}>
                          <span className="text-neutral-500">$</span>{usdDisplay}
                        </p>
                        <div className="flex items-center gap-0.5">
                          <p className="text-xs leading-none text-neutral-600 dark:text-neutral-400">
                            &#8383;{satsDisplay}
                          </p>
                          <button
                            onClick={() => setUsdPrimary((v) => !v)}
                            title="Switch primary balance"
                            className="p-0.5 rounded-md text-neutral-500 hover:text-neutral-900 hover:bg-neutral-200 transition-colors dark:text-neutral-400 dark:hover:text-neutral-100 dark:hover:bg-neutral-800"
                          >
                            <FaRightLeft className="w-3 h-3 rotate-90" />
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className={`mb-2 text-5xl leading-none font-bold transition-colors duration-300 ${balanceFlash ? 'text-green-500' : 'text-neutral-900 dark:text-neutral-200'}`}>
                          <span className="text-neutral-500">&#8383;</span>{satsDisplay}
                        </div>
                        <div className="flex items-center gap-0.5">
                          <p className="text-xs leading-none text-neutral-600 dark:text-neutral-400">
                            ${usdDisplay} USD
                          </p>
                          <button
                            onClick={() => setUsdPrimary((v) => !v)}
                            title="Switch primary balance"
                            className="p-0.5 rounded-md text-neutral-500 hover:text-neutral-900 hover:bg-neutral-200 transition-colors dark:text-neutral-400 dark:hover:text-neutral-100 dark:hover:bg-neutral-800"
                          >
                            <FaRightLeft className="w-3 h-3 rotate-90" />
                          </button>
                        </div>
                      </>
                    )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={handleSend}
                className={`p-3 rounded-xl border flex flex-col items-center gap-2 transition-colors ${activePanel === 'send' ? 'bg-neutral-200 border-neutral-400 text-neutral-900 dark:bg-neutral-700 dark:border-neutral-500 dark:text-neutral-100' : 'bg-neutral-100 border-transparent text-neutral-500 hover:border-neutral-300 hover:text-neutral-800 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:border-neutral-700 dark:hover:text-neutral-200'}`}
              >
                <span className="text-md font-semibold">Send</span>
              </button>
              <button
                onClick={handleReceive}
                className={`p-3 rounded-xl border flex flex-col items-center gap-2 transition-colors ${activePanel === 'receive' ? 'bg-neutral-200 border-neutral-400 text-neutral-900 dark:bg-neutral-700 dark:border-neutral-500 dark:text-neutral-100' : 'bg-neutral-100 border-transparent text-neutral-500 hover:border-neutral-300 hover:text-neutral-800 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:border-neutral-700 dark:hover:text-neutral-200'}`}
              >
                <span className="text-md font-semibold">Receive</span>
              </button>
            </div>

            {!activePanel && (
            <div className="flex flex-col flex-1 rounded-xl bg-neutral-100 border border-neutral-200 dark:bg-neutral-900 dark:border-neutral-800 overflow-hidden">
              <div className="flex items-center justify-between px-3 pt-3 mb-2">
                <p className="text-xs text-neutral-500 dark:text-neutral-400">RECENT ACTIVITY</p>
                {recentTransfers.length > 4 && (
                  <button
                    onClick={() => setShowAllTransfers(!showAllTransfers)}
                    className="text-xs font-medium text-neutral-600 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
                  >
                    {showAllTransfers ? 'Show Less' : 'See All'}
                  </button>
                )}
              </div>

              {transfersError && (
                <p className="text-xs text-neutral-500 dark:text-neutral-400 px-3 pb-3">{transfersError}</p>
              )}

              {!transfersError && !loadingTransfers && recentTransfers.length === 0 && (
                <p className="text-xs text-neutral-500 dark:text-neutral-400 px-3 pb-3">No transfers yet.</p>
              )}

              {!transfersError && recentTransfers.length > 0 && (
                <div className="flex-1 overflow-y-auto pb-3">
                  {groupTransfersByDay(recentTransfers.slice(0, showAllTransfers ? undefined : 4)).map((group) => (
                    <div key={group.day}>
                      <p className="text-xs font-semibold text-neutral-700 dark:text-neutral-300 px-3 py-1 bg-neutral-200/60 dark:bg-neutral-800">{group.day}</p>
                      <div className="divide-y divide-neutral-200 dark:divide-neutral-800 px-3">
                        {group.transfers.map((transfer, index) => {
                          const id = getTransferString(transfer, ['id', 'transferSparkId', 'paymentId']) ?? `transfer-${index}`;
                          const isIncoming = (transfer.transferDirection === 'INCOMING' || transfer.transferDirection === 'incoming');

                          return (
                            <div key={`${id}-${index}`} className="py-2 flex items-center justify-between">
                              <div>
                                <p className={`text-xs font-medium ${isIncoming ? 'text-green-600 dark:text-green-400' : 'text-neutral-600 dark:text-neutral-400'}`}>{isIncoming ? 'Received' : 'Sent'}</p>
                                <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">{getTransferTimeLabel(transfer)}</p>
                              </div>
                              <p className={`text-sm font-semibold ${isIncoming ? 'text-green-600 dark:text-green-400' : 'text-neutral-700 dark:text-neutral-200'}`}><span className="text-neutral-500">&#8383;</span>{getTransferAmountSatsLabel(transfer).replace(/^₿/, '')}</p>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            )}

          </>

          {activePanel === 'send' && (
            <div className="space-y-3">
              {/* <p className="text-xs font-semibold text-neutral-800 dark:text-neutral-200">Send via Lightning Address / LNURL</p> */}

              {(sendStep === 'input' || sendStep === 'amount') && (
                <div className="space-y-2">
                  <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-2">
                    <label className="text-xs text-neutral-400 whitespace-nowrap">Recipient</label>
                    <input
                      type="text"
                      value={sendInput}
                      onChange={(e) => {
                        setSendInput(e.target.value);
                        if (e.target.value.trim() !== resolvedInput) {
                          setLnurlPayInfo(null);
                          setSendAmountSats('');
                          setSendError(null);
                          setIsSendMax(false);
                        }
                      }}
                      onKeyDown={(e) => e.key === 'Enter' && sendInput.trim() && handleSendPayment()}
                      placeholder="austinvach@cash.app"
                      className="min-w-0 px-3 py-2 rounded-lg bg-white border border-neutral-300 text-xs text-neutral-800 placeholder-neutral-400 focus:outline-none focus:border-neutral-500/50 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-200 dark:placeholder-neutral-600 dark:focus:border-neutral-400/50"
                    />
                    <label className="text-xs text-neutral-400 whitespace-nowrap">Amount</label>
                    <div className="flex gap-2 min-w-0">
                      <input
                        type="number"
                        min="1"
                        value={sendAmountSats}
                        onChange={(e) => { setSendAmountSats(e.target.value); setIsSendMax(false); }}
                        className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-white border border-neutral-300 text-xs text-neutral-800 focus:outline-none focus:border-neutral-500/50 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-200 dark:focus:border-neutral-400/50"
                      />
                      {walletData && Number(walletData.balanceSats) > 0 && (
                        <button
                          onClick={() => { setSendAmountSats(String(walletData.balanceSats)); setIsSendMax(true); }}
                          className="px-3 py-2 text-xs font-semibold rounded-lg border border-neutral-300 text-neutral-500 hover:border-neutral-400 hover:text-neutral-800 transition-colors dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-600 dark:hover:text-neutral-200 whitespace-nowrap"
                        >
                          Send Max
                        </button>
                      )}
                    </div>
                  </div>
                  {sendError && <p className="text-xs text-neutral-500 dark:text-neutral-400">{sendError}</p>}
                  <button
                    onClick={handleSendPayment}
                    disabled={!sendInput.trim() || resolving}
                    className="w-full py-2 text-xs font-semibold rounded-lg bg-neutral-900 text-white hover:bg-neutral-700 disabled:opacity-40 disabled:pointer-events-none transition-colors dark:bg-neutral-200 dark:text-neutral-950 dark:hover:bg-neutral-100 flex items-center justify-center gap-2"
                  >
                    {resolving ? <><Spinner className="w-3 h-3" /> {lnurlPayInfo ? 'Getting fee…' : 'Resolving…'}</> : 'Review & Pay'}
                  </button>
                </div>
              )}

              {sendStep === 'confirm' && (
                <div className="space-y-3">
                  <div className="p-3 rounded-lg bg-neutral-100 border border-neutral-200 space-y-2 dark:bg-neutral-800/50 dark:border-neutral-700">
                    <div className="flex justify-between text-xs">
                      <span className="text-neutral-500 dark:text-neutral-400">Amount</span>
                      <span className="font-medium text-neutral-800 dark:text-neutral-200">{sendAmountSats} sats</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-neutral-500 dark:text-neutral-400">Network fee</span>
                      <span className="font-medium text-neutral-800 dark:text-neutral-200">{feeEstimateSats !== null ? `≤ ${feeEstimateSats} sats` : '—'}</span>
                    </div>
                    <div className="border-t border-neutral-300 dark:border-neutral-600 pt-2 flex justify-between text-xs font-semibold">
                      <span className="text-neutral-600 dark:text-neutral-300">Total deducted</span>
                      <span className="text-neutral-900 dark:text-neutral-100">
                        {feeEstimateSats !== null
                          ? `≤ ${parseInt(sendAmountSats, 10) + feeEstimateSats} sats`
                          : `${sendAmountSats} sats`}
                      </span>
                    </div>
                  </div>
                  {sendError && <p className="text-xs text-neutral-500 dark:text-neutral-400">{sendError}</p>}
                  <button
                    onClick={handleConfirmPayment}
                    className="w-full py-2 text-xs font-semibold rounded-lg bg-neutral-900 text-white hover:bg-neutral-700 transition-colors dark:bg-neutral-200 dark:text-neutral-950 dark:hover:bg-neutral-100"
                  >
                    Confirm & Pay
                  </button>
                  <button
                    onClick={() => { setSendStep('input'); setSendError(null); }}
                    className="w-full py-2 text-xs font-medium rounded-lg border border-neutral-300 text-neutral-500 hover:text-neutral-800 hover:border-neutral-400 transition-colors dark:border-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200 dark:hover:border-neutral-600"
                  >
                    Back
                  </button>
                </div>
              )}

              {sendStep === 'sending' && (
                <div className="flex items-center justify-center py-4 gap-2 text-neutral-400">
                  <Spinner className="w-4 h-4 text-neutral-400" />
                  <span className="text-xs">Sending payment...</span>
                </div>
              )}

              {sendStep === 'success' && (
                <div className="space-y-2">
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-neutral-100 border border-neutral-300 dark:bg-neutral-800/50 dark:border-neutral-600/50">
                    <div className="w-7 h-7 rounded-full bg-neutral-200 flex items-center justify-center shrink-0 dark:bg-neutral-700">
                      <svg className="w-3.5 h-3.5 text-neutral-600 dark:text-neutral-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-neutral-800 dark:text-neutral-200">Payment sent!</p>
                      {sendTxId && <p className="text-xs text-neutral-500 font-mono break-all mt-0.5">{sendTxId}</p>}
                    </div>
                  </div>
                  <button onClick={handleSend} className="w-full py-2 text-xs font-medium rounded-lg border border-neutral-300 text-neutral-500 hover:text-neutral-800 hover:border-neutral-400 transition-colors dark:border-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200 dark:hover:border-neutral-600">
                    Send another
                  </button>
                </div>
              )}

              {sendStep === 'error' && (
                <div className="space-y-2">
                  <div className="p-3 rounded-lg bg-neutral-100 border border-neutral-300 text-neutral-600 text-xs dark:bg-neutral-800/50 dark:border-neutral-600/30 dark:text-neutral-400">{sendError}</div>
                  <button onClick={() => { setSendStep('input'); setSendError(null); }} className="w-full py-2 text-xs font-medium rounded-lg border border-neutral-300 text-neutral-500 hover:text-neutral-800 hover:border-neutral-400 transition-colors dark:border-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200 dark:hover:border-neutral-600">
                    Try Again
                  </button>
                </div>
              )}
            </div>
          )}

          {activePanel === 'receive' && (
            <div className="space-y-3">
              {fetchingInvoice ? (
                <div className="flex items-center justify-center py-8 gap-2 text-neutral-500">
                  <Spinner className="w-4 h-4 text-neutral-400" />
                  <span className="text-xs">Generating invoice...</span>
                </div>
              ) : invoice ? (
                <>
                  <div className="w-full">
                    <button
                      onClick={() => {
                        void navigator.clipboard.writeText(invoice).then(() => {
                          setInvoiceCopied(true);
                          setTimeout(() => setInvoiceCopied(false), 1600);
                        });
                      }}
                      title="Copy invoice"
                      className="w-full p-3 bg-white rounded-xl block"
                    >
                      <QRCodeSVG value={invoice} size={256} level="M" style={{ width: '100%', height: 'auto', display: 'block' }} />
                    </button>
                  </div>
                  <p className="text-xs text-neutral-600 text-center">{invoiceCopied ? 'Copied to clipboard.' : 'Tap QR to copy invoice.'}</p>
                </>
              ) : (
                <p className="text-xs text-neutral-500 text-center">Failed to generate invoice. Close and reopen Receive.</p>
              )}
            </div>
          )}


        </div>
      )}
    </div>
  );
}
