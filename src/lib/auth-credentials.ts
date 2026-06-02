import { log } from './logger';

// 402 challenge payload shape shared between the background worker and any
// helper that needs to construct an Authorization header from a paid
// preimage. The fields mirror the parser in `content.ts` (see
// `takeBoundedString` / `takePaymentChallenge`) — keep them in sync.
export interface ChallengePayload {
  scheme: string;
  invoice: string;
  rawHeader?: string;
  macaroon?: string;
  token?: string;
  paymentChallenge?: {
    id: string;
    realm: string;
    method: string;
    intent: string;
    request: string;
    expires?: string;
    opaque?: string;
  };
}

export function toBase64UrlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// RFC 8785 JSON Canonicalization Scheme: sorts object keys lexicographically
// (Unicode code-point order). We deliberately fail-closed on non-finite
// numbers and unsupported types instead of falling through to JSON.stringify
// (which would produce inconsistent output, e.g. `null` for NaN).
export function jcsStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JCS: non-finite number is not canonicalizable.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(jcsStringify).join(',') + ']';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const pairs = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + jcsStringify(obj[k]));
    return '{' + pairs.join(',') + '}';
  }
  throw new Error(`JCS: unsupported type ${typeof value}.`);
}

export function decodeOpaqueToObject(opaque: string): Record<string, string> | undefined {
  // Cap input length so a hostile server cannot send megabytes of base64
  // and force us through a slow JSON.parse before falling back.
  if (opaque.length > 4096) return undefined;
  try {
    const padded = opaque.replace(/-/g, '+').replace(/_/g, '/').padEnd(
      opaque.length + (4 - opaque.length % 4) % 4, '=',
    );
    const json = atob(padded);
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    // Per the MPP spec the opaque payload is a flat string map; reject anything
    // else so a hostile server cannot inject nested objects, arrays, or numbers
    // into the JCS-signed credential we send upstream on retry.
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v !== 'string') return undefined;
      if (v.length > 1024) return undefined;
      out[k] = v;
    }
    return out;
  } catch {
    // If decode fails, fall back to omitting opaque
  }
  return undefined;
}

export function buildAuthorizationValue(challenge: ChallengePayload, preimage: string): string | null {
  const scheme = challenge.scheme?.trim() || 'L402';
  if (scheme.toLowerCase() === 'payment') {
    const paymentChallenge = challenge.paymentChallenge;
    if (!paymentChallenge) {
      return null;
    }

    const opaqueObj = paymentChallenge.opaque
      ? decodeOpaqueToObject(paymentChallenge.opaque)
      : undefined;

    const challengeEcho: Record<string, unknown> = {
      id: paymentChallenge.id,
      realm: paymentChallenge.realm,
      method: paymentChallenge.method,
      intent: paymentChallenge.intent,
      request: paymentChallenge.request,
      ...(paymentChallenge.expires ? { expires: paymentChallenge.expires } : {}),
      ...(opaqueObj ? { opaque: opaqueObj } : {}),
    };

    const credential = {
      challenge: challengeEcho,
      payload: { preimage },
    };

    const credentialJson = jcsStringify(credential);
    log('[TIPT-BG] Payment credential JSON (JCS):', credentialJson);
    return `Payment ${toBase64UrlUtf8(credentialJson)}`;
  }

  if (scheme.toLowerCase() === 'l402') {
    const credential = challenge.macaroon ?? challenge.token;
    if (credential) {
      return `L402 ${credential}:${preimage}`;
    }
    return `L402 ${preimage}`;
  }

  return `Bearer ${preimage}`;
}
