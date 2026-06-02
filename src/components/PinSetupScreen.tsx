import { PinInput } from './PinInput';
import { Spinner } from './Spinner';
import { PIN_LENGTH } from '../constants';

type PinSetupStep = 'enter' | 'confirm';

interface PinSetupScreenProps {
  pinSetupStep: PinSetupStep;
  pinInput: string;
  pinConfirm: string;
  pinError: string | null;
  pinLoading: boolean;
  onPinInputChange: (v: string) => void;
  onPinConfirmChange: (v: string) => void;
  onNext: (pin?: string) => void;
  onConfirm: (pin?: string) => void;
  onBack: () => void;
  onCancel: () => void;
}

export function PinSetupScreen({
  pinSetupStep,
  pinInput,
  pinConfirm,
  pinError,
  pinLoading,
  onPinInputChange,
  onPinConfirmChange,
  onNext,
  onConfirm,
  onBack,
  onCancel,
}: PinSetupScreenProps) {
  return (
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
        onChange={pinSetupStep === 'enter' ? onPinInputChange : onPinConfirmChange}
        onSubmit={pinSetupStep === 'enter' ? onNext : onConfirm}
        disabled={pinLoading}
      />
      {pinError && <p className="text-center text-xs text-neutral-500 dark:text-neutral-400">{pinError}</p>}
      <button
        onClick={() => {
          if (pinSetupStep === 'enter') onNext();
          else onConfirm();
        }}
        disabled={pinLoading || (pinSetupStep === 'enter' ? pinInput.length < PIN_LENGTH : pinConfirm.length < PIN_LENGTH)}
        className="w-full py-2.5 text-sm font-semibold rounded-xl bg-neutral-900 text-white hover:bg-neutral-700 disabled:opacity-40 disabled:pointer-events-none transition-colors flex items-center justify-center gap-2 dark:bg-neutral-200 dark:text-neutral-950 dark:hover:bg-neutral-100"
      >
        {pinLoading ? (<><Spinner className="w-4 h-4" /> Setting up...</>) : pinSetupStep === 'enter' ? 'Next' : 'Confirm PIN'}
      </button>
      {pinSetupStep === 'confirm' ? (
        <button onClick={onBack} className="w-full py-2 text-xs font-medium rounded-lg border border-neutral-300 text-neutral-500 hover:border-neutral-400 hover:text-neutral-800 transition-colors dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-600 dark:hover:text-neutral-200">
          Back
        </button>
      ) : (
        <button onClick={onCancel} className="block w-full text-center text-sm text-neutral-500 hover:text-neutral-900 underline underline-offset-2 transition-colors dark:text-neutral-600 dark:hover:text-neutral-100">
          Cancel
        </button>
      )}
    </div>
  );
}
