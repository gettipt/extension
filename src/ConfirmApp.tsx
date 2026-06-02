/// <reference types="chrome" />
import { useEffect, useState } from 'react';

interface PaymentDetails {
  host: string;
  url: string;
  method: string;
  invoice: string;
}

export default function ConfirmApp() {
  const [details, setDetails] = useState<PaymentDetails | null>(null);
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const params = new URLSearchParams(window.location.search);
  const id = params.get('id') ?? '';

  useEffect(() => {
    if (!id) {
      setError('Missing request id.');
      return;
    }
    chrome.runtime.sendMessage({ type: 'TIPT_402_CONFIRM_READY', payload: { id } }).then((response: unknown) => {
      const r = response as { ok?: boolean; details?: PaymentDetails; error?: string } | undefined;
      if (!r?.ok || !r.details) {
        setError(r?.error ?? 'Payment request expired.');
        return;
      }
      setDetails(r.details);
    }).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : 'Could not load payment request.');
    });
  }, [id]);

  const respond = async (approved: boolean) => {
    setBusy(true);
    try {
      await chrome.runtime.sendMessage({
        type: 'TIPT_402_CONFIRM_RESPONSE',
        payload: { id, approved, remember: approved && remember },
      });
    } finally {
      window.close();
    }
  };

  return (
    <div className="w-full h-screen bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100 p-5 flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <img src="/tiptgreen.svg" alt="TIPT" className="w-7 h-7" />
        <h1 className="text-base font-semibold">Approve Payment</h1>
      </div>

      {error && (
        <div className="p-3 rounded-xl border border-red-300 bg-red-50 text-red-800 text-xs dark:bg-red-950/40 dark:border-red-900 dark:text-red-300">
          {error}
        </div>
      )}

      {details && (
        <>
          <div className="rounded-xl bg-neutral-100 dark:bg-neutral-900 p-3 space-y-2 text-xs">
            <div>
              <div className="text-neutral-500 dark:text-neutral-400">Site</div>
              <div className="font-mono break-all">{details.host}</div>
            </div>
            <div>
              <div className="text-neutral-500 dark:text-neutral-400">Request</div>
              <div className="font-mono break-all">{details.method} {details.url}</div>
            </div>
            <div>
              <div className="text-neutral-500 dark:text-neutral-400">Invoice</div>
              <div className="font-mono break-all">{details.invoice.slice(0, 80)}{details.invoice.length > 80 ? '…' : ''}</div>
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs text-neutral-700 dark:text-neutral-300">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="w-4 h-4 accent-neutral-900 dark:accent-neutral-200"
            />
            Remember this site and auto-approve next payment requests
          </label>

          <div className="flex-1" />

          <div className="flex gap-2">
            <button
              onClick={() => void respond(false)}
              disabled={busy}
              className="flex-1 py-2.5 text-sm font-semibold rounded-xl border border-neutral-300 text-neutral-700 hover:bg-neutral-100 disabled:opacity-40 disabled:pointer-events-none dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              Decline
            </button>
            <button
              onClick={() => void respond(true)}
              disabled={busy}
              className="flex-1 py-2.5 text-sm font-semibold rounded-xl bg-neutral-900 text-white hover:bg-neutral-700 disabled:opacity-40 disabled:pointer-events-none dark:bg-neutral-200 dark:text-neutral-950 dark:hover:bg-neutral-100"
            >
              Approve & Pay
            </button>
          </div>
        </>
      )}
    </div>
  );
}
