import { PinInput } from './PinInput';
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
      <button onClick={onCancel} className="block w-full text-center text-sm text-neutral-500 hover:text-neutral-900 underline underline-offset-2 transition-colors dark:text-neutral-600 dark:hover:text-neutral-100">
        Cancel
      </button>
    </div>
  );
}
