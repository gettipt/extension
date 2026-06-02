import { QRCodeSVG } from 'qrcode.react';
import { Spinner } from '../Spinner';

interface ReceivePanelProps {
  invoice: string | null;
  fetchingInvoice: boolean;
  invoiceCopied: boolean;
  onCopy: (invoice: string) => void;
}

export function ReceivePanel({ invoice, fetchingInvoice, invoiceCopied, onCopy }: ReceivePanelProps) {
  return (
    <div className="space-y-3">
      {fetchingInvoice ? (
        <div className="flex items-center justify-center py-8 gap-2 text-neutral-500">
          <Spinner className="w-4 h-4 text-neutral-400" />
          <span className="text-xs">Generating invoice...</span>
        </div>
      ) : invoice ? (
        <>
          <div className="w-full">
            <button
              onClick={() => onCopy(invoice)}
              title="Copy invoice"
              className="w-full p-3 bg-white rounded-xl block"
            >
              <QRCodeSVG value={invoice} size={256} level="M" style={{ width: '100%', height: 'auto', display: 'block' }} />
            </button>
          </div>
          <p className="text-xs text-neutral-600 text-center">{invoiceCopied ? 'Copied to clipboard.' : 'Tap QR to copy invoice.'}</p>
        </>
      ) : (
        <p className="text-xs text-neutral-500 text-center">Failed to generate invoice. Close and reopen Receive.</p>
      )}
    </div>
  );
}
