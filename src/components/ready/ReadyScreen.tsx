import type { LnurlPayInfo } from '../../lnurl';
import type { WalletTransfer } from '../../lib/transfers';
import { ReadyHeader } from './ReadyHeader';
import { BalanceCard } from './BalanceCard';
import { ActionTabs } from './ActionTabs';
import { TransferList } from './TransferList';
import { SendPanel } from './SendPanel';
import { ReceivePanel } from './ReceivePanel';

type ActivePanel = 'send' | 'receive' | null;
type SendStep = 'input' | 'amount' | 'confirm' | 'sending' | 'success' | 'error';

interface ReadyScreenProps {
  // Header
  onBackup: () => void;
  onDelete: () => void;

  // Balance
  satsDisplay: string;
  usdDisplay: string;
  usdPrimary: boolean;
  balanceFlash: boolean;
  onToggleUsdPrimary: () => void;

  // Action tabs
  activePanel: ActivePanel;
  onSendClick: () => void;
  onReceiveClick: () => void;

  // Transfers
  recentTransfers: WalletTransfer[];
  loadingTransfers: boolean;
  transfersError: string | null;
  showAllTransfers: boolean;
  onToggleShowAllTransfers: () => void;
  btcUsdRate: number | null;

  // Send panel
  sendState: {
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
  };
  sendSetters: {
    setSendInput: (v: string) => void;
    setSendAmountSats: (v: string) => void;
    setIsSendMax: (v: boolean) => void;
    setSendError: (v: string | null) => void;
    setLnurlPayInfo: (v: LnurlPayInfo | null) => void;
    setSendStep: (v: SendStep) => void;
  };
  onSendSubmit: () => void;
  onSendConfirm: () => void;

  // Receive panel
  invoice: string | null;
  fetchingInvoice: boolean;
  invoiceCopied: boolean;
  onInvoiceCopy: (invoice: string) => void;
}

export function ReadyScreen({
  onBackup,
  onDelete,
  satsDisplay,
  usdDisplay,
  usdPrimary,
  balanceFlash,
  onToggleUsdPrimary,
  activePanel,
  onSendClick,
  onReceiveClick,
  recentTransfers,
  loadingTransfers,
  transfersError,
  showAllTransfers,
  onToggleShowAllTransfers,
  btcUsdRate,
  sendState,
  sendSetters,
  onSendSubmit,
  onSendConfirm,
  invoice,
  fetchingInvoice,
  invoiceCopied,
  onInvoiceCopy,
}: ReadyScreenProps) {
  return (
    <div className="flex flex-col flex-1 space-y-3">
      <ReadyHeader onBackup={onBackup} onDelete={onDelete} />

      <>
        <BalanceCard
          satsDisplay={satsDisplay}
          usdDisplay={usdDisplay}
          usdPrimary={usdPrimary}
          balanceFlash={balanceFlash}
          onToggleUsdPrimary={onToggleUsdPrimary}
        />

        <ActionTabs
          activePanel={activePanel}
          onSendClick={onSendClick}
          onReceiveClick={onReceiveClick}
        />

        {!activePanel && (
          <TransferList
            recentTransfers={recentTransfers}
            loadingTransfers={loadingTransfers}
            transfersError={transfersError}
            showAllTransfers={showAllTransfers}
            onToggleShowAll={onToggleShowAllTransfers}
            btcUsdRate={btcUsdRate}
          />
        )}

      </>

      {activePanel === 'send' && (
        <SendPanel
          state={sendState}
          setters={sendSetters}
          actions={{ onSubmit: onSendSubmit, onConfirm: onSendConfirm }}
        />
      )}

      {activePanel === 'receive' && (
        <ReceivePanel
          invoice={invoice}
          fetchingInvoice={fetchingInvoice}
          invoiceCopied={invoiceCopied}
          onCopy={onInvoiceCopy}
        />
      )}


    </div>
  );
}
