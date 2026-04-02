import { useState, useEffect, useRef, useCallback } from 'react'
import { SparkWallet } from '@buildonspark/spark-sdk'
import { QRCodeSVG } from 'qrcode.react'
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

interface WalletData {
  wallet: SparkWallet;
  mnemonic: string;
  balanceSats: bigint;
  recovered: boolean;
}

const PIN_KEY = 'spark_pin';
const WALLET_KEY = 'spark_wallet';
const SENTINEL = 'spark_wallet_v1';

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
  onSubmit?: () => void;
  disabled?: boolean;
}) {
  const r0 = useRef<HTMLInputElement>(null);
  const r1 = useRef<HTMLInputElement>(null);
  const r2 = useRef<HTMLInputElement>(null);
  const r3 = useRef<HTMLInputElement>(null);
  const r4 = useRef<HTMLInputElement>(null);
  const r5 = useRef<HTMLInputElement>(null);
  const refs = [r0, r1, r2, r3, r4, r5];
  const digits = value.split('').concat(Array(6).fill('')).slice(0, 6);

  const handleKey = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      const next = value.slice(0, i > 0 && digits[i] === '' ? i - 1 : i);
      onChange(next);
      refs[Math.max(0, digits[i] === '' ? i - 1 : i)]?.current?.focus();
    } else if (e.key === 'Enter' && value.length === 6) {
      onSubmit?.();
    }
  };

  const handleChange = (i: number, e: React.ChangeEvent<HTMLInputElement>) => {
    const d = e.target.value.replace(/\D/g, '').slice(-1);
    if (!d) return;
    const arr = digits.slice();
    arr[i] = d;
    const next = arr.join('').slice(0, 6);
    onChange(next);
    if (i < 5) refs[i + 1]?.current?.focus();
    else if (next.length === 6) onSubmit?.();
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
          className="w-10 h-12 text-center text-lg font-mono rounded-lg border border-gray-700 bg-neutral-800 text-white focus:outline-none focus:border-orange-500 disabled:opacity-50 caret-transparent"
        />
      ))}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button
      onClick={copy}
      className="px-2 py-1 text-xs rounded border border-gray-700 text-neutral-400 hover:text-white hover:border-gray-500 transition-colors"
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

export default function App() {
  const [appState, setAppState] = useState<AppState>('initializing');
  const [walletError, setWalletError] = useState<string | null>(null);

  const [pinKey, setPinKey] = useState<CryptoKey | null>(null);
  const [pinInput, setPinInput] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [pinSetupStep, setPinSetupStep] = useState<PinSetupStep>('enter');
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinLoading, setPinLoading] = useState(false);

  const [walletData, setWalletData] = useState<WalletData | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
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

  useEffect(() => {
    const pinData = localStorage.getItem(PIN_KEY);
    setAppState(pinData ? 'pin-lock' : 'pin-setup');
  }, []);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  const startPolling = useCallback((wallet: SparkWallet) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const balance = await wallet.getBalance();
        setWalletData((prev) => prev ? { ...prev, balanceSats: balance.balance } : prev);
        setLastUpdated(new Date().toLocaleTimeString());
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
      setLastUpdated(new Date().toLocaleTimeString());
      startPolling(wallet);
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

  const handlePinSetupNext = () => {
    if (pinInput.length < 6) { setPinError('PIN must be exactly 6 digits.'); return; }
    setPinSetupStep('confirm');
    setPinConfirm('');
    setPinError(null);
  };

  const handlePinSetupConfirm = async () => {
    if (pinConfirm.length < 6) return;
    if (pinConfirm !== pinInput) {
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
      setPinKey(key);
      setPinInput('');
      setPinConfirm('');
      setPinSetupStep('enter');
      await afterUnlock(key);
    } catch {
      setPinError('Failed to set up PIN. Please try again.');
    } finally {
      setPinLoading(false);
    }
  };

  const handlePinUnlock = async () => {
    if (pinInput.length < 6) return;
    setPinLoading(true);
    setPinError(null);
    try {
      const pinRaw = localStorage.getItem(PIN_KEY);
      if (!pinRaw) throw new Error('No PIN stored.');
      const { salt, verifier } = JSON.parse(pinRaw);
      const key = await deriveKey(pinInput, hexToBuf(salt));
      const result = await decryptText(key, verifier.iv, verifier.ct);
      if (result !== SENTINEL) throw new Error('Wrong PIN.');
      setPinKey(key);
      setPinInput('');
      await afterUnlock(key);
    } catch {
      setPinError('Incorrect PIN. Please try again.');
      setPinInput('');
    } finally {
      setPinLoading(false);
    }
  };

  const initWallet = async (mnemonicOrSeed?: string) => {
    if (!pinKey) return;
    setAppState(mnemonicOrSeed ? 'recovering' : 'creating');
    setWalletError(null);
    await doInitWallet(mnemonicOrSeed, pinKey, !!mnemonicOrSeed);
  };

  const handleLock = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    setWalletData(null);
    setPinKey(null);
    setPinInput('');
    setPinError(null);
    setActivePanel(null);
    setAppState('pin-lock');
  };

  const handleReceive = async () => {
    if (activePanel === 'receive') { setActivePanel(null); return; }
    setActivePanel('receive');
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
    if (!sendInput.trim()) return;
    setResolving(true);
    setSendError(null);
    try {
      const info = await resolveLnurlPayInfo(sendInput.trim());
      setLnurlPayInfo(info);
      setSendAmountSats(String(Math.ceil(info.minSendableMsats / 1000)));
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
        maxFeeSats: Math.max(10, Math.ceil(amountSats * 0.01)),
      });
      const txId =
        'id' in result ? (result as { id: string }).id
          : 'transferSparkId' in result ? (result as { transferSparkId?: string }).transferSparkId
            : null;
      setSendTxId(txId ?? null);
      setSendStep('success');
      const balance = await walletData.wallet.getBalance();
      setWalletData((prev) => prev ? { ...prev, balanceSats: balance.balance } : prev);
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
      setSendStep('error');
    }
  };

  const words = walletData?.mnemonic?.split(' ') ?? [];
  const isLoading = appState === 'creating' || appState === 'recovering';
  const minSats = lnurlPayInfo ? Math.ceil(lnurlPayInfo.minSendableMsats / 1000) : 1;
  const maxSats = lnurlPayInfo ? Math.floor(lnurlPayInfo.maxSendableMsats / 1000) : undefined;
  const amountNum = parseInt(sendAmountSats, 10);
  const amountValid = !isNaN(amountNum) && amountNum >= minSats && (maxSats === undefined || amountNum <= maxSats);

  return (
    <div className="w-[360px] max-h-[600px] overflow-y-auto bg-neutral-950 text-neutral-100 flex flex-col p-4">

      <div className="mb-5">
        <h1 className="text-lg font-bold text-white">TIPT</h1>
        <p className="text-neutral-500 text-xs">the instant payment toolkit</p>
      </div>

      {appState === 'initializing' && (
        <div className="flex justify-center py-8">
          <Spinner className="w-6 h-6 text-orange-400" />
        </div>
      )}

      {appState === 'pin-setup' && (
        <div className="space-y-4 p-4 rounded-xl bg-neutral-900 border border-gray-800">
          <div className="text-center">
            <h2 className="text-sm font-semibold text-white">
              {pinSetupStep === 'enter' ? 'Create a PIN' : 'Confirm your PIN'}
            </h2>
            <p className="text-xs text-neutral-500 mt-1">
              {pinSetupStep === 'enter' ? 'Choose a 6-digit PIN to protect your wallet.' : 'Re-enter your PIN to confirm.'}
            </p>
          </div>
          <PinInput
            value={pinSetupStep === 'enter' ? pinInput : pinConfirm}
            onChange={pinSetupStep === 'enter' ? setPinInput : setPinConfirm}
            onSubmit={pinSetupStep === 'enter' ? handlePinSetupNext : handlePinSetupConfirm}
            disabled={pinLoading}
          />
          {pinError && <p className="text-center text-xs text-red-400">{pinError}</p>}
          <button
            onClick={pinSetupStep === 'enter' ? handlePinSetupNext : handlePinSetupConfirm}
            disabled={pinLoading || (pinSetupStep === 'enter' ? pinInput.length < 6 : pinConfirm.length < 6)}
            className="w-full py-2.5 text-sm font-semibold rounded-xl bg-orange-500 text-white hover:bg-orange-400 disabled:opacity-40 disabled:pointer-events-none transition-colors flex items-center justify-center gap-2"
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
        <div className="space-y-4 p-4 rounded-xl bg-neutral-900 border border-gray-800">
          <div className="text-center">
            <h2 className="text-sm font-semibold text-white">Enter your PIN</h2>
            <p className="text-xs text-neutral-500 mt-1">Your wallet is locked.</p>
          </div>
          <PinInput value={pinInput} onChange={setPinInput} onSubmit={handlePinUnlock} disabled={pinLoading} />
          {pinError && <p className="text-center text-xs text-red-400">{pinError}</p>}
          <button
            onClick={handlePinUnlock}
            disabled={pinLoading || pinInput.length < 6}
            className="w-full py-2.5 text-sm font-semibold rounded-xl bg-orange-500 text-white hover:bg-orange-400 disabled:opacity-40 disabled:pointer-events-none transition-colors flex items-center justify-center gap-2"
          >
            {pinLoading ? (<><Spinner className="w-4 h-4" /> Unlocking...</>) : 'Unlock'}
          </button>
        </div>
      )}

      {isLoading && (
        <div className="flex justify-center py-6">
          <div className="inline-flex items-center gap-3 px-5 py-3 rounded-xl bg-neutral-900 border border-gray-800">
            <Spinner className="w-5 h-5 text-orange-400" />
            <span className="text-neutral-300 text-sm">{appState === 'recovering' ? 'Recovering wallet...' : 'Creating wallet...'}</span>
          </div>
        </div>
      )}

      {appState === 'error' && (
        <div className="space-y-3 text-center">
          <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400">
            <p className="font-semibold text-sm mb-1">Something went wrong</p>
            <p className="text-xs font-mono break-all">{walletError}</p>
          </div>
          <button onClick={() => setAppState('idle')} className="px-5 py-2.5 text-sm font-semibold rounded-xl bg-orange-500 text-white hover:bg-orange-400 transition-colors">
            Try Again
          </button>
        </div>
      )}

      {appState === 'idle' && (
        <div className="space-y-3">
          <div className="p-4 rounded-xl bg-neutral-900 border border-gray-800 text-center">
            <p className="text-neutral-400 text-xs mb-3">Generate a new wallet with a fresh recovery phrase.</p>
            <button onClick={() => initWallet()} className="w-full py-3 text-sm font-semibold rounded-xl bg-orange-500 text-white hover:bg-orange-400 active:bg-orange-600 transition-colors">
              Create Wallet
            </button>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1 h-px bg-neutral-800" />
            <span className="text-xs text-neutral-600">or</span>
            <div className="flex-1 h-px bg-neutral-800" />
          </div>
          <div className="p-4 rounded-xl bg-neutral-900 border border-gray-800">
            {!showRecover ? (
              <div className="text-center">
                <p className="text-neutral-400 text-xs mb-3">Already have a wallet? Restore using your recovery phrase.</p>
                <button onClick={() => setShowRecover(true)} className="w-full py-2.5 text-sm font-semibold rounded-xl border border-gray-700 text-neutral-200 hover:border-gray-500 hover:bg-neutral-800 transition-colors">
                  Recover Wallet
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <label className="block text-xs font-semibold text-neutral-300">Recovery Phrase</label>
                <textarea
                  value={recoverInput}
                  onChange={(e) => setRecoverInput(e.target.value)}
                  placeholder="Enter your 12 or 24 word recovery phrase..."
                  rows={3}
                  className="w-full px-3 py-2 rounded-lg bg-neutral-800 border border-gray-700 text-xs text-neutral-200 placeholder-neutral-600 font-mono resize-none focus:outline-none focus:border-orange-500/50"
                />
                <div className="flex gap-2">
                  <button onClick={() => { setShowRecover(false); setRecoverInput(''); }} className="flex-1 py-2 text-xs font-medium rounded-lg border border-gray-700 text-neutral-400 hover:border-gray-600 hover:text-neutral-200 transition-colors">
                    Cancel
                  </button>
                  <button
                    onClick={() => { const t = recoverInput.trim(); if (t) initWallet(t); }}
                    disabled={!recoverInput.trim()}
                    className="flex-1 py-2 text-xs font-semibold rounded-lg bg-orange-500 text-white hover:bg-orange-400 disabled:opacity-40 disabled:pointer-events-none transition-colors"
                  >
                    Recover
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {appState === 'ready' && walletData && (
        <div className="space-y-3">
          <div className="p-4 rounded-xl bg-neutral-900 border border-gray-800 flex items-center justify-between">
            <div>
              <p className="text-xs text-neutral-500 mb-0.5">Balance</p>
              <div className="flex items-baseline gap-1">
                <span className="text-xl text-orange-400 font-bold">&#8383;</span>
                <span className="text-xl font-bold text-white">{walletData.balanceSats.toString()}</span>
                <span className="text-xs text-neutral-500 ml-1">sats</span>
              </div>
              {lastUpdated && (
                <div className="flex items-center gap-1 mt-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                  <span className="text-xs text-neutral-600">Updated {lastUpdated}</span>
                </div>
              )}
            </div>
            <button onClick={handleLock} title="Lock wallet" className="p-1.5 rounded-lg text-neutral-600 hover:text-neutral-300 hover:bg-neutral-800 transition-colors">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
              </svg>
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={handleSend}
              className={`p-3 rounded-xl border flex flex-col items-center gap-2 transition-colors ${activePanel === 'send' ? 'bg-orange-500/10 border-orange-500/40 text-orange-400' : 'bg-neutral-900 border-gray-800 text-neutral-400 hover:border-gray-700 hover:text-neutral-200'}`}
            >
              <div className={`w-8 h-8 rounded-full flex items-center justify-center ${activePanel === 'send' ? 'bg-orange-500/20' : 'bg-neutral-800'}`}>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" />
                </svg>
              </div>
              <span className="text-xs font-semibold">Send</span>
            </button>
            <button
              onClick={handleReceive}
              className={`p-3 rounded-xl border flex flex-col items-center gap-2 transition-colors ${activePanel === 'receive' ? 'bg-orange-500/10 border-orange-500/40 text-orange-400' : 'bg-neutral-900 border-gray-800 text-neutral-400 hover:border-gray-700 hover:text-neutral-200'}`}
            >
              <div className={`w-8 h-8 rounded-full flex items-center justify-center ${activePanel === 'receive' ? 'bg-orange-500/20' : 'bg-neutral-800'}`}>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 13.5L12 21m0 0l-7.5-7.5M12 21V3" />
                </svg>
              </div>
              <span className="text-xs font-semibold">Receive</span>
            </button>
          </div>

          {activePanel === 'send' && (
            <div className="p-4 rounded-xl bg-neutral-900 border border-gray-800 space-y-3">
              <p className="text-xs font-semibold text-neutral-200">Send via Lightning Address / LNURL</p>

              {sendStep === 'input' && (
                <div className="space-y-2">
                  <input
                    type="text"
                    value={sendInput}
                    onChange={(e) => setSendInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && sendInput.trim() && handleResolveLnurl()}
                    placeholder="user@domain.com or lnurl1..."
                    className="w-full px-3 py-2 rounded-lg bg-neutral-800 border border-gray-700 text-xs text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-orange-500/50"
                  />
                  {sendError && <p className="text-xs text-red-400">{sendError}</p>}
                  <button
                    onClick={handleResolveLnurl}
                    disabled={!sendInput.trim() || resolving}
                    className="w-full py-2 text-xs font-semibold rounded-lg bg-orange-500 text-white hover:bg-orange-400 disabled:opacity-40 disabled:pointer-events-none transition-colors flex items-center justify-center gap-2"
                  >
                    {resolving ? (<><Spinner className="w-3.5 h-3.5" /> Resolving...</>) : 'Continue'}
                  </button>
                </div>
              )}

              {sendStep === 'amount' && lnurlPayInfo && (
                <div className="space-y-2">
                  {lnurlPayInfo.description && (
                    <div className="px-3 py-2 rounded-lg bg-neutral-800/60 border border-gray-700/50">
                      <p className="text-xs text-neutral-500 mb-0.5">Paying to</p>
                      <p className="text-xs text-neutral-200">{lnurlPayInfo.description}</p>
                    </div>
                  )}
                  <div>
                    <label className="block text-xs text-neutral-400 mb-1">
                      Amount (sats) <span className="text-neutral-600">min {minSats}{maxSats !== undefined ? ` · max ${maxSats}` : ''}</span>
                    </label>
                    <input
                      type="number"
                      value={sendAmountSats}
                      onChange={(e) => setSendAmountSats(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-neutral-800 border border-gray-700 text-xs text-neutral-200 focus:outline-none focus:border-orange-500/50"
                    />
                  </div>
                  {sendError && <p className="text-xs text-red-400">{sendError}</p>}
                  <div className="flex gap-2">
                    <button onClick={() => { setSendStep('input'); setLnurlPayInfo(null); }} className="flex-1 py-2 text-xs font-medium rounded-lg border border-gray-700 text-neutral-400 hover:border-gray-600 hover:text-neutral-200 transition-colors">
                      Back
                    </button>
                    <button
                      onClick={handleSendPayment}
                      disabled={!amountValid}
                      className="flex-1 py-2 text-xs font-semibold rounded-lg bg-orange-500 text-white hover:bg-orange-400 disabled:opacity-40 disabled:pointer-events-none transition-colors"
                    >
                      Pay {sendAmountSats} sats
                    </button>
                  </div>
                </div>
              )}

              {sendStep === 'sending' && (
                <div className="flex items-center justify-center py-4 gap-2 text-neutral-400">
                  <Spinner className="w-4 h-4 text-orange-400" />
                  <span className="text-xs">Sending payment...</span>
                </div>
              )}

              {sendStep === 'success' && (
                <div className="space-y-2">
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-green-500/10 border border-green-500/30">
                    <div className="w-7 h-7 rounded-full bg-green-500/20 flex items-center justify-center shrink-0">
                      <svg className="w-3.5 h-3.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-green-300">Payment sent!</p>
                      {sendTxId && <p className="text-xs text-neutral-500 font-mono break-all mt-0.5">{sendTxId}</p>}
                    </div>
                  </div>
                  <button onClick={handleSend} className="w-full py-2 text-xs font-medium rounded-lg border border-gray-700 text-neutral-400 hover:text-neutral-200 hover:border-gray-600 transition-colors">
                    Send another
                  </button>
                </div>
              )}

              {sendStep === 'error' && (
                <div className="space-y-2">
                  <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-xs">{sendError}</div>
                  <button onClick={() => { setSendStep('amount'); setSendError(null); }} className="w-full py-2 text-xs font-medium rounded-lg border border-gray-700 text-neutral-400 hover:text-neutral-200 hover:border-gray-600 transition-colors">
                    Try Again
                  </button>
                </div>
              )}
            </div>
          )}

          {activePanel === 'receive' && (
            <div className="p-4 rounded-xl bg-neutral-900 border border-gray-800 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-neutral-200">Lightning Invoice</span>
                {invoice && <CopyButton text={invoice} />}
              </div>
              {fetchingInvoice ? (
                <div className="flex items-center justify-center py-8 gap-2 text-neutral-500">
                  <Spinner className="w-4 h-4 text-orange-400" />
                  <span className="text-xs">Generating invoice...</span>
                </div>
              ) : invoice ? (
                <>
                  <div className="flex justify-center">
                    <div className="p-2.5 bg-white rounded-xl">
                      <QRCodeSVG value={invoice} size={160} level="M" />
                    </div>
                  </div>
                  <div className="p-2.5 rounded-lg bg-neutral-800/60 border border-gray-700/50">
                    <p className="text-xs font-mono text-neutral-400 break-all leading-relaxed">{invoice}</p>
                  </div>
                  <p className="text-xs text-neutral-600 text-center">Scan or share — payer chooses the amount.</p>
                </>
              ) : (
                <p className="text-xs text-red-400 text-center">Failed to generate invoice. Close and reopen Receive.</p>
              )}
            </div>
          )}

          <div className="p-4 rounded-xl bg-neutral-900 border border-amber-500/20">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-amber-400">Recovery Phrase</span>
              <CopyButton text={walletData.mnemonic} />
            </div>
            {!walletData.recovered && (
              <p className="text-xs text-amber-600/80 mb-2">Write this down. Never share it. It is the only way to recover your wallet.</p>
            )}
            <div className="grid grid-cols-4 gap-1">
              {words.map((word, i) => (
                <div key={i} className="px-1 py-1 rounded bg-neutral-800/60 border border-gray-700/50 text-center">
                  <span className="text-neutral-600 mr-0.5" style={{ fontSize: '0.6rem' }}>{i + 1}.</span>
                  <span className="text-xs text-neutral-300">{word}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
