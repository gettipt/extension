/// <reference types="chrome" />

// Single source of truth for chrome.storage access. No more localStorage.
// Use promise-based chrome APIs (MV3 supports them).

type Area = 'local' | 'sync' | 'session';

function area(name: Area): chrome.storage.StorageArea {
  return chrome.storage[name];
}

export async function getItem(name: Area, key: string): Promise<string | null> {
  const result = await area(name).get([key]);
  const value = result[key];
  return typeof value === 'string' ? value : null;
}

export async function setItem(name: Area, key: string, value: string): Promise<void> {
  await area(name).set({ [key]: value });
}

export async function removeItem(name: Area, key: string): Promise<void> {
  await area(name).remove(key);
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
  try {
    await chrome.storage.sync.set(items);
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
