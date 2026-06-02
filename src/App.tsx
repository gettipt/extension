import { useState, useEffect, useRef, useCallback } from 'react'
import {
  deriveKey, encryptText, decryptText, hexToBuf, bufToHex,
  PBKDF2_ITERATIONS_DEFAULT, PBKDF2_ITERATIONS_LEGACY,
} from './crypto'
import { resolveLnurlPayInfo, fetchInvoiceFromCallback } from './lnurl'
import type { LnurlPayInfo } from './lnurl'
import { getItem, setItem, removeItem, getSynced, setItemDual, setItemsDual, removeItemDual } from './lib/storage'
import { storeUnlockKey, loadUnlockKey, clearUnlockKey } from './lib/key-store'
import { sendWalletMessage, connectWalletPort } from './lib/wallet-client'
import { getMaxFeeSats, getMaxSpendableSats } from './lib/fees'
import type { WalletTransfer } from './lib/transfers'
import type { SendStep } from './lib/send-types'
import {
  PIN_KEY,
  WALLET_KEY,
  LEGACY_SESSION_PIN_KEY,
  SENTINEL,
  PIN_LENGTH,
  TRANSFERS_CACHE_KEY,
  PIN_ATTEMPTS_KEY,
  BTC_USD_RATE_CACHE_KEY,
} from './constants'
import {
  getPinAttempts,
  setPinAttempts,
  clearPinAttempts,
  getLockoutForAttempts,
} from './lib/pin-attempts'
import { InitializingScreen } from './components/InitializingScreen'
import { LoadingScreen } from './components/LoadingScreen'
import { ErrorScreen } from './components/ErrorScreen'
import { PinSetupScreen } from './components/PinSetupScreen'
import { PinLockScreen } from './components/PinLockScreen'
import { IdleScreen } from './components/IdleScreen'
import { BackupPromptScreen } from './components/BackupPromptScreen'
import { ReadyScreen } from './components/ready/ReadyScreen'

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
type PendingWalletAction =
  | { type: 'create' }
  | { type: 'recover'; mnemonic: string; fromFile?: boolean }
  | null;

interface WalletData {
  mnemonic: string;
  balanceSats: bigint;
  recovered: boolean;
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

  const downloadBackupFile = useCallback(async () => {
    let mnemonic = walletData?.mnemonic ?? '';
    if (!mnemonic) {
      const walletRaw = await getSynced(WALLET_KEY);
      const key = cryptoKeyRef.current;
      if (!walletRaw || !key) return;
      try {
        const { iv, ct } = JSON.parse(walletRaw);
        mnemonic = await decryptText(key, iv, ct);
      } catch {
        return;
      }
    }
    const blob = new Blob([mnemonic], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'TIPT-Wallet-Backup.txt';
    a.click();
    URL.revokeObjectURL(url);
  }, [walletData]);

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
    prevBalanceRef.current = current;
    if (walletData) {
      const id = setTimeout(() => { void loadTransfers(); }, 500);
      return () => clearTimeout(id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletData?.balanceSats]);

  const doInitWallet = async (
    mnemonicOrSeed: string | undefined,
    key: CryptoKey,
    recovered: boolean,
  ) => {
    try {
      cryptoKeyRef.current = key;
      const cachedTransfersPromise = (async () => {
        try {
          const cachedRaw = await getItem('local', TRANSFERS_CACHE_KEY);
          if (cachedRaw) {
            const { iv: cIv, ct: cCt } = JSON.parse(cachedRaw);
            const plain = await decryptText(key, cIv, cCt);
            const parsed = JSON.parse(plain) as WalletTransfer[];
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
          }
        } catch { /* ignore cache decryption errors */ }
        return null;
      })();
      const response = await sendWalletMessage<{
        ok: boolean;
        mnemonic?: string;
        balanceSats?: string;
        error?: string;
      }>({ type: 'TIPT_WALLET_CREATE', payload: { mnemonic: mnemonicOrSeed } });
      if (!response.ok) throw new Error(response.error ?? 'Failed to initialize wallet.');
      const mnemonic = response.mnemonic ?? mnemonicOrSeed ?? '';
      const balanceSats = BigInt(response.balanceSats ?? '0');
      const encrypted = await encryptText(key, mnemonic);
      await setItemDual(WALLET_KEY, JSON.stringify(encrypted));
      const cachedTransfers = await cachedTransfersPromise;
      if (cachedTransfers) setRecentTransfers(cachedTransfers);
      setWalletData({ mnemonic, balanceSats, recovered });
      setActivePanel(null);
      setInvoice(null);
      if (!skipBackupRef.current) {
        setBackupDownloaded(false);
        setAppState('backup-prompt');
      } else {
        setAppState('ready');
        setWalletData((prev) => prev ? { ...prev, mnemonic: '' } : prev);
      }
      void loadTransfers();
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : String(err));
      setAppState('error');
    }
  };

  const afterUnlock = useCallback(async (key: CryptoKey) => {
    const walletRaw = await getSynced(WALLET_KEY);
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
      // Best-effort cleanup of the legacy plaintext PIN entry from pre-S7
      // installs. The background's onStartup listener handles browser
      // restarts; this catches the in-session upgrade case.
      void chrome.storage.session.remove(LEGACY_SESSION_PIN_KEY).catch(() => { /* ignore */ });

      const storedWallet = await getSynced(WALLET_KEY);
      const cachedKey = await loadUnlockKey();

      if (storedWallet && cachedKey) {
        try {
          if (!cancelled) {
            await afterUnlock(cachedKey);
          }
          return;
        } catch {
          // The cached key didn't match the stored wallet (e.g. the wallet
          // was rotated on another device). Wipe the stale key and fall
          // through to the lock screen.
          await clearUnlockKey();
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

  const refreshBtcUsdRate = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', { signal });
      if (!response.ok) return;
      const data = await response.json() as { bitcoin?: { usd?: number } };
      const nextRate = data.bitcoin?.usd;
      if (typeof nextRate === 'number' && Number.isFinite(nextRate)) {
        setBtcUsdRate(nextRate);
        // Persist so the next popup open shows a number immediately instead
        // of '--' while CoinGecko is reached. We cache value + timestamp so
        // a future enhancement can decide on staleness — today we always
        // refresh on mount so the cached value is just a visual seed.
        void setItem('local', BTC_USD_RATE_CACHE_KEY, JSON.stringify({ rate: nextRate, ts: Date.now() }))
          .catch(() => { /* ignore quota errors; the price isn't critical */ });
      }
    } catch {
      // Ignore transient pricing errors and keep the last known rate.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Seed from the persisted cache so we don't render '--' on every popup
    // open while waiting for CoinGecko.
    void (async () => {
      try {
        const raw = await getItem('local', BTC_USD_RATE_CACHE_KEY);
        if (cancelled || !raw) return;
        const parsed = JSON.parse(raw) as { rate?: number };
        if (typeof parsed.rate === 'number' && Number.isFinite(parsed.rate)) {
          setBtcUsdRate((prev) => prev ?? parsed.rate!);
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshBtcUsdRate(controller.signal);
    const timer = setInterval(() => {
      void refreshBtcUsdRate(controller.signal);
    }, 300000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [refreshBtcUsdRate]);

  useEffect(() => {
    if (sendStep !== 'success') return;
    const timer = setTimeout(() => handleSend(), 5000);
    return () => clearTimeout(timer);
  }, [sendStep]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadTransfers = useCallback(async () => {
    setLoadingTransfers(true);
    setTransfersError(null);
    try {
      const response = await sendWalletMessage<{
        ok: boolean;
        transfers?: unknown[];
        error?: string;
      }>({ type: 'TIPT_GET_TRANSFERS', payload: { limit: 10, offset: 0 } });
      if (!response.ok) throw new Error(response.error ?? 'Failed to load transfers.');
      const normalized = (response.transfers ?? [])
        .map((item) => (typeof item === 'object' && item !== null ? (item as WalletTransfer) : null))
        .filter((item): item is WalletTransfer => item !== null);
      setRecentTransfers(normalized);
      const key = cryptoKeyRef.current;
      if (key) {
        try {
          const encrypted = await encryptText(key, JSON.stringify(normalized));
          await setItem('local', TRANSFERS_CACHE_KEY, JSON.stringify(encrypted));
        } catch { /* ignore encryption/quota errors */ }
      }
    } catch (err) {
      setTransfersError(err instanceof Error ? err.message : 'Failed to load transfer history.');
    } finally {
      setLoadingTransfers(false);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = connectWalletPort((event) => {
      setWalletData((prev) => (prev ? { ...prev, balanceSats: BigInt(event.balance) } : prev));
    });
    return () => unsubscribe();
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
      const iterations = PBKDF2_ITERATIONS_DEFAULT;
      const key = await deriveKey(pinInput, salt, iterations);
      const verifier = await encryptText(key, SENTINEL);
      await setItemDual(PIN_KEY, JSON.stringify({ salt: bufToHex(salt), iterations, verifier }));
      // S7: cache the non-extractable CryptoKey in shared IndexedDB so the
      // offscreen / background contexts can decrypt the wallet without the
      // PIN ever leaving this function.
      await storeUnlockKey(key);
      await clearPinAttempts();
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
      const attempts = await getPinAttempts();
      const now = Date.now();
      if (attempts.lockedUntil > now) {
        const seconds = Math.ceil((attempts.lockedUntil - now) / 1000);
        setPinError(`Too many attempts. Try again in ${seconds}s.`);
        setPinInput('');
        return;
      }
      const pinRaw = await getSynced(PIN_KEY);
      if (!pinRaw) throw new Error('PIN_NOT_FOUND');
      const { salt, verifier, iterations } = JSON.parse(pinRaw);
      const storedIterations = typeof iterations === 'number' && Number.isFinite(iterations)
        ? iterations
        : PBKDF2_ITERATIONS_LEGACY;
      const key = await deriveKey(pin, hexToBuf(salt), storedIterations);
      let result: string;
      try {
        result = await decryptText(key, verifier.iv, verifier.ct);
      } catch {
        const newCount = attempts.count + 1;
        const lockoutMs = getLockoutForAttempts(newCount);
        await setPinAttempts({ count: newCount, lockedUntil: lockoutMs ? now + lockoutMs : 0 });
        throw new Error('Wrong PIN.');
      }
      if (result !== SENTINEL) {
        const newCount = attempts.count + 1;
        const lockoutMs = getLockoutForAttempts(newCount);
        await setPinAttempts({ count: newCount, lockedUntil: lockoutMs ? now + lockoutMs : 0 });
        throw new Error('Wrong PIN.');
      }
      await clearPinAttempts();
      // S7: stash the derived AES key in shared IndexedDB. This replaces the
      // previous `chrome.storage.session.set('spark_session_pin', pin)` —
      // the raw PIN is now never persisted anywhere on disk or in
      // structured storage.
      await storeUnlockKey(key);

      // S3 + Lazy iterations migration: when an old-iterations payload is
      // detected, re-encrypt BOTH the verifier and the wallet ciphertext
      // under a new key derived at PBKDF2_ITERATIONS_DEFAULT, then commit
      // both blobs in a single chrome.storage.local.set so they can never
      // diverge. The previous implementation wrote PIN first then wallet,
      // leaving a window in which a power-loss/quota-error would brick
      // the wallet (new PIN verifier but old-key ciphertext).
      if (storedIterations < PBKDF2_ITERATIONS_DEFAULT) {
        try {
          const newSalt = crypto.getRandomValues(new Uint8Array(16));
          const newKey = await deriveKey(pin, newSalt, PBKDF2_ITERATIONS_DEFAULT);
          const newVerifier = await encryptText(newKey, SENTINEL);
          const walletRaw = await getSynced(WALLET_KEY);
          if (walletRaw) {
            const { iv: wIv, ct: wCt } = JSON.parse(walletRaw);
            const mnemonic = await decryptText(key, wIv, wCt);
            const reEnc = await encryptText(newKey, mnemonic);
            await setItemsDual({
              [WALLET_KEY]: JSON.stringify(reEnc),
              [PIN_KEY]: JSON.stringify({
                salt: bufToHex(newSalt),
                iterations: PBKDF2_ITERATIONS_DEFAULT,
                verifier: newVerifier,
              }),
            });
            await storeUnlockKey(newKey);
            setPinInput('');
            await afterUnlock(newKey);
            return;
          }
        } catch {
          // Migration best-effort; fall through with old key.
        }
      }

      setPinInput('');
      await afterUnlock(key);
    } catch (err) {
      setPinError(
        err instanceof Error && err.message === 'PIN_NOT_FOUND'
          ? 'Wallet found, but PIN data has not synced yet. Please try again shortly.'
          : err instanceof Error && err.message.startsWith('Too many attempts')
            ? err.message
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
        const r = await sendWalletMessage<{ ok: boolean; invoice?: string; error?: string }>({
          type: 'TIPT_CREATE_INVOICE',
          payload: { amountSats: 0 },
        });
        if (r.ok && r.invoice) {
          setInvoice(r.invoice);
        }
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

    try {
      // Tear down the offscreen wallet first so a stale SDK instance can't
      // leak after the user has cleared their credentials.
      try {
        await sendWalletMessage({ type: 'TIPT_DISPOSE_WALLET' });
      } catch {
        // Best-effort; reset proceeds even if the offscreen document is gone.
      }

      await Promise.all([
        removeItemDual(PIN_KEY),
        removeItemDual(WALLET_KEY),
        removeItem('local', TRANSFERS_CACHE_KEY),
        removeItem('local', PIN_ATTEMPTS_KEY),
        removeItem('local', BTC_USD_RATE_CACHE_KEY),
        removeItem('session', LEGACY_SESSION_PIN_KEY),
        clearUnlockKey(),
      ]);

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
        const feeResponse = await sendWalletMessage<{ ok: boolean; feeSats?: number; error?: string }>({
          type: 'TIPT_GET_FEE_ESTIMATE',
          payload: { encodedInvoice: bolt11 },
        });
        fee = feeResponse.ok && feeResponse.feeSats !== undefined ? feeResponse.feeSats : getMaxFeeSats(effectiveAmountSats);
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
          const feeResponse2 = await sendWalletMessage<{ ok: boolean; feeSats?: number; error?: string }>({
            type: 'TIPT_GET_FEE_ESTIMATE',
            payload: { encodedInvoice: bolt11 },
          });
          fee = feeResponse2.ok && feeResponse2.feeSats !== undefined ? feeResponse2.feeSats : safeFee;
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
    if (!pendingBolt11) return;
    setSendStep('sending');
    try {
      // Double the SDK's fee estimate to give the router headroom — the
      // estimate is a best-guess and the actual route can cost more.
      const maxFeeSats = feeEstimateSats !== null
        ? Math.max(Math.ceil(feeEstimateSats * 2), getMaxFeeSats(parseInt(sendAmountSats, 10)))
        : getMaxFeeSats(parseInt(sendAmountSats, 10));
      // S7: only the encrypted wallet blob is shipped to the offscreen —
      // the PIN no longer crosses the IPC boundary. The offscreen pulls
      // the AES key from shared IndexedDB if it needs to re-initialise.
      const walletRaw = await getSynced(WALLET_KEY);
      const result = await sendWalletMessage<{ ok: boolean; txId?: string; error?: string }>({
        type: 'TIPT_PAY_INVOICE',
        payload: {
          invoice: pendingBolt11,
          maxFeeSats,
          walletRaw: walletRaw ?? undefined,
        },
      });
      if (!result.ok) throw new Error(result.error ?? 'Payment failed.');
      setSendTxId(result.txId ?? null);
      setSendStep('success');
      const balResponse = await sendWalletMessage<{ ok: boolean; balance?: string; error?: string }>({
        type: 'TIPT_GET_BALANCE',
      });
      if (balResponse.ok && balResponse.balance !== undefined) {
        setWalletData((prev) => (prev ? { ...prev, balanceSats: BigInt(balResponse.balance!) } : prev));
      }
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

  const handleInvoiceCopy = (inv: string) => {
    void navigator.clipboard.writeText(inv).then(() => {
      setInvoiceCopied(true);
      setTimeout(() => setInvoiceCopied(false), 1600);
    });
  };

  return (
    <div className="w-81 max-h-150 overflow-y-auto bg-white text-neutral-900 flex flex-col p-4 dark:bg-neutral-950 dark:text-neutral-100">

      {appState === 'initializing' && <InitializingScreen />}

      {appState === 'pin-setup' && (
        <PinSetupScreen
          pinSetupStep={pinSetupStep}
          pinInput={pinInput}
          pinConfirm={pinConfirm}
          pinError={pinError}
          pinLoading={pinLoading}
          onPinInputChange={setPinInput}
          onPinConfirmChange={setPinConfirm}
          onNext={handlePinSetupNext}
          onConfirm={(pin) => { void handlePinSetupConfirm(pin); }}
          onBack={() => { setPinSetupStep('enter'); setPinConfirm(''); setPinError(null); }}
          onCancel={() => { setPendingWalletAction(null); setPinInput(''); setPinError(null); setAppState('idle'); }}
        />
      )}

      {appState === 'pin-lock' && (
        <PinLockScreen
          pinInput={pinInput}
          pinError={pinError}
          pinLoading={pinLoading}
          onPinChange={setPinInput}
          onUnlock={(pin) => { void handlePinUnlock(pin); }}
        />
      )}

      {isLoading && (
        <LoadingScreen mode={appState === 'recovering' ? 'recovering' : 'creating'} />
      )}

      {appState === 'error' && (
        <ErrorScreen error={walletError} onReset={() => setAppState('idle')} />
      )}

      {appState === 'idle' && (
        <IdleScreen
          showRecover={showRecover}
          recoverInput={recoverInput}
          onRecoverInputChange={setRecoverInput}
          onCreateWallet={() => {
            setPendingWalletAction({ type: 'create' });
            setPinInput('');
            setPinConfirm('');
            setPinError(null);
            setPinSetupStep('enter');
            setAppState('pin-setup');
          }}
          onShowRecover={() => setShowRecover(true)}
          onRecoverWithText={(mnemonic) => {
            setPendingWalletAction({ type: 'recover', mnemonic });
            setShowRecover(false);
            setRecoverInput('');
            setPinInput('');
            setPinConfirm('');
            setPinError(null);
            setPinSetupStep('enter');
            setAppState('pin-setup');
          }}
          onRecoverWithFile={(mnemonic) => {
            setPendingWalletAction({ type: 'recover', mnemonic, fromFile: true });
            setShowRecover(false);
            setRecoverInput('');
            setPinInput('');
            setPinConfirm('');
            setPinError(null);
            setPinSetupStep('enter');
            setAppState('pin-setup');
          }}
          onCancelRecover={() => { setShowRecover(false); setRecoverInput(''); }}
        />
      )}

      {appState === 'backup-prompt' && walletData && (
        <BackupPromptScreen
          backupDownloaded={backupDownloaded}
          onDownload={() => {
            void downloadBackupFile();
            setBackupDownloaded(true);
          }}
          onContinue={() => {
            setAppState('ready');
            setWalletData((prev) => prev ? { ...prev, mnemonic: '' } : prev);
          }}
        />
      )}

      {appState === 'ready' && walletData && (
        <ReadyScreen
          onBackup={() => { void downloadBackupFile(); }}
          onDelete={() => { void handleDeleteWalletAndReset(); }}
          satsDisplay={satsDisplay}
          usdDisplay={usdDisplay}
          usdPrimary={usdPrimary}
          balanceFlash={balanceFlash}
          onToggleUsdPrimary={() => setUsdPrimary((v) => !v)}
          activePanel={activePanel}
          onSendClick={handleSend}
          onReceiveClick={() => { void handleReceive(); }}
          recentTransfers={recentTransfers}
          loadingTransfers={loadingTransfers}
          transfersError={transfersError}
          showAllTransfers={showAllTransfers}
          onToggleShowAllTransfers={() => setShowAllTransfers(!showAllTransfers)}
          btcUsdRate={btcUsdRate}
          sendState={{
            sendStep,
            sendInput,
            resolvedInput,
            sendAmountSats,
            lnurlPayInfo,
            sendError,
            resolving,
            sendTxId,
            feeEstimateSats,
            balanceSats: walletData.balanceSats,
          }}
          sendSetters={{
            setSendInput,
            setSendAmountSats,
            setIsSendMax,
            setSendError,
            setLnurlPayInfo,
            setSendStep,
          }}
          onSendSubmit={() => { void handleSendPayment(); }}
          onSendConfirm={() => { void handleConfirmPayment(); }}
          invoice={invoice}
          fetchingInvoice={fetchingInvoice}
          invoiceCopied={invoiceCopied}
          onInvoiceCopy={handleInvoiceCopy}
        />
      )}
    </div>
  );
}
