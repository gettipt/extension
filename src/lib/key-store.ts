/// <reference lib="dom" />

// Shared, origin-scoped IndexedDB store for the PIN-derived AES-GCM key.
//
// SECURITY MODEL
// --------------
// At unlock, the popup derives a non-extractable CryptoKey from the user's
// PIN via PBKDF2-SHA256. That key is the AES-GCM key that decrypts the
// wallet mnemonic blob. Historically we stored the *PIN* in
// `chrome.storage.session` so that the background service worker could
// re-derive the key on demand for 402 payments. That had two problems:
//   1. The plaintext PIN was readable by every extension context, and an
//      XSS in any extension page could exfiltrate it for offline brute-
//      forcing of the wallet ciphertext.
//   2. `chrome.storage.session` is JSON-serialised, so we couldn't store a
//      CryptoKey directly.
//
// IndexedDB's structured-clone serialization preserves CryptoKey instances
// — including the `extractable: false` flag — so we can persist the derived
// key without ever exposing its raw bytes. Any context with access to the
// extension origin (popup / offscreen / background) can fetch the same
// CryptoKey handle and use it to encrypt/decrypt, but cannot read the
// underlying material via `crypto.subtle.exportKey`.
//
// LIFETIME
// --------
// We deliberately mimic the previous `chrome.storage.session` semantics:
// the key is cleared on browser startup (see `chrome.runtime.onStartup` in
// `background.ts`) and on explicit wallet reset / lock. It survives
// service-worker / offscreen restarts, which is exactly what we need so
// that background 402 payments work without prompting the user every time
// Chrome reclaims a worker.

const DB_NAME = 'tipt-keystore';
const STORE = 'session-keys';
const KEY_ID = 'unlock-key';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('keystore upgrade blocked by another connection'));
  });
}

function txComplete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

export async function storeUnlockKey(key: CryptoKey): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(key, KEY_ID);
    await txComplete(tx);
  } finally {
    db.close();
  }
}

export async function loadUnlockKey(): Promise<CryptoKey | null> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(KEY_ID);
    const value = await new Promise<unknown>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return value instanceof CryptoKey ? value : null;
  } finally {
    db.close();
  }
}

export async function clearUnlockKey(): Promise<void> {
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY_ID);
      await txComplete(tx);
    } finally {
      db.close();
    }
  } catch {
    // Clearing should be best-effort; never block a logout / reset flow on
    // an IDB hiccup.
  }
}
