import { Spinner } from '../Spinner';
import type { LnurlPayInfo } from '../../lnurl';
import type { SendStep } from '../../lib/send-types';

interface SendPanelState {
  sendStep: SendStep;
  sendInput: string;
  resolvedInput: string;
  sendAmountSats: string;
  lnurlPayInfo: LnurlPayInfo | null;
  sendError: string | null;
  resolving: boolean;
  sendTxId: string | null;
  feeEstimateSats: number | null;
  balanceSats: bigint;
}

interface SendPanelSetters {
  setSendInput: (v: string) => void;
  setSendAmountSats: (v: string) => void;
  setIsSendMax: (v: boolean) => void;
  setSendError: (v: string | null) => void;
  setLnurlPayInfo: (v: LnurlPayInfo | null) => void;
  setSendStep: (v: SendStep) => void;
}

interface SendPanelActions {
  onSubmit: () => void;
  onConfirm: () => void;
}

interface SendPanelProps {
  state: SendPanelState;
  setters: SendPanelSetters;
  actions: SendPanelActions;
}

export function SendPanel({ state, setters, actions }: SendPanelProps) {
  const {
    sendStep,
    sendInput,
    resolvedInput,
    sendAmountSats,
    lnurlPayInfo,
    sendError,
    resolving,
    sendTxId,
    feeEstimateSats,
    balanceSats,
  } = state;
  const {
    setSendInput,
    setSendAmountSats,
    setIsSendMax,
    setSendError,
    setLnurlPayInfo,
    setSendStep,
  } = setters;
  const { onSubmit, onConfirm } = actions;

  return (
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
              onKeyDown={(e) => e.key === 'Enter' && sendInput.trim() && onSubmit()}
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
              {Number(balanceSats) > 0 && (
                <button
                  onClick={() => { setSendAmountSats(String(balanceSats)); setIsSendMax(true); }}
                  className="px-3 py-2 text-xs font-semibold rounded-lg border border-neutral-300 text-neutral-500 hover:border-neutral-400 hover:text-neutral-800 transition-colors dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-600 dark:hover:text-neutral-200 whitespace-nowrap"
                >
                  Send Max
                </button>
              )}
            </div>
          </div>
          {sendError && <p className="text-xs text-neutral-500 dark:text-neutral-400">{sendError}</p>}
          <button
            onClick={onSubmit}
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
            onClick={onConfirm}
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
  );
}
