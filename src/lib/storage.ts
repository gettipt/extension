/// <reference types="chrome" />

// Single source of truth for chrome.storage access. No more localStorage.
// Use promise-based chrome APIs (MV3 supports them).
//
// Two optimisations layered on the bare chrome.storage API:
//   1. In-memory read cache keyed by `${area}:${key}`. We populate on every
//      read and write, and invalidate transparently via chrome.storage.onChanged
//      so cross-context writes (e.g. background updating sync that the popup
//      then reads) stay consistent. This turns a typical popup-open from many
//      chrome.storage.local round-trips into a single warmup read per key.
//   2. Hash-dedupe of sync writes. chrome.storage.sync has tight per-write
//      quotas (MAX_WRITE_OPERATIONS_PER_MINUTE = 120). A surprising number
//      of writes re-store an identical value (loadAllowlist save-on-noop,
//      idempotent backfills, etc.); we SHA-256 the value once and skip the
//      sync.set when unchanged.

type Area = 'local' | 'sync' | 'session';

function area(name: Area): chrome.storage.StorageArea {
  return chrome.storage[name];
}

const memCache = new Map<string, string | null>();
const lastSyncHash = new Map<string, string>();

function cacheKey(name: Area, key: string): string {
  return `${name}:${key}`;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

// One global listener wires up cross-context invalidation. We only register
// it in contexts where the chrome.storage namespace is actually available
// (popup, background, offscreen, confirm); content scripts that import this
// module would otherwise crash on the addListener call.
//
// SYNC DEDUPE INVARIANT: `lastSyncHash[key]` represents the hash of the
// value we last successfully wrote ourselves. On ANY external sync change
// we drop the entry — we don't know what hash the other context produced,
// and trying to recompute from `change.newValue` would race against our
// own in-flight setItem. Dropping means the next setItem on that key
// always re-checks against the live on-disk value (via the awaited set).
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' && areaName !== 'sync' && areaName !== 'session') return;
    for (const [key, change] of Object.entries(changes)) {
      const k = cacheKey(areaName, key);
      if (change.newValue === undefined) {
        memCache.delete(k);
      } else if (typeof change.newValue === 'string') {
        memCache.set(k, change.newValue);
      } else {
        memCache.delete(k);
      }
      if (areaName === 'sync') lastSyncHash.delete(key);
    }
  });
}

export async function getItem(name: Area, key: string): Promise<string | null> {
  const ck = cacheKey(name, key);
  if (memCache.has(ck)) return memCache.get(ck) ?? null;
  const result = await area(name).get([key]);
  const value = result[key];
  const normalised = typeof value === 'string' ? value : null;
  memCache.set(ck, normalised);
  return normalised;
}

export async function setItem(name: Area, key: string, value: string): Promise<void> {
  // Hash-dedupe sync writes — they have tight quotas.
  let hash: string | null = null;
  if (name === 'sync') {
    hash = await sha256Hex(value);
    if (lastSyncHash.get(key) === hash) {
      memCache.set(cacheKey(name, key), value);
      return;
    }
  }
  // Important: only stamp lastSyncHash AFTER the awaited set resolves. If the
  // write throws (quota / sync disabled), we must NOT mark the value as
  // already-on-disk — otherwise the next legitimate retry of the same value
  // is silently deduped and the data never reaches storage.
  await area(name).set({ [key]: value });
  memCache.set(cacheKey(name, key), value);
  if (name === 'sync' && hash !== null) lastSyncHash.set(key, hash);
}

export async function removeItem(name: Area, key: string): Promise<void> {
  await area(name).remove(key);
  memCache.delete(cacheKey(name, key));
  if (name === 'sync') lastSyncHash.delete(key);
}

// Write to BOTH local (fast, per-device) and sync (cross-device propagation).
// Sync writes are best-effort: chrome.storage.sync has a per-item byte quota
// (~8 KB) and a per-extension quota; encrypted wallet/PIN blobs fit comfortably
// but we still tolerate failures so a local-only write never breaks the app.
export async function setItemDual(key: string, value: string): Promise<void> {
  await Promise.all([
    setItem('local', key, value),
    setItem('sync', key, value).catch(() => { /* best-effort cross-device propagation */ }),
  ]);
}

// Atomic dual write of multiple keys. The local `set` commits all keys together
// or none — Chrome's storage.local guarantees this for a single `.set` call —
// so two interdependent blobs (e.g. PIN payload + wallet ciphertext during a
// PBKDF2 re-encryption migration) cannot end up in an inconsistent state on
// the primary device. Sync is still best-effort and may diverge; `getSynced`
// transparently backfills divergence on the next read.
export async function setItemsDual(items: Record<string, string>): Promise<void> {
  await chrome.storage.local.set(items);
  for (const [k, v] of Object.entries(items)) memCache.set(cacheKey('local', k), v);
  try {
    // For the multi-key path we skip the hash dedupe — these writes happen
    // during the rare PBKDF2 migration; correctness > a saved quota slot.
    await chrome.storage.sync.set(items);
    for (const [k, v] of Object.entries(items)) {
      memCache.set(cacheKey('sync', k), v);
      lastSyncHash.set(k, await sha256Hex(v));
    }
  } catch {
    /* best-effort cross-device propagation */
  }
}

// Read local first (fast), fall back to sync (cross-device restore). When the
// value lives only in local but not in sync, backfill sync transparently so
// other signed-in devices can pick it up. When the value lives only in sync
// (fresh install on a new device), cache it locally too.
export async function getSynced(key: string): Promise<string | null> {
  const [local, synced] = await Promise.all([
    getItem('local', key),
    getItem('sync', key),
  ]);
  if (local !== null && synced === null) {
    await setItem('sync', key, local).catch(() => { /* best-effort backfill */ });
  }
  if (local !== null) return local;
  if (synced !== null) {
    await setItem('local', key, synced).catch(() => { /* best-effort cache */ });
    return synced;
  }
  return null;
}

// Remove from both areas. Used when the user deletes their wallet.
export async function removeItemDual(key: string): Promise<void> {
  await Promise.all([
    removeItem('local', key),
    removeItem('sync', key).catch(() => { /* best-effort */ }),
  ]);
}

