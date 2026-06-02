import {
  getTransferString,
  getTransferAmountSatsLabel,
  getTransferTimeLabel,
  groupTransfersByDay,
} from '../../lib/transfers';
import type { WalletTransfer } from '../../lib/transfers';

interface TransferListProps {
  recentTransfers: WalletTransfer[];
  loadingTransfers: boolean;
  transfersError: string | null;
  showAllTransfers: boolean;
  onToggleShowAll: () => void;
  btcUsdRate: number | null;
}

export function TransferList({
  recentTransfers,
  loadingTransfers,
  transfersError,
  showAllTransfers,
  onToggleShowAll,
}: TransferListProps) {
  return (
    <div className="flex flex-col flex-1 rounded-xl bg-neutral-100 border border-neutral-200 dark:bg-neutral-900 dark:border-neutral-800 overflow-hidden">
      <div className="flex items-center justify-between px-3 pt-3 mb-2">
        <p className="text-xs text-neutral-500 dark:text-neutral-400">RECENT ACTIVITY</p>
        {recentTransfers.length > 4 && (
          <button
            onClick={onToggleShowAll}
            className="text-xs font-medium text-neutral-600 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
          >
            {showAllTransfers ? 'Show Less' : 'See All'}
          </button>
        )}
      </div>

      {transfersError && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400 px-3 pb-3">{transfersError}</p>
      )}

      {!transfersError && !loadingTransfers && recentTransfers.length === 0 && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400 px-3 pb-3">No transfers yet.</p>
      )}

      {!transfersError && recentTransfers.length > 0 && (
        <div className="flex-1 overflow-y-auto pb-3">
          {groupTransfersByDay(recentTransfers.slice(0, showAllTransfers ? undefined : 4)).map((group) => (
            <div key={group.day}>
              <p className="text-xs font-semibold text-neutral-700 dark:text-neutral-300 px-3 py-1 bg-neutral-200/60 dark:bg-neutral-800">{group.day}</p>
              <div className="divide-y divide-neutral-200 dark:divide-neutral-800 px-3">
                {group.transfers.map((transfer, index) => {
                  const id = getTransferString(transfer, ['id', 'transferSparkId', 'paymentId']) ?? `transfer-${index}`;
                  const isIncoming = (transfer.transferDirection === 'INCOMING' || transfer.transferDirection === 'incoming');

                  return (
                    <div key={`${id}-${index}`} className="py-2 flex items-center justify-between">
                      <div>
                        <p className={`text-xs font-medium ${isIncoming ? 'text-green-600 dark:text-green-400' : 'text-neutral-600 dark:text-neutral-400'}`}>{isIncoming ? 'Received' : 'Sent'}</p>
                        <p className="text-[10px] text-neutral-400 dark:text-neutral-500 mt-0.5">{getTransferTimeLabel(transfer)}</p>
                      </div>
                      <p className={`text-sm font-semibold ${isIncoming ? 'text-green-600 dark:text-green-400' : 'text-neutral-700 dark:text-neutral-200'}`}><span className="text-neutral-500">&#8383;</span>{getTransferAmountSatsLabel(transfer).replace(/^₿/, '')}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
