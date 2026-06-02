import { useCallback, useEffect, useState } from 'react';
import { safeJsonFetch } from '../lib/http';
import { getItem, setItem } from '../lib/storage';
import { BTC_USD_RATE_CACHE_KEY } from '../constants';

const REFRESH_INTERVAL_MS = 300_000;
// If the persisted rate is younger than this, the initial network fetch is
// skipped — the cached value is considered current. CoinGecko updates its
// /simple/price endpoint roughly once a minute; a 60-second fresh window
// removes one network round-trip from every popup open inside that window
// without showing meaningfully stale numbers.
const FRESH_WINDOW_MS = 60_000;

interface CacheShape {
  rate?: number;
  ts?: number;
}

// React hook owning the BTC/USD price. Extracted from App.tsx so the popup
// component is smaller and so future surfaces (e.g. a settings page showing
// USD-denominated thresholds) can reuse the cache/refresh policy.
export function useBtcUsdRate(): number | null {
  const [rate, setRate] = useState<number | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await safeJsonFetch<{ bitcoin?: { usd?: number } }>(
        'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
        { signal, timeoutMs: 8_000, maxBytes: 4 * 1024 },
      );
      const nextRate = data.bitcoin?.usd;
      if (typeof nextRate === 'number' && Number.isFinite(nextRate)) {
        setRate(nextRate);
        void setItem(
          'local',
          BTC_USD_RATE_CACHE_KEY,
          JSON.stringify({ rate: nextRate, ts: Date.now() }),
        ).catch(() => { /* ignore quota errors; the price isn't critical */ });
      }
    } catch {
      // Ignore transient pricing errors and keep the last known rate.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let intervalId: ReturnType<typeof setInterval> | null = null;

    void (async () => {
      // Seed from the persisted cache so we don't render '--' on every popup
      // open while waiting for CoinGecko.
      let cached: CacheShape | null = null;
      try {
        const raw = await getItem('local', BTC_USD_RATE_CACHE_KEY);
        if (raw) cached = JSON.parse(raw) as CacheShape;
      } catch { /* ignore parse errors */ }

      if (cancelled) return;
      if (typeof cached?.rate === 'number' && Number.isFinite(cached.rate)) {
        setRate((prev) => prev ?? cached!.rate!);
      }

      const cacheAgeMs = typeof cached?.ts === 'number' ? Date.now() - cached.ts : Infinity;
      if (cacheAgeMs >= FRESH_WINDOW_MS) {
        await refresh(controller.signal);
      }

      if (cancelled) return;
      intervalId = setInterval(() => { void refresh(controller.signal); }, REFRESH_INTERVAL_MS);
    })();

    return () => {
      cancelled = true;
      controller.abort();
      if (intervalId !== null) clearInterval(intervalId);
    };
  }, [refresh]);

  return rate;
}
