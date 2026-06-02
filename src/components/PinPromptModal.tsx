import { useEffect, useRef, useState } from 'react';
import { PIN_LENGTH } from '../constants';
import { verifyPin } from '../lib/pin-attempts';
import { PinInput } from './PinInput';
import { Spinner } from './Spinner';

interface PinPromptModalProps {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: (key: CryptoKey) => void | Promise<void>;
  onCancel: () => void;
  destructive?: boolean;
}

// Re-prompt the user for their PIN before performing a sensitive or
// destructive action (back up mnemonic / delete wallet). Re-derives a
// fresh AES key against the stored salt + iterations so the verifier
// decrypts only when the user actually knows the PIN — never relies on
// the cached in-memory key, which would otherwise let anyone with brief
// device access exfiltrate the mnemonic or wipe the wallet.
export function PinPromptModal({
  title,
  description,
  confirmLabel,
  onConfirm,
  onCancel,
  destructive,
}: PinPromptModalProps) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => () => { cancelledRef.current = true; }, []);

  const verify = async (raw = pin) => {
    if (raw.length < PIN_LENGTH || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await verifyPin(raw);
      if (!result.ok) {
        if (result.reason === 'locked') {
          const seconds = Math.ceil((result.lockedUntil - Date.now()) / 1000);
          setError(`Too many attempts. Try again in ${seconds}s.`);
        } else if (result.reason === 'no-data') {
          setError('PIN data is unavailable.');
        } else {
          setError('Incorrect PIN.');
        }
        setPin('');
        return;
      }
      if (cancelledRef.current) return;
      await onConfirm(result.key);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to verify PIN.');
    } finally {
      if (!cancelledRef.current) setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="w-full max-w-sm space-y-4 rounded-xl bg-white p-5 shadow-lg dark:bg-neutral-900 dark:border dark:border-neutral-800">
        <div className="text-center space-y-1">
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-white">{title}</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{description}</p>
        </div>
        <PinInput value={pin} onChange={setPin} onSubmit={(v) => { void verify(v); }} disabled={busy} />
        {error && <p className="text-center text-xs text-neutral-500 dark:text-neutral-400">{error}</p>}
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="flex-1 py-2.5 text-sm font-semibold rounded-xl border border-neutral-300 text-neutral-700 hover:bg-neutral-100 disabled:opacity-40 disabled:pointer-events-none dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            onClick={() => { void verify(); }}
            disabled={busy || pin.length < PIN_LENGTH}
            className={`flex-1 py-2.5 text-sm font-semibold rounded-xl disabled:opacity-40 disabled:pointer-events-none transition-colors flex items-center justify-center gap-2 ${destructive
              ? 'bg-red-600 text-white hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-500'
              : 'bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-200 dark:text-neutral-950 dark:hover:bg-neutral-100'}`}
          >
            {busy ? (<><Spinner className="w-4 h-4" /> Verifying…</>) : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

