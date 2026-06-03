/// <reference types="chrome" />
import { useEffect, useMemo, useRef, useState } from 'react';
import { MSG } from './lib/messages';
import {
  pendingConfirmStorageKey,
  type PersistedConfirmDetails,
} from './lib/confirm-protocol';
import { paymentKindLabel } from './lib/payment-target';

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

// Truncate a long bech32m address ("spark1qq…xyz") to a glanceable form for
// the confirm popup. We keep enough of the suffix that the user can compare
// it against a recipient address shown elsewhere (e.g. an invoice they
// generated themselves) without rendering the full ~70-char string and
// blowing out the popup width.
function truncateMiddle(value: string, head = 14, tail = 8): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

// Resize the confirm popup's chrome window so its inner content area
// exactly matches the rendered DOM — no vertical or horizontal scroll.
// Anchors the right edge so the popup stays glued to the top-right
// corner that background.ts initially positioned it at, even as the
// remember-caps field opens/closes and the height changes.
function useAutoResizeWindow(rootRef: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let cancelled = false;
    let windowId: number | null = null;
    let pendingFrame: number | null = null;
    let lastWidth = -1;
    let lastHeight = -1;

    chrome.windows.getCurrent().then((win) => {
      if (cancelled) return;
      windowId = typeof win?.id === 'number' ? win.id : null;
    }).catch(() => { /* best-effort */ });

    const resize = () => {
      pendingFrame = null;
      if (windowId === null || !root) return;
      const contentWidth = root.offsetWidth;
      const contentHeight = root.offsetHeight;
      if (contentWidth === lastWidth && contentHeight === lastHeight) return;
      lastWidth = contentWidth;
      lastHeight = contentHeight;
      // Chrome reports outer/inner for the whole window; the delta is the
      // OS window decorations (title bar + borders). We add that delta to
      // the rendered content size to compute the outer window size that
      // produces an inner area equal to the content.
      const chromeW = Math.max(0, window.outerWidth - window.innerWidth);
      const chromeH = Math.max(0, window.outerHeight - window.innerHeight);
      const newOuterWidth = contentWidth + chromeW;
      const newOuterHeight = contentHeight + chromeH;
      const currentRight = window.screenX + window.outerWidth;
      const newLeft = Math.round(currentRight - newOuterWidth);
      chrome.windows.update(windowId, {
        width: newOuterWidth,
        height: newOuterHeight,
        left: newLeft,
      }).catch(() => { /* best-effort */ });
    };

    const schedule = () => {
      if (pendingFrame !== null) return;
      pendingFrame = requestAnimationFrame(resize);
    };

    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    schedule();

    return () => {
      cancelled = true;
      observer.disconnect();
      if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
    };
  }, [rootRef]);
}

export default function ConfirmApp() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const id = params.get('id') ?? '';
  const [details, setDetails] = useState<PersistedConfirmDetails | null>(null);
  const [remember, setRemember] = useState(false);
  const [perDayCap, setPerDayCap] = useState('');
  // Initialise error from `id` rather than setting it from inside the effect
  // — that's a cascading-render anti-pattern. `id` is derived from
  // location.search once at mount, so the initial value never changes.
  const [error, setError] = useState<string | null>(id ? null : 'Missing request id.');
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useAutoResizeWindow(rootRef);

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
          // Conservative default: daily cap = 2x current invoice. Old
          // default was 10x, which gave a single invoice unintended
          // cumulative authority. Users can still raise it before
          // approving.
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
        const perDay = parseInt(perDayCap, 10);
        if (!Number.isFinite(perDay) || perDay <= 0) {
          setError('Daily cap must be a positive number.');
          setBusy(false);
          return;
        }
        if (details && details.amountSats !== null && perDay < details.amountSats) {
          setError('Daily cap must cover this invoice.');
          setBusy(false);
          return;
        }
        // Only one cap is collected from the user (daily). Map it to both
        // sides of the allowlist API so the per-payment limit is the same
        // as the daily limit — i.e. the daily cap is the sole constraint.
        payload.caps = { maxSatsPerPayment: perDay, maxSatsPerDay: perDay };
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
    <div
      ref={rootRef}
      className="w-[360px] bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100 p-5 flex flex-col gap-4"
    >
      {error && (
        <div className="p-3 rounded-xl border border-red-300 bg-red-50 text-red-800 text-xs dark:bg-red-950/40 dark:border-red-900 dark:text-red-300">
          {error}
        </div>
      )}

      {details && (
        <>
          <div className="rounded-xl bg-neutral-100 dark:bg-neutral-900 p-3 space-y-2 text-xs">
            <div>
              <div className="text-neutral-500 dark:text-neutral-400">Method</div>
              <div className="flex items-center gap-1.5">
                <span
                  className={`inline-block w-1.5 h-1.5 rounded-full ${
                    (details.paymentKind ?? 'lightning') === 'spark'
                      ? 'bg-purple-500'
                      : 'bg-amber-500'
                  }`}
                />
                <span className="font-semibold">
                  {paymentKindLabel(details.paymentKind ?? 'lightning')}
                </span>
                <span className="text-neutral-500 dark:text-neutral-400">
                  {(details.paymentKind ?? 'lightning') === 'spark'
                    ? '— off-Lightning transfer'
                    : '— BOLT11 invoice'}
                </span>
              </div>
            </div>
            <div>
              <div className="text-neutral-500 dark:text-neutral-400">Site</div>
              <div className="font-mono break-all">{details.host}</div>
            </div>
            <div>
              <div className="text-neutral-500 dark:text-neutral-400">Amount</div>
              <div className="font-mono">{formatSats(details.amountSats)}</div>
            </div>
            {(details.paymentKind ?? 'lightning') === 'spark' && (
              <div>
                <div className="text-neutral-500 dark:text-neutral-400">Recipient</div>
                <div className="font-mono" title={details.invoice}>
                  {truncateMiddle(details.invoice)}
                </div>
              </div>
            )}
          </div>

          <label className={`flex items-center gap-2 text-xs ${canRemember ? 'text-neutral-700 dark:text-neutral-300' : 'text-neutral-400 dark:text-neutral-600'}`}>
            <input
              type="checkbox"
              checked={remember}
              disabled={!canRemember}
              onChange={(e) => setRemember(e.target.checked)}
              className="w-4 h-4 accent-neutral-900 dark:accent-neutral-200 disabled:opacity-40"
            />
            Auto-approve future payments from this site, up to the daily cap below
          </label>

          {remember && canRemember && (
            <label className="block text-xs">
              <span className="text-neutral-500 dark:text-neutral-400">Max per day (sats)</span>
              <input
                type="text"
                inputMode="numeric"
                value={perDayCap}
                onChange={(e) => setPerDayCap(sanitiseSatsInput(e.target.value))}
                className="mt-1 w-full px-2 py-1.5 rounded-lg bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 font-mono text-neutral-900 dark:text-neutral-100 focus:outline-none focus:border-neutral-500"
              />
            </label>
          )}

          {!canRemember && (
            <p className="text-[11px] text-neutral-500 dark:text-neutral-400 -mt-2">
              Auto-approve is only available for invoices with a known amount.
            </p>
          )}

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
