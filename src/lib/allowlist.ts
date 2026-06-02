/// <reference types="chrome" />

import { getItem, setItem } from './storage';

// Per-host auto-approve allowlist for 402 / MPP payments.
//
// SECURITY MODEL
// --------------
// Each entry pairs a host with explicit caps:
//   * `maxSatsPerPayment` — single-invoice cap. Auto-approval is denied
//     when the invoice amount cannot be decoded (zero-amount invoice or
//     unrecognised format) or exceeds this value.
//   * `maxSatsPerDay`     — rolling per-host daily cap (UTC day). The
//     running counter resets whenever `dayKey` no longer matches the
//     current day.
//
// Legacy `host: true` entries from earlier versions are silently dropped
// on load (caller will re-prompt with explicit caps the next time the
// host requests payment).
//
// PERSISTENCE
// -----------
// All I/O is routed through `getItem`/`setItem` in `./storage`, which
// gives us memcache + cross-context invalidation for the raw JSON string
// for free. We keep a separate module-level `cache: Allowlist | null`
// holding the *parsed* object so concurrent `tryAutoApprove` calls
// mutate the same reference (the old design relied on this for race
// safety — two parallel parses would each see `spentToday=N`, both
// write `N+amt`, losing one increment). A focused `chrome.storage.onChanged`
// listener nulls the parsed cache when another context writes to our key.
//
// We deliberately do NOT debounce `tryAutoApprove` writes: MV3 service
// workers can be terminated at any moment and a deferred flush could lose
// the `spentToday` counter, making the daily cap silently more permissive
// than the user authorised. Persisting every increment is the only correct
// option until the platform gives us a durable "before-termination" hook.

export const ALLOWLIST_KEY = 'tipt_402_allowlist';

export interface AllowlistEntry {
  maxSatsPerPayment: number;
  maxSatsPerDay: number;
  spentToday: number;
  dayKey: string;
  addedAt: number;
}

export type Allowlist = Record<string, AllowlistEntry>;

let cache: Allowlist | null = null;
let loadPromise: Promise<Allowlist> | null = null;

export function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function sanitizeEntry(value: unknown): AllowlistEntry | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<AllowlistEntry>;
  if (typeof v.maxSatsPerPayment !== 'number' || !Number.isFinite(v.maxSatsPerPayment)) return null;
  if (typeof v.maxSatsPerDay !== 'number' || !Number.isFinite(v.maxSatsPerDay)) return null;
  return {
    maxSatsPerPayment: Math.max(0, Math.floor(v.maxSatsPerPayment)),
    maxSatsPerDay: Math.max(0, Math.floor(v.maxSatsPerDay)),
    spentToday: typeof v.spentToday === 'number' && Number.isFinite(v.spentToday)
      ? Math.max(0, Math.floor(v.spentToday)) : 0,
    dayKey: typeof v.dayKey === 'string' ? v.dayKey : todayKey(),
    addedAt: typeof v.addedAt === 'number' && Number.isFinite(v.addedAt) ? v.addedAt : Date.now(),
  };
}

function parseAllowlist(raw: string | null): { list: Allowlist; migrated: boolean } {
  const out: Allowlist = {};
  let migrated = false;
  if (!raw) return { list: out, migrated: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { list: out, migrated: true };
  }
  if (!parsed || typeof parsed !== 'object') return { list: out, migrated: true };
  for (const [host, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === true) {
      migrated = true;
      continue;
    }
    const entry = sanitizeEntry(value);
    if (entry) {
      out[host] = entry;
    } else {
      migrated = true;
    }
  }
  return { list: out, migrated };
}

export async function loadAllowlist(): Promise<Allowlist> {
  if (cache) return cache;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const raw = await getItem('local', ALLOWLIST_KEY);
    const { list, migrated } = parseAllowlist(raw);
    if (migrated) {
      await setItem('local', ALLOWLIST_KEY, JSON.stringify(list)).catch(() => { /* best-effort */ });
    }
    cache = list;
    return list;
  })();

  try {
    return await loadPromise;
  } finally {
    loadPromise = null;
  }
}

async function persist(list: Allowlist): Promise<void> {
  cache = list;
  await setItem('local', ALLOWLIST_KEY, JSON.stringify(list));
}

export interface AutoApproveDecision {
  approved: boolean;
  reason?: string;
}

// Returns approved=true and atomically debits `amountSats` from
// `spentToday` when the host has caps that permit the payment. Caller
// must pass a finite positive `amountSats`; pass null to force a prompt.
export async function tryAutoApprove(host: string, amountSats: number | null): Promise<AutoApproveDecision> {
  if (amountSats === null) return { approved: false, reason: 'amount-unknown' };
  if (!Number.isFinite(amountSats) || amountSats <= 0) return { approved: false, reason: 'invalid-amount' };

  const list = await loadAllowlist();
  const entry = list[host];
  if (!entry) return { approved: false, reason: 'not-allowlisted' };
  if (entry.maxSatsPerPayment <= 0) return { approved: false, reason: 'no-auto-approve' };
  if (amountSats > entry.maxSatsPerPayment) return { approved: false, reason: 'per-payment-cap' };

  const today = todayKey();
  const spentToday = entry.dayKey === today ? entry.spentToday : 0;
  if (entry.maxSatsPerDay > 0 && spentToday + amountSats > entry.maxSatsPerDay) {
    return { approved: false, reason: 'daily-cap' };
  }

  const updated: AllowlistEntry = {
    ...entry,
    dayKey: today,
    spentToday: spentToday + amountSats,
  };
  list[host] = updated;
  await persist(list);
  return { approved: true };
}

export interface RememberHostOptions {
  maxSatsPerPayment: number;
  maxSatsPerDay: number;
  initialSpentSats?: number;
}

export async function rememberHost(host: string, opts: RememberHostOptions): Promise<void> {
  const sanitizedPerPayment = Math.max(0, Math.floor(opts.maxSatsPerPayment));
  const sanitizedPerDay = Math.max(0, Math.floor(opts.maxSatsPerDay));
  if (sanitizedPerPayment <= 0) return; // refuse to write a no-op entry
  const list = await loadAllowlist();
  list[host] = {
    maxSatsPerPayment: sanitizedPerPayment,
    maxSatsPerDay: sanitizedPerDay,
    spentToday: Math.max(0, Math.floor(opts.initialSpentSats ?? 0)),
    dayKey: todayKey(),
    addedAt: Date.now(),
  };
  await persist(list);
}

export async function removeHost(host: string): Promise<void> {
  const list = await loadAllowlist();
  if (!(host in list)) return;
  delete list[host];
  await persist(list);
}

export async function listAllowlist(): Promise<Array<{ host: string } & AllowlistEntry>> {
  const list = await loadAllowlist();
  return Object.entries(list).map(([host, entry]) => ({ host, ...entry }));
}

// Invalidate the parsed cache when another extension context writes to
// our key. `setItem` itself updates storage.ts's string memcache, but
// our parsed-object cache is a layer above that and storage.ts doesn't
// know about it. The listener is intentionally scoped to one key so it
// doesn't fire for every unrelated `chrome.storage.local` write.
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (!(ALLOWLIST_KEY in changes)) return;
    cache = null;
  });
}
