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
  | 'ready'
  | 'error';

type PinSetupStep = 'enter' | 'confirm';
type ActivePanel = 'send' | 'receive' | null;
type SendStep = 'input' | 'amount' | 'sending' | 'success' | 'error';
type PendingWalletAction =
  | { type: 'create' }
  | { type: 'recover'; mnemonic: string }
  | null;

interface WalletData {
  wallet: SparkWallet;
  mnemonic: string;
  balanceSats: bigint;
  recovered: boolean;
}

type WalletTransfer = Record<string, unknown>;

const PIN_KEY = 'spark_pin';
const WALLET_KEY = 'spark_wallet';
const SENTINEL = 'spark_wallet_v1';
const PIN_LENGTH = 4;

function getMaxFeeSats(amountSats: number) {
  return Math.max(10, Math.ceil(amountSats * 0.01));
}

function getMaxSpendableSats(balanceSats: number) {
  if (balanceSats <= 10) return 0;

  let candidate = Math.max(0, Math.floor((balanceSats * 100) / 101));
  candidate = Math.min(candidate, balanceSats - 10);

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

function getTransferDateLabel(transfer: WalletTransfer) {
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

  if (date && !Number.isNaN(date.getTime())) {
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  return 'Time unavailable';
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
  const r0 = useRef<HTMLInputElement>(null);
  const r1 = useRef<HTMLInputElement>(null);
  const r2 = useRef<HTMLInputElement>(null);
  const r3 = useRef<HTMLInputElement>(null);
  const refs = [r0, r1, r2, r3];
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
          className="w-10 h-12 text-center text-lg font-mono rounded-lg border border-neutral-300 bg-neutral-100 text-neutral-900 focus:outline-none focus:border-neutral-500 disabled:opacity-50 caret-transparent dark:border-gray-700 dark:bg-neutral-800 dark:text-white dark:focus:border-neutral-400"
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

  const [activePanel, setActivePanel] = useState<ActivePanel>(null);
  const [invoice, setInvoice] = useState<string | null>(null);
  const [fetchingInvoice, setFetchingInvoice] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [sendStep, setSendStep] = useState<SendStep>('input');
  const [sendInput, setSendInput] = useState('');
  const [sendAmountSats, setSendAmountSats] = useState('');
  const [lnurlPayInfo, setLnurlPayInfo] = useState<LnurlPayInfo | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [sendTxId, setSendTxId] = useState<string | null>(null);
  const [pendingWalletAction, setPendingWalletAction] = useState<PendingWalletAction>(null);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [seedCopied, setSeedCopied] = useState(false);
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

  useEffect(() => {
    const walletData = localStorage.getItem(WALLET_KEY);
    setAppState(walletData ? 'pin-lock' : 'idle');
  }, []);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  const refreshBtcUsdRate = useCallback(async () => {
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
    } catch (err) {
      setTransfersError(err instanceof Error ? err.message : 'Failed to load transfer history.');
    } finally {
      setLoadingTransfers(false);
    }
  }, []);

  const startPolling = useCallback((wallet: SparkWallet) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const balance = await wallet.getBalance();
        setWalletData((prev) => prev ? { ...prev, balanceSats: balance.balance } : prev);
      } catch { }
    }, 5000);
  }, []);

  const doInitWallet = async (
    mnemonicOrSeed: string | undefined,
    key: CryptoKey,
    recovered: boolean,
  ) => {
    try {
      const result = await SparkWallet.initialize({
        ...(mnemonicOrSeed ? { mnemonicOrSeed } : {}),
        options: { network: 'MAINNET' },
      });
      const wallet = result.wallet;
      const mnemonic: string = (result as unknown as { mnemonic?: string }).mnemonic ?? mnemonicOrSeed ?? '';
      const balance = await wallet.getBalance();
      const encrypted = await encryptText(key, mnemonic);
      localStorage.setItem(WALLET_KEY, JSON.stringify(encrypted));
      setWalletData({ wallet, mnemonic, balanceSats: balance.balance, recovered });
      setActivePanel(null);
      setInvoice(null);
      setAppState('ready');
      startPolling(wallet);
      void loadTransfers(wallet);
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : String(err));
      setAppState('error');
    }
  };

  const afterUnlock = useCallback(async (key: CryptoKey) => {
    const walletRaw = localStorage.getItem(WALLET_KEY);
    if (!walletRaw) { setAppState('idle'); return; }
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

  const handlePinSetupNext = (pin = pinInput) => {
    if (pin.length < PIN_LENGTH) { setPinError('PIN must be exactly 4 digits.'); return; }
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
      localStorage.setItem(PIN_KEY, JSON.stringify({ salt: bufToHex(salt), verifier }));
      setPinInput('');
      setPinConfirm('');
      setPinSetupStep('enter');
      if (pendingWalletAction?.type === 'create') {
        setPendingWalletAction(null);
        setAppState('creating');
        await doInitWallet(undefined, key, false);
      } else if (pendingWalletAction?.type === 'recover') {
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
      const pinRaw = localStorage.getItem(PIN_KEY);
      if (!pinRaw) throw new Error('No PIN stored.');
      const { salt, verifier } = JSON.parse(pinRaw);
      const key = await deriveKey(pin, hexToBuf(salt));
      const result = await decryptText(key, verifier.iv, verifier.ct);
      if (result !== SENTINEL) throw new Error('Wrong PIN.');
      setPinInput('');
      await afterUnlock(key);
    } catch {
      setPinError('Incorrect PIN. Please try again.');
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
      } catch { } finally {
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
  };

  const handleResolveLnurl = async () => {
    if (!sendInput.trim() || !walletData) return;
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
      setSendAmountSats(String(minSendableSats));
      setSendStep('amount');
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setResolving(false);
    }
  };

  const handleSendPayment = async () => {
    if (!walletData || !lnurlPayInfo) return;
    const amountSats = parseInt(sendAmountSats, 10);
    if (isNaN(amountSats) || amountSats <= 0) { setSendError('Enter a valid amount.'); return; }
    const maxSpendableSats = getMaxSpendableSats(Number(walletData.balanceSats));
    if (amountSats > maxSpendableSats) {
      setSendError(`Maximum spendable amount is ${maxSpendableSats} sats after fees.`);
      return;
    }
    const amountMsats = amountSats * 1000;
    if (amountMsats < lnurlPayInfo.minSendableMsats) {
      setSendError(`Minimum is ${Math.ceil(lnurlPayInfo.minSendableMsats / 1000)} sats.`);
      return;
    }
    if (amountMsats > lnurlPayInfo.maxSendableMsats) {
      setSendError(`Maximum is ${Math.floor(lnurlPayInfo.maxSendableMsats / 1000)} sats.`);
      return;
    }
    setSendError(null);
    setSendStep('sending');
    try {
      const bolt11 = await fetchInvoiceFromCallback(lnurlPayInfo.callback, amountMsats);
      const result = await walletData.wallet.payLightningInvoice({
        invoice: bolt11,
        maxFeeSats: getMaxFeeSats(amountSats),
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
  const minSats = lnurlPayInfo ? Math.ceil(lnurlPayInfo.minSendableMsats / 1000) : 1;
  const walletMaxSendSats = walletData ? getMaxSpendableSats(Number(walletData.balanceSats)) : undefined;
  const lnurlMaxSats = lnurlPayInfo ? Math.floor(lnurlPayInfo.maxSendableMsats / 1000) : undefined;
  const maxSats = lnurlMaxSats === undefined
    ? walletMaxSendSats
    : walletMaxSendSats === undefined
      ? lnurlMaxSats
      : Math.min(lnurlMaxSats, walletMaxSendSats);
  const amountNum = parseInt(sendAmountSats, 10);
  const amountValid = !isNaN(amountNum) && amountNum >= minSats && (maxSats === undefined || amountNum <= maxSats);
  const usdBalance = walletData && btcUsdRate !== null
    ? (Number(walletData.balanceSats) / 100000000) * btcUsdRate
    : null;
  const satsDisplay = walletData ? walletData.balanceSats.toLocaleString('en-US') : '--';
  const usdDisplay = usdBalance === null
    ? '--'
    : usdBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="w-[324px] max-h-[600px] overflow-y-auto bg-white text-neutral-900 flex flex-col p-4 dark:bg-neutral-950 dark:text-neutral-100">

      {['creating', 'recovering', 'error'].includes(appState) && (
        <div className="mb-5">
          <h1 className="text-lg font-bold text-neutral-900 dark:text-white">BITCOIN BALANCE</h1>
          <p className="text-neutral-500 text-xs">the instant payment toolkit</p>
        </div>
      )}

      {appState === 'initializing' && (
        <div className="flex flex-col items-center gap-4 py-8">
          <img src="/asterisk.png" alt="TIPT" className="w-12 h-12" />
          <Spinner className="w-6 h-6 text-neutral-400" />
        </div>
      )}

      {appState === 'pin-setup' && (
        <div className="space-y-4 p-4">
          <div className="text-center">
            <img src="/asterisk.png" alt="TIPT" className="w-10 h-10 mx-auto mb-3" />
            <h2 className="text-sm font-semibold text-neutral-900 dark:text-white">
              {pinSetupStep === 'enter' ? 'Create a PIN' : 'Confirm your PIN'}
            </h2>
            <p className="text-xs text-neutral-500 mt-1">
              {pinSetupStep === 'enter' ? 'Choose a 4-digit PIN for your new wallet.' : 'Re-enter your PIN to confirm.'}
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
          {pinSetupStep === 'confirm' && (
            <button onClick={() => { setPinSetupStep('enter'); setPinConfirm(''); setPinError(null); }} className="w-full text-center text-xs text-neutral-600 hover:text-neutral-400 transition-colors">
              Back
            </button>
          )}
        </div>
      )}

      {appState === 'pin-lock' && (
        <div className="space-y-4 p-4">
          <div className="text-center">
            <img src="/asterisk.png" alt="TIPT" className="w-10 h-10 mx-auto mb-3" />
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
        <div className="flex justify-center py-6">
          <div className="inline-flex items-center gap-3 px-5 py-3 rounded-xl bg-neutral-100 border border-neutral-200 dark:bg-neutral-900 dark:border-gray-800">
            <Spinner className="w-5 h-5 text-neutral-400" />
            <span className="text-neutral-300 text-sm">{appState === 'recovering' ? 'Recovering wallet...' : 'Creating wallet...'}</span>
          </div>
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
        <div className="space-y-4 py-6">
          <img src="/asterisk.png" alt="TIPT" className="w-14 h-14 mx-auto" />
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
              <button onClick={() => setShowRecover(true)} className="w-full py-2.5 text-sm font-semibold rounded-xl border border-neutral-300 text-neutral-700 hover:border-neutral-400 hover:bg-neutral-100 transition-colors dark:border-gray-700 dark:text-neutral-200 dark:hover:border-gray-500 dark:hover:bg-neutral-800">
                Recover Wallet
              </button>
              <a href="#" onClick={(e) => e.preventDefault()} className="block w-full text-center text-xs text-neutral-500 hover:text-neutral-900 underline underline-offset-2 transition-colors dark:text-neutral-600 dark:hover:text-neutral-100">
                Setup Instructions
              </a>
            </>
          ) : (
            <div className="space-y-3">
              <textarea
                value={recoverInput}
                onChange={(e) => setRecoverInput(e.target.value)}
                placeholder="Enter your 12 or 24 word recovery phrase..."
                rows={3}
                className="w-full px-3 py-2 rounded-lg bg-white border border-neutral-300 text-xs text-neutral-800 placeholder-neutral-400 font-mono resize-none focus:outline-none focus:border-neutral-500/50 dark:bg-neutral-800 dark:border-gray-700 dark:text-neutral-400 dark:placeholder-neutral-600 dark:focus:border-neutral-400/50"
              />
              <div className="flex gap-2">
                <button onClick={() => { setShowRecover(false); setRecoverInput(''); }} className="flex-1 py-2 text-xs font-medium rounded-lg border border-neutral-300 text-neutral-500 hover:border-neutral-400 hover:text-neutral-800 transition-colors dark:border-gray-700 dark:text-neutral-400 dark:hover:border-gray-600 dark:hover:text-neutral-200">
                  Cancel
                </button>
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
                  className="flex-1 py-2 text-xs font-semibold rounded-lg bg-neutral-900 text-white hover:bg-neutral-700 disabled:opacity-40 disabled:pointer-events-none transition-colors dark:bg-neutral-200 dark:text-neutral-950 dark:hover:bg-neutral-100"
                >
                  Recover
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {appState === 'ready' && walletData && (
        <div className="flex flex-col flex-1 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <img src="/asterisk.png" alt="TIPT" className="w-7 h-7" />
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
                  <div className="absolute right-0 top-9 z-10 min-w-[120px] p-2 rounded-lg bg-white border border-neutral-200 shadow-sm dark:bg-neutral-900 dark:border-gray-800">
                    <div className="flex flex-col items-start gap-1">
                      <button
                        onClick={() => {
                          if (walletData) {
                            void navigator.clipboard.writeText(walletData.mnemonic).then(() => {
                              setSeedCopied(true);
                              setTimeout(() => setSeedCopied(false), 2000);
                            });
                          }
                          setShowSettingsMenu(false);
                        }}
                        className="text-xs text-neutral-700 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-white"
                      >
                        {seedCopied ? 'Copied!' : 'Copy Recovery Seed'}
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
                <p className="text-xs text-neutral-500 dark:text-neutral-400">Balance</p>
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
                className={`p-3 rounded-xl border flex flex-col items-center gap-2 transition-colors ${activePanel === 'send' ? 'bg-neutral-200 border-neutral-400 text-neutral-900 dark:bg-neutral-700 dark:border-neutral-500 dark:text-neutral-100' : 'bg-neutral-100 border-neutral-200 text-neutral-500 hover:border-neutral-300 hover:text-neutral-800 dark:bg-neutral-900 dark:border-gray-800 dark:text-neutral-400 dark:hover:border-gray-700 dark:hover:text-neutral-200'}`}
              >
                <span className="text-md font-semibold">Send</span>
              </button>
              <button
                onClick={handleReceive}
                className={`p-3 rounded-xl border flex flex-col items-center gap-2 transition-colors ${activePanel === 'receive' ? 'bg-neutral-200 border-neutral-400 text-neutral-900 dark:bg-neutral-700 dark:border-neutral-500 dark:text-neutral-100' : 'bg-neutral-100 border-neutral-200 text-neutral-500 hover:border-neutral-300 hover:text-neutral-800 dark:bg-neutral-900 dark:border-gray-800 dark:text-neutral-400 dark:hover:border-gray-700 dark:hover:text-neutral-200'}`}
              >
                <span className="text-md font-semibold">Receive</span>
              </button>
            </div>

            {!activePanel && (
            <div className="flex flex-col flex-1 p-3 rounded-xl bg-neutral-100 border border-neutral-200 dark:bg-neutral-900 dark:border-gray-800">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-neutral-500 dark:text-neutral-400">Recent Activity</p>
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
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{transfersError}</p>
              )}

              {!transfersError && !loadingTransfers && recentTransfers.length === 0 && (
                <p className="text-xs text-neutral-500 dark:text-neutral-400">No transfers yet.</p>
              )}

              {!transfersError && recentTransfers.length > 0 && (
                <>
                  <div className="flex-1 space-y-1 overflow-y-auto pr-1">
                    {recentTransfers.slice(0, showAllTransfers ? undefined : 4).map((transfer, index) => {
                      const id = getTransferString(transfer, ['id', 'transferSparkId', 'paymentId']) ?? `transfer-${index}`;
                      const isIncoming = (transfer.transferDirection === 'INCOMING' || transfer.transferDirection === 'incoming');

                      return (
                        <div key={`${id}-${index}`} className="p-2 rounded-lg bg-white border border-neutral-200 dark:bg-neutral-800 dark:border-gray-700">
                          <p className={`text-[11px] font-semibold ${isIncoming ? 'text-green-600 dark:text-green-400' : 'text-neutral-700 dark:text-neutral-200'}`}>{getTransferAmountSatsLabel(transfer)}</p>
                          <p className="text-[10px] text-neutral-500 dark:text-neutral-400 mt-0.5">{getTransferDateLabel(transfer)}</p>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
            )}

          </>

          {activePanel === 'send' && (
            <div className="p-4 rounded-xl bg-neutral-100 border border-neutral-200 space-y-3 dark:bg-neutral-900 dark:border-gray-800">
              {/* <p className="text-xs font-semibold text-neutral-800 dark:text-neutral-200">Send via Lightning Address / LNURL</p> */}

              {sendStep === 'input' && (
                <div className="space-y-2">
                  <input
                    type="text"
                    value={sendInput}
                    onChange={(e) => setSendInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && sendInput.trim() && handleResolveLnurl()}
                    placeholder="Lightning Address (e.g. austinv@strike.me)"
                    className="w-full px-3 py-2 rounded-lg bg-white border border-neutral-300 text-xs text-neutral-800 placeholder-neutral-400 focus:outline-none focus:border-neutral-500/50 dark:bg-neutral-800 dark:border-gray-700 dark:text-neutral-200 dark:placeholder-neutral-600 dark:focus:border-neutral-400/50"
                  />
                  {sendError && <p className="text-xs text-neutral-500 dark:text-neutral-400">{sendError}</p>}
                  <button
                    onClick={handleResolveLnurl}
                    disabled={!sendInput.trim() || resolving}
                    className="w-full py-2 text-xs font-semibold rounded-lg bg-neutral-900 text-white hover:bg-neutral-700 disabled:opacity-40 disabled:pointer-events-none transition-colors flex items-center justify-center gap-2 dark:bg-neutral-200 dark:text-neutral-950 dark:hover:bg-neutral-100"
                  >
                    {resolving ? (<><Spinner className="w-3.5 h-3.5" /> Resolving...</>) : 'Continue'}
                  </button>
                </div>
              )}

              {sendStep === 'amount' && lnurlPayInfo && (
                <div className="space-y-2">
                  {lnurlPayInfo.description && (
                    <div className="px-3 py-2 rounded-lg bg-neutral-100 border border-neutral-200 dark:bg-neutral-800/60 dark:border-gray-700/50">
                      <p className="text-xs text-neutral-500 mb-0.5">Paying to</p>
                      <p className="text-xs text-neutral-700 dark:text-neutral-200">{lnurlPayInfo.description}</p>
                    </div>
                  )}
                  <div>
                    <label className="block text-xs text-neutral-400 mb-1">
                      Amount (₿) <span className="text-neutral-600">min {minSats}{maxSats !== undefined ? ` · max ${maxSats}` : ''}</span>
                    </label>
                    <input
                      type="number"
                      value={sendAmountSats}
                      onChange={(e) => setSendAmountSats(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-white border border-neutral-300 text-xs text-neutral-800 focus:outline-none focus:border-neutral-500/50 dark:bg-neutral-800 dark:border-gray-700 dark:text-neutral-200 dark:focus:border-neutral-400/50"
                    />
                  </div>
                  {sendError && <p className="text-xs text-neutral-500 dark:text-neutral-400">{sendError}</p>}
                  <div className="flex gap-2">
                    <button onClick={() => { setSendStep('input'); setLnurlPayInfo(null); }} className="flex-1 py-2 text-xs font-medium rounded-lg border border-neutral-300 text-neutral-500 hover:border-neutral-400 hover:text-neutral-800 transition-colors dark:border-gray-700 dark:text-neutral-400 dark:hover:border-gray-600 dark:hover:text-neutral-200">
                      Back
                    </button>
                    <button
                      onClick={handleSendPayment}
                      disabled={!amountValid}
                      className="flex-1 py-2 text-xs font-semibold rounded-lg bg-neutral-900 text-white hover:bg-neutral-700 disabled:opacity-40 disabled:pointer-events-none transition-colors dark:bg-neutral-200 dark:text-neutral-950 dark:hover:bg-neutral-100"
                    >
                      Pay ₿{sendAmountSats}
                    </button>
                  </div>
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
                  <button onClick={handleSend} className="w-full py-2 text-xs font-medium rounded-lg border border-neutral-300 text-neutral-500 hover:text-neutral-800 hover:border-neutral-400 transition-colors dark:border-gray-700 dark:text-neutral-400 dark:hover:text-neutral-200 dark:hover:border-gray-600">
                    Send another
                  </button>
                </div>
              )}

              {sendStep === 'error' && (
                <div className="space-y-2">
                  <div className="p-3 rounded-lg bg-neutral-100 border border-neutral-300 text-neutral-600 text-xs dark:bg-neutral-800/50 dark:border-neutral-600/30 dark:text-neutral-400">{sendError}</div>
                  <button onClick={() => { setSendStep('amount'); setSendError(null); }} className="w-full py-2 text-xs font-medium rounded-lg border border-neutral-300 text-neutral-500 hover:text-neutral-800 hover:border-neutral-400 transition-colors dark:border-gray-700 dark:text-neutral-400 dark:hover:text-neutral-200 dark:hover:border-gray-600">
                    Try Again
                  </button>
                </div>
              )}
            </div>
          )}

          {activePanel === 'receive' && (
            <div className="p-4 rounded-xl bg-neutral-100 border border-neutral-200 space-y-3 dark:bg-neutral-900 dark:border-gray-800">
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
