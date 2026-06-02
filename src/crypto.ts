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
  return { iv: bufToHex(iv), ct: bufToHex(new Uint8Array(ct)) };
}

export async function decryptText(
  key: CryptoKey,
  iv: string,
  ct: string,
): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: hexToBuf(iv).buffer as ArrayBuffer },
    key,
    hexToBuf(ct).buffer as ArrayBuffer,
  );
  return new TextDecoder().decode(plain);
}

// Generate a random AES-GCM session key (non-extractable).
export async function generateSessionKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
