/// <reference types="chrome" />
import { useCallback, useEffect, useState } from 'react';
import { FaXmark } from 'react-icons/fa6';
import type { AllowlistEntry } from '../lib/allowlist';
import { MSG } from '../lib/messages';
import { Spinner } from './Spinner';

type TrustedSite = { host: string } & AllowlistEntry;

interface ListResponse {
  ok: boolean;
  entries?: TrustedSite[];
  error?: string;
}

interface RemoveResponse {
  ok: boolean;
  error?: string;
}

interface TrustedSitesScreenProps {
  onBack: () => void;
}

function formatSats(value: number): string {
  return value.toLocaleString('en-US');
}

function formatAddedAt(ts: number): string {
  try {
    return new Date(ts).toLocaleDateString();
  } catch {
    return '—';
  }
}

// chrome.runtime.sendMessage can resolve to undefined when no listener calls
// sendResponse (e.g. SW recycle race, or the offscreen-document listener
// short-circuits before background dispatches). Retry once after a short
// delay so a transient race doesn't surface as a hard error. The retry
// wakes the SW if it was dormant; the second attempt has a fresh dispatch.
async function sendWithRetry<T>(message: Record<string, unknown>): Promise<T | undefined> {
  let response = await chrome.runtime.sendMessage(message) as T | undefined;
  if (response === undefined) {
    await new Promise((r) => setTimeout(r, 100));
    response = await chrome.runtime.sendMessage(message) as T | undefined;
  }
  return response;
}

export function TrustedSitesScreen({ onBack }: TrustedSitesScreenProps) {
  const [sites, setSites] = useState<TrustedSite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removingHost, setRemovingHost] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const response = await sendWithRetry<ListResponse>({ type: MSG.ALLOWLIST_LIST_402 });
      if (!response) {
        setError('Could not reach the background worker. Try closing and reopening the popup.');
        setSites([]);
        return;
      }
      if (!response.ok) {
        setError(response.error ?? 'Failed to load trusted sites.');
        setSites([]);
        return;
      }
      const entries = response.entries ?? [];
      entries.sort((a, b) => a.host.localeCompare(b.host));
      setSites(entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load trusted sites.');
      setSites([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleRemove = async (host: string) => {
    setRemovingHost(host);
    try {
      const response = await sendWithRetry<RemoveResponse>({
        type: MSG.ALLOWLIST_REMOVE_402,
        payload: { host },
      });
      if (!response) {
        setError('Could not reach the background worker. Try closing and reopening the popup.');
        return;
      }
      if (!response.ok) {
        setError(response.error ?? `Failed to remove ${host}.`);
        return;
      }
      setSites((prev) => prev ? prev.filter((s) => s.host !== host) : prev);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to remove ${host}.`);
    } finally {
      setRemovingHost(null);
    }
  };

  return (
    <div className="flex flex-col flex-1 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <img src="/tiptgreen.svg" alt="TIPT" className="w-7 h-7" />
          <h1 className="text-lg font-bold text-neutral-900 dark:text-neutral-200">TRUSTED SITES</h1>
        </div>
        <button
          onClick={onBack}
          title="Back"
          aria-label="Back"
          className="p-1.5 rounded-lg transition-colors text-neutral-500 hover:text-neutral-900 hover:bg-neutral-200 dark:text-neutral-400 dark:hover:text-neutral-100 dark:hover:bg-neutral-800"
        >
          <FaXmark className="w-4 h-4" />
        </button>
      </div>

      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Sites listed here can spend up to their caps without prompting. Remove a site to
        require a prompt for its next payment.
      </p>

      {error && (
        <div className="p-2 rounded-lg border border-red-300 bg-red-50 text-xs text-red-800 dark:bg-red-950/40 dark:border-red-900 dark:text-red-300">
          {error}
        </div>
      )}

      {sites === null && (
        <div className="flex items-center justify-center py-8 gap-2 text-neutral-500">
          <Spinner className="w-4 h-4 text-neutral-400" />
          <span className="text-xs">Loading…</span>
        </div>
      )}

      {sites && sites.length === 0 && (
        <div className="py-6 text-center text-xs text-neutral-500 dark:text-neutral-400">
          No trusted sites yet.
        </div>
      )}

      {sites && sites.length > 0 && (
        <ul className="space-y-2">
          {sites.map((site) => {
            const today = new Date().toISOString().slice(0, 10);
            const spentToday = site.dayKey === today ? site.spentToday : 0;
            return (
              <li
                key={site.host}
                className="rounded-xl bg-neutral-100 dark:bg-neutral-900 p-3 text-xs space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-mono break-all text-neutral-900 dark:text-neutral-100">
                      {site.host}
                    </div>
                    <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                      Added {formatAddedAt(site.addedAt)}
                    </div>
                  </div>
                  <button
                    onClick={() => { void handleRemove(site.host); }}
                    disabled={removingHost === site.host}
                    className="text-[11px] font-semibold text-red-600 hover:text-red-700 disabled:opacity-40 disabled:pointer-events-none dark:text-red-400 dark:hover:text-red-300"
                  >
                    {removingHost === site.host ? 'Removing…' : 'Remove'}
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px] text-neutral-600 dark:text-neutral-400">
                  <div>
                    <div className="text-neutral-500 dark:text-neutral-500">Per payment</div>
                    <div className="font-mono text-neutral-800 dark:text-neutral-200">
                      {formatSats(site.maxSatsPerPayment)} sats
                    </div>
                  </div>
                  <div>
                    <div className="text-neutral-500 dark:text-neutral-500">Per day</div>
                    <div className="font-mono text-neutral-800 dark:text-neutral-200">
                      {site.maxSatsPerDay > 0 ? `${formatSats(site.maxSatsPerDay)} sats` : 'unlimited'}
                    </div>
                  </div>
                  <div className="col-span-2">
                    <div className="text-neutral-500 dark:text-neutral-500">Spent today</div>
                    <div className="font-mono text-neutral-800 dark:text-neutral-200">
                      {formatSats(spentToday)} sats
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
