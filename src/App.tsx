import { useState, useEffect, useRef, useCallback } from 'react'
import {
  deriveKey, encryptText, decryptText, bufToHex,
  PBKDF2_ITERATIONS_DEFAULT,
} from './crypto'
import { resolveLnurlPayInfo, fetchInvoiceFromCallback } from './lnurl'
import type { LnurlPayInfo } from './lnurl'
import { getItem, setItem, removeItem, getSynced, setItemDual, setItemsDual, removeItemDual } from './lib/storage'
import { storeUnlockKey, loadUnlockKey, clearUnlockKey } from './lib/key-store'
import { sendWalletMessage, connectWalletPort } from './lib/wallet-client'
import { MSG } from './lib/messages'
import { getMaxFeeSats, getMaxSpendableSats } from './lib/fees'
import { useBtcUsdRate } from './hooks/useBtcUsdRate'
import { scrubLegacyState } from './lib/migrate-legacy'
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
  clearPinAttempts,
  verifyPin,
} from './lib/pin-attempts'
import { InitializingScreen } from './components/InitializingScreen'
import { LoadingScreen } from './components/LoadingScreen'
import { ErrorScreen } from './components/ErrorScreen'
import { PinSetupScreen } from './components/PinSetupScreen'
import { PinLockScreen } from './components/PinLockScreen'
import { IdleScreen } from './components/IdleScreen'
import { BackupPromptScreen } from './components/BackupPromptScreen'
import { ReadyScreen } from './components/ready/ReadyScreen'
import { PinPromptModal } from './components/PinPromptModal'
import { TrustedSitesScreen } from './components/TrustedSitesScreen'

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
  | 'trusted-sites'
  | 'error';

type PinSetupStep = 'enter' | 'confirm';
type ActivePanel = 'send' | 'receive' | null;
type PendingWalletAction =
  | { type: 'create' }
  | { type: 'recover'; mnemonic: string; fromFile?: boolean }
  | null;
type PinGatedAction = 'backup' | 'delete' | null;

interface WalletData {
  mnemonic: string;
  balanceSats: bigint;
  recovered: boolean;
}

type AfterUnlockResult = 'ok' | 'no-wallet' | 'decrypt-failed';

export default function App() {
  const [appState, setAppState] = useState<AppState>('initializing');
  const [walletError, setWalletError] = useState<string | null>(null);

  const [pinInput, setPinInput] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [pinSetupStep, setPinSetupStep] = useState<PinSetupStep>('enter');
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinLoading, setPinLoading] = useState(false);

  const [walletData, setWalletData] = useState<WalletData | null>(null);
  const btcUsdRate = useBtcUsdRate();
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
  // isSendMax is a flag set by the Send panel's "MAX" button and read once
  // by handleSendPayment. Using a ref instead of state prevents an extra
  // render pass on every "MAX" press and avoids stale-closure bugs since
  // the value is consumed synchronously inside the next onClick.
  const isSendMaxRef = useRef(false);
  const setIsSendMax = useCallback((v: boolean) => { isSendMaxRef.current = v; }, []);
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
  const [pendingPinAction, setPendingPinAction] = useState<PinGatedAction>(null);

  const prevBalanceRef = useRef<bigint | null>(null);
  const activePanelRef = useRef<ActivePanel>(null);
  activePanelRef.current = activePanel;
  const cryptoKeyRef = useRef<CryptoKey | null>(null);

  const downloadBackupFile = useCallback(async (verifiedKey?: CryptoKey) => {
    let mnemonic = walletData?.mnemonic ?? '';
    if (!mnemonic) {
      const walletRaw = await getSynced(WALLET_KEY);
      // Prefer the key the caller just re-derived from a freshly-entered
      // PIN. Falling back to cryptoKeyRef means we honour the existing
      // unlocked session for non-sensitive callers, but the PIN-prompt path
      // always supplies its own key so the export is gated on knowing the
      // PIN even if the in-memory key has been compromised.
      const key = verifiedKey ?? cryptoKeyRef.current;
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

  const loadTransfers = useCallback(async () => {
    setLoadingTransfers(true);
    setTransfersError(null);
    try {
      const response = await sendWalletMessage<{
        ok: boolean;
        transfers?: unknown[];
        error?: string;
      }>({ type: MSG.GET_TRANSFERS, payload: { limit: 10, offset: 0 } });
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
    const current = walletData?.balanceSats ?? null;
    const prev = prevBalanceRef.current;
    let flashTimer: ReturnType<typeof setTimeout> | null = null;
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    if (current !== null && prev !== null && current > prev) {
      if (activePanelRef.current === 'receive') {
        setActivePanel(null);
        setInvoiceCopied(false);
        setInvoice(null);
      }
      setBalanceFlash(true);
      flashTimer = setTimeout(() => setBalanceFlash(false), 500);
    }
    prevBalanceRef.current = current;
    if (current !== null) {
      // 1.5s debounce: balance update events arrive in bursts during a
      // single payment (transfer:claimed, deposit:confirmed, getBalance
      // refresh after a send) — bumping the debounce avoids 2–3 redundant
      // getTransfers calls per real-world payment without making the
      // history feel laggy.
      reloadTimer = setTimeout(() => { void loadTransfers(); }, 1500);
    }
    return () => {
      if (flashTimer !== null) clearTimeout(flashTimer);
      if (reloadTimer !== null) clearTimeout(reloadTimer);
    };
  }, [walletData?.balanceSats, loadTransfers]);

  const doInitWallet = async (
    mnemonicOrSeed: string | undefined,
    key: CryptoKey,
    recovered: boolean,
  ) => {
    try {
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
      }>({ type: MSG.WALLET_CREATE, payload: { mnemonic: mnemonicOrSeed } });
      if (!response.ok) throw new Error(response.error ?? 'Failed to initialize wallet.');
      const mnemonic = response.mnemonic ?? mnemonicOrSeed ?? '';
      const balanceSats = BigInt(response.balanceSats ?? '0');
      const encrypted = await encryptText(key, mnemonic);
      await setItemDual(WALLET_KEY, JSON.stringify(encrypted));
      // Only stamp the in-memory key ref AFTER the ciphertext is durably on
      // disk — the ref's invariant is "points to a key whose ciphertext can
      // be decrypted next time the offscreen calls loadUnlockKey()". If we
      // stamp earlier and the setItemDual write fails, downstream callers
      // (e.g. loadTransfers's cache-write) would encrypt against a key that
      // doesn't match any persisted wallet blob.
      cryptoKeyRef.current = key;
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

  const afterUnlock = useCallback(async (key: CryptoKey): Promise<AfterUnlockResult> => {
    const walletRaw = await getSynced(WALLET_KEY);
    if (!walletRaw) { setAppState('idle'); return 'no-wallet'; }
    skipBackupRef.current = true;
    setAppState('recovering');
    try {
      const { iv, ct } = JSON.parse(walletRaw);
      const mnemonic = await decryptText(key, iv, ct);
      await doInitWallet(mnemonic, key, true);
      return 'ok';
    } catch {
      return 'decrypt-failed';
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // Best-effort cleanup of the legacy plaintext PIN entry from pre-S7
      // installs. The background's onStartup listener handles browser
      // restarts; this catches the in-session upgrade case.
      scrubLegacyState();

      const [storedWallet, cachedKey] = await Promise.all([
        getSynced(WALLET_KEY),
        loadUnlockKey(),
      ]);

      if (storedWallet && cachedKey) {
        if (cancelled) return;
        const result = await afterUnlock(cachedKey);
        if (cancelled) return;
        if (result === 'ok') return;
        // The cached key didn't match the stored wallet (e.g. the wallet
        // was rotated on another device). Wipe the stale key and fall
        // through to the lock screen so the user can re-derive a working
        // key from their PIN.
        await clearUnlockKey();
        cryptoKeyRef.current = null;
        setAppState('pin-lock');
        return;
      }

      if (!cancelled) {
        setAppState(storedWallet ? 'pin-lock' : 'idle');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [afterUnlock]);

  // Auto-reset the send panel 5s after a successful payment. We capture
  // the live `handleSend` in a ref updated each render so the effect's
  // deps stay just `[sendStep]` (we only want to re-arm the timer on
  // a step transition, not on every other re-render) without tripping
  // the exhaustive-deps lint rule.
  const handleSendRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (sendStep !== 'success') return;
    const timer = setTimeout(() => handleSendRef.current(), 5000);
    return () => clearTimeout(timer);
  }, [sendStep]);

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
      const verifyResult = await verifyPin(pin);
      if (!verifyResult.ok) {
        if (verifyResult.reason === 'locked') {
          const seconds = Math.ceil((verifyResult.lockedUntil - Date.now()) / 1000);
          setPinError(`Too many attempts. Try again in ${seconds}s.`);
        } else if (verifyResult.reason === 'no-data') {
          setPinError('Wallet found, but PIN data has not synced yet. Please try again shortly.');
        } else {
          setPinError('Incorrect PIN. Please try again.');
        }
        setPinInput('');
        return;
      }
      const { key, iterations: storedIterations } = verifyResult;
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
        const r = await sendWalletMessage<{ ok: boolean; invoice?: string; error?: string }>({
          type: MSG.CREATE_INVOICE,
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
  // Keep the ref consumed by the success-reset effect pointing at the
  // current closure (state setters from this render).
  handleSendRef.current = handleSend;

  const handleDeleteWalletAndReset = async () => {
    try {
      // Tear down the offscreen wallet first so a stale SDK instance can't
      // leak after the user has cleared their credentials.
      try {
        await sendWalletMessage({ type: MSG.DISPOSE_WALLET });
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

    if (isSendMaxRef.current) {
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
          type: MSG.GET_FEE_ESTIMATE,
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
            type: MSG.GET_FEE_ESTIMATE,
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
        type: MSG.PAY_INVOICE,
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
        type: MSG.GET_BALANCE,
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
          onBackup={() => { setPendingPinAction('backup'); }}
          onDelete={() => { setPendingPinAction('delete'); }}
          onTrustedSites={() => { setAppState('trusted-sites'); }}
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

      {appState === 'trusted-sites' && (
        <TrustedSitesScreen onBack={() => { setAppState('ready'); }} />
      )}

      {pendingPinAction && (
        <PinPromptModal
          title={pendingPinAction === 'backup' ? 'Confirm to back up' : 'Confirm wallet deletion'}
          description={pendingPinAction === 'backup'
            ? 'Re-enter your PIN to export your recovery phrase.'
            : 'Re-enter your PIN to permanently delete this wallet from this device. This cannot be undone.'}
          confirmLabel={pendingPinAction === 'backup' ? 'Back up' : 'Delete wallet'}
          destructive={pendingPinAction === 'delete'}
          onCancel={() => setPendingPinAction(null)}
          onConfirm={async (verifiedKey) => {
            const action = pendingPinAction;
            setPendingPinAction(null);
            if (action === 'backup') {
              // Thread the just-verified key through so the export uses
              // the freshly-derived key — never the cached in-memory one.
              await downloadBackupFile(verifiedKey);
            } else if (action === 'delete') {
              await handleDeleteWalletAndReset();
            }
          }}
        />
      )}
    </div>
  );
}
