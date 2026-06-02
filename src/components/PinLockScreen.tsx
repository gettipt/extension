import { PinInput } from './PinInput';
import { Spinner } from './Spinner';
import { PIN_LENGTH } from '../constants';

interface PinLockScreenProps {
  pinInput: string;
  pinError: string | null;
  pinLoading: boolean;
  onPinChange: (v: string) => void;
  onUnlock: (pin?: string) => void;
}

export function PinLockScreen({
  pinInput,
  pinError,
  pinLoading,
  onPinChange,
  onUnlock,
}: PinLockScreenProps) {
  return (
    <div className="space-y-4 p-4">
      <div className="text-center">
        <img src="/tiptgreen.svg" alt="TIPT" className="w-10 h-10 mx-auto mb-3" />
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-white">Enter your PIN</h2>
        <p className="text-xs text-neutral-500 mt-1">Your wallet is locked.</p>
      </div>
      <PinInput value={pinInput} onChange={onPinChange} onSubmit={onUnlock} disabled={pinLoading} />
      {pinError && <p className="text-center text-xs text-neutral-500 dark:text-neutral-400">{pinError}</p>}
      <button
        onClick={() => { onUnlock(); }}
        disabled={pinLoading || pinInput.length < PIN_LENGTH}
        className="w-full py-2.5 text-sm font-semibold rounded-xl bg-neutral-900 text-white hover:bg-neutral-700 disabled:opacity-40 disabled:pointer-events-none transition-colors flex items-center justify-center gap-2 dark:bg-neutral-200 dark:text-neutral-950 dark:hover:bg-neutral-100"
      >
        {pinLoading ? (<><Spinner className="w-4 h-4" /> Unlocking...</>) : 'Unlock'}
      </button>
    </div>
  );
}
