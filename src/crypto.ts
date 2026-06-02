// ── Crypto helpers (Web Crypto API) ───────────────────────────────────────

export const PBKDF2_ITERATIONS_DEFAULT = 600_000;
export const PBKDF2_ITERATIONS_LEGACY = 100_000;

export function hexToBuf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2)
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes;
}

export function bufToHex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Encode raw bytes to standard base64. Used to write new ciphertext entries
// into chrome.storage.sync, where the 8 KB per-item quota makes the ~33%
// space saving over hex significant for larger encrypted blobs (e.g. the
// recent-transfers cache).
export function bufToB64(buf: Uint8Array): string {
  // String.fromCharCode(...buf) blows the call stack on large inputs; build
  // the binary string in chunks instead.
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

export function b64ToBuf(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Dual-decoder used everywhere we read previously-written ciphertext. The
// old format was lowercase hex; the new format is standard base64. Callers
// don't care which one is on disk — we sniff: if every char is a hex digit
// AND the length is even, treat it as hex; otherwise try base64.
function decodeIvOrCt(value: string): Uint8Array {
  if (value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value)) return hexToBuf(value);
  return b64ToBuf(value);
}

export async function deriveKey(
  pin: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS_DEFAULT,
  extractable: boolean = false,
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptText(
  key: CryptoKey,
  text: string,
): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    new TextEncoder().encode(text),
  );
  // New writes use base64 — smaller payload, fits the sync quota with more
  // headroom. Reads (decryptText) accept either format for back-compat.
  return { iv: bufToB64(iv), ct: bufToB64(new Uint8Array(ct)) };
}

export async function decryptText(
  key: CryptoKey,
  iv: string,
  ct: string,
): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decodeIvOrCt(iv).buffer as ArrayBuffer },
    key,
    decodeIvOrCt(ct).buffer as ArrayBuffer,
  );
  return new TextDecoder().decode(plain);
}

// Generate a random AES-GCM session key (non-extractable).
export async function generateSessionKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

