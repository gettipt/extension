import { PIN_LENGTH } from '../constants';
import { PinInput } from './PinInput';
import { Spinner } from './Spinner';

type PinActionKind = 'backup' | 'delete';

interface PinActionScreenProps {
  action: PinActionKind;
  pin: string;
  error: string | null;
  loading: boolean;
  onPinChange: (v: string) => void;
  onConfirm: (pin?: string) => void;
  onBack: () => void;
}

export function PinActionScreen({
  action,
  pin,
  error,
  loading,
  onPinChange,
  onConfirm,
  onBack,
}: PinActionScreenProps) {
  const isDelete = action === 'delete';

  return (
    <div className="space-y-4 p-4">
      <div className="text-center">
        <img src="/tiptgreen.svg" alt="TIPT" className="w-10 h-10 mx-auto mb-3" />
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-white">
          {isDelete ? 'Confirm wallet deletion' : 'Confirm to back up'}
        </h2>
        <p className="text-xs text-neutral-500 mt-1">
          {isDelete
            ? 'Re-enter your PIN to permanently delete this wallet from this device. This cannot be undone.'
            : 'Re-enter your PIN to export your recovery phrase.'}
        </p>
      </div>

      <PinInput
        value={pin}
        onChange={onPinChange}
        onSubmit={(v) => { void onConfirm(v); }}
        disabled={loading}
      />

      {error && <p className="text-center text-xs text-neutral-500 dark:text-neutral-400">{error}</p>}

      {!isDelete && (
        <button
          onClick={() => { void onConfirm(); }}
          disabled={loading || pin.length < PIN_LENGTH}
          className="w-full py-2.5 text-sm font-semibold rounded-xl disabled:opacity-40 disabled:pointer-events-none transition-colors flex items-center justify-center gap-2 bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-200 dark:text-neutral-950 dark:hover:bg-neutral-100"
        >
          {loading
            ? (
              <>
                <Spinner className="w-4 h-4" />
                Verifying...
              </>
            )
            : 'Back Up Wallet'}
        </button>
      )}

      <button
        onClick={onBack}
        disabled={loading}
        className="w-full py-2 text-xs font-medium rounded-lg border border-neutral-300 text-neutral-500 hover:border-neutral-400 hover:text-neutral-800 transition-colors disabled:opacity-40 disabled:pointer-events-none dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-600 dark:hover:text-neutral-200"
      >
        Back
      </button>
    </div>
  );
}
