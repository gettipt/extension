/// <reference types="chrome" />
import { useEffect, useMemo, useState } from 'react';
import { MSG } from './lib/messages';
import {
  pendingConfirmStorageKey,
  type PersistedConfirmDetails,
} from './lib/confirm-protocol';

interface RespondPayload {
  approved: boolean;
  remember: boolean;
  caps?: { maxSatsPerPayment: number; maxSatsPerDay: number };
}

function sanitiseSatsInput(raw: string): string {
  return raw.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
}

function formatSats(value: number | null): string {
  if (value === null) return 'Amount unspecified';
  return `${value.toLocaleString('en-US')} sats`;
}

export default function ConfirmApp() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const id = params.get('id') ?? '';
  const [details, setDetails] = useState<PersistedConfirmDetails | null>(null);
  const [remember, setRemember] = useState(false);
  const [perPaymentCap, setPerPaymentCap] = useState('');
  const [perDayCap, setPerDayCap] = useState('');
  // Initialise error from `id` rather than setting it from inside the effect
  // — that's a cascading-render anti-pattern. `id` is derived from
  // location.search once at mount, so the initial value never changes.
  const [error, setError] = useState<string | null>(id ? null : 'Missing request id.');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const storageKey = pendingConfirmStorageKey(id);
    void (async () => {
      try {
        const result = await chrome.storage.session.get([storageKey]);
        const raw = result[storageKey] as PersistedConfirmDetails | undefined;
        if (cancelled) return;
        if (!raw) {
          setError('Payment request expired or could not be found.');
          return;
        }
        setDetails(raw);
        if (typeof raw.amountSats === 'number' && raw.amountSats > 0) {
          setPerPaymentCap(String(raw.amountSats));
          // Conservative default: daily cap = 2x per-payment. Old default
          // was 10x, which gave a single invoice unintended cumulative
          // authority. Users can still raise it before approving.
          setPerDayCap(String(raw.amountSats * 2));
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load payment request.');
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  const amountKnown = typeof details?.amountSats === 'number' && details.amountSats > 0;
  const canRemember = amountKnown;

  const respond = async (approved: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const payload: RespondPayload = {
        approved,
        remember: approved && remember && canRemember,
      };
      if (approved && remember && canRemember) {
        const perPayment = parseInt(perPaymentCap, 10);
        const perDay = parseInt(perDayCap, 10);
        if (!Number.isFinite(perPayment) || perPayment <= 0) {
          setError('Per-payment cap must be a positive number.');
          setBusy(false);
          return;
        }
        if (!Number.isFinite(perDay) || perDay <= 0) {
          setError('Daily cap must be a positive number.');
          setBusy(false);
          return;
        }
        if (perDay < perPayment) {
          setError('Daily cap must be greater than or equal to the per-payment cap.');
          setBusy(false);
          return;
        }
        if (details && details.amountSats !== null && perPayment < details.amountSats) {
          setError('Per-payment cap must cover this invoice.');
          setBusy(false);
          return;
        }
        payload.caps = { maxSatsPerPayment: perPayment, maxSatsPerDay: perDay };
      }
      // Do NOT swallow sendMessage failures and close the window anyway —
      // the awaiting tab would observe a silent timeout (up to 5 min) while
      // the user thinks they responded. If the channel is gone (SW recycled
      // mid-prompt), surface the error and let the user retry or cancel.
      try {
        const response = await chrome.runtime.sendMessage({
          type: MSG.CONFIRM_RESPONSE_402,
          payload: { id, ...payload },
        }) as { ok?: boolean; error?: string } | undefined;
        if (response && response.ok === false) {
          setError(response.error ?? 'Background did not accept the response.');
          setBusy(false);
          return;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to send response to the wallet. Please retry.');
        setBusy(false);
        return;
      }
      window.close();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unexpected error.');
      setBusy(false);
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
              <div className="text-neutral-500 dark:text-neutral-400">Amount</div>
              <div className="font-mono">{formatSats(details.amountSats)}</div>
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

          <label className={`flex items-center gap-2 text-xs ${canRemember ? 'text-neutral-700 dark:text-neutral-300' : 'text-neutral-400 dark:text-neutral-600'}`}>
            <input
              type="checkbox"
              checked={remember}
              disabled={!canRemember}
              onChange={(e) => setRemember(e.target.checked)}
              className="w-4 h-4 accent-neutral-900 dark:accent-neutral-200 disabled:opacity-40"
            />
            Auto-approve future payments from this site, up to the caps below
          </label>

          {remember && canRemember && (
            <div className="space-y-2 text-xs">
              <label className="block">
                <span className="text-neutral-500 dark:text-neutral-400">Max per payment (sats)</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={perPaymentCap}
                  onChange={(e) => setPerPaymentCap(sanitiseSatsInput(e.target.value))}
                  className="mt-1 w-full px-2 py-1.5 rounded-lg bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 font-mono text-neutral-900 dark:text-neutral-100 focus:outline-none focus:border-neutral-500"
                />
              </label>
              <label className="block">
                <span className="text-neutral-500 dark:text-neutral-400">Max per day (sats)</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={perDayCap}
                  onChange={(e) => setPerDayCap(sanitiseSatsInput(e.target.value))}
                  className="mt-1 w-full px-2 py-1.5 rounded-lg bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 font-mono text-neutral-900 dark:text-neutral-100 focus:outline-none focus:border-neutral-500"
                />
              </label>
            </div>
          )}

          {!canRemember && (
            <p className="text-[11px] text-neutral-500 dark:text-neutral-400 -mt-2">
              Auto-approve is only available for invoices with a known amount.
            </p>
          )}

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
