/// <reference types="chrome" />

// IMPORTANT: Content scripts in MV3 are loaded as classic scripts, not ES
// modules. They cannot use `import` statements at runtime. Keep this file
// self-contained: do NOT import from any other module in this codebase.
//
// Message type strings duplicated from src/lib/messages.ts — the build
// inlines that module into the popup/offscreen/background bundles, but
// the content script must remain a single classic-script file.

const DEBUG = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
function log(...args: unknown[]): void { if (DEBUG) console.log(...args); }

const MPP_REQUEST_TRIGGERED_EVENT = 'TIPT_MPP_REQUEST_TRIGGERED';
const PAY_REQUEST_402 = 'TIPT_402_PAY_REQUEST';

// Defensive caps. The MPP page-side surface is fully attacker-controlled —
// reject obviously hostile inputs at the boundary so the background never
// has to defend against megabyte-sized strings or wrong types.
const MAX_INVOICE_LEN = 8192;
const MAX_SHORT_FIELD_LEN = 512;
const MAX_OPAQUE_LEN = 4096;
// Payment challenge `request` is a serialized payload that can include a full
// BOLT11 invoice, so it can be much larger than short metadata fields.
const MAX_PAYMENT_REQUEST_LEN = 4096;
const MAX_REQUEST_ID_LEN = 256;

interface MppExtChallengeDetail {
  requestId: string;
  // Payment target. Today this is either a BOLT11 Lightning invoice
  // ("lnbc…") or a Spark address ("spark1…", "sp1…" etc.). The wire field
  // is named `invoice` for back-compat with sites already integrating MPP;
  // the meaning is generalised to "payment target". The background classifies
  // by prefix (see src/lib/payment-target.ts) and routes accordingly.
  invoice: string;
  // Required for Spark addresses (which have no embedded amount), ignored
  // for BOLT11 invoices (amount is in the invoice HRP). When supplied for
  // a Lightning invoice the background does not consult it — the BOLT11
  // amount is always authoritative.
  amountSats?: number;
  scheme?: string;
  macaroon?: string;
  token?: string;
  challenge?: {
    id: string;
    realm: string;
    method: string;
    intent: string;
    request: string;
    expires?: string;
    opaque?: string;
  };
}

interface MppRequestDetail {
  type?: string;
  paymentMethods?: string[];
  intents?: string[];
}

interface CredentialResponse {
  approved: boolean;
  credential?: string;
  error?: string;
}

const SUPPORTED_PAYMENT_METHODS = ['lightning'] as const;
const SUPPORTED_INTENTS = ['charge'] as const;
const MPP_EXTENSION_EVENT = 'mpp:extension';

const announcement = {
  type: 'response',
  name: 'TIPT',
  version: '0.0.1',
  // TIPT advertises Lightning charge-only support on the discovery surface.
  paymentMethods: SUPPORTED_PAYMENT_METHODS,
  intents: SUPPORTED_INTENTS,
};

// Cached result of the most recent background "is the wallet configured?"
// check. Pages that fire `mpp:extension` request events in rapid succession
// (or that the
// throttle below short-circuits) get this cached value immediately rather
// than waiting a second round-trip. `undefined` means "we haven't asked
// the background yet" — surfaced to the page as `undefined` so consumers
// can distinguish "unknown" from "definitely missing".
let cachedWalletConfigured: boolean | undefined;
let cachedRequestedPaymentMethods: string[] | undefined;
let cachedRequestedIntents: string[] | undefined;

function takePaymentMethods(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const methods = value
    .filter((m): m is string => typeof m === 'string' && m.length > 0 && m.length <= MAX_SHORT_FIELD_LEN)
    .map((m) => m.toLowerCase());
  if (methods.length === 0) return undefined;
  return Array.from(new Set(methods));
}

function takeIntents(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const intents = value
    .filter((i): i is string => typeof i === 'string' && i.length > 0 && i.length <= MAX_SHORT_FIELD_LEN)
    .map((i) => i.toLowerCase());
  if (intents.length === 0) return undefined;
  return Array.from(new Set(intents));
}

function supportsRequested(requested: string[] | undefined, supported: readonly string[]): boolean {
  if (!requested || requested.length === 0) return true;
  return requested.every((value) => supported.includes(value));
}

function dispatchAnnouncement(): void {
  window.dispatchEvent(new CustomEvent(MPP_EXTENSION_EVENT, {
    detail: {
      ...announcement,
      walletConfigured: cachedWalletConfigured,
      requestedPaymentMethods: cachedRequestedPaymentMethods,
      requestedIntents: cachedRequestedIntents,
      supportsRequestedPaymentMethods: supportsRequested(
        cachedRequestedPaymentMethods,
        SUPPORTED_PAYMENT_METHODS,
      ),
      supportsRequestedIntents: supportsRequested(
        cachedRequestedIntents,
        SUPPORTED_INTENTS,
      ),
    },
  }));
}

function sendRuntimeMessage<T>(message: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: T) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function isBoundedString(v: unknown, maxLen: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= maxLen;
}

function takeBoundedString(v: unknown, maxLen: number): string | undefined {
  return isBoundedString(v, maxLen) ? v : undefined;
}

function takePaymentChallenge(raw: unknown): MppExtChallengeDetail['challenge'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Record<string, unknown>;
  const id = takeBoundedString(c.id, MAX_SHORT_FIELD_LEN);
  const realm = takeBoundedString(c.realm, MAX_SHORT_FIELD_LEN);
  const method = takeBoundedString(c.method, MAX_SHORT_FIELD_LEN);
  const intent = takeBoundedString(c.intent, MAX_SHORT_FIELD_LEN);
  const request = takeBoundedString(c.request, MAX_PAYMENT_REQUEST_LEN);
  if (!id || !realm || !method || !intent || !request) return undefined;
  const expires = c.expires !== undefined ? takeBoundedString(c.expires, MAX_SHORT_FIELD_LEN) : undefined;
  const opaque = c.opaque !== undefined ? takeBoundedString(c.opaque, MAX_OPAQUE_LEN) : undefined;
  return { id, realm, method, intent, request, expires, opaque };
}

// Announce presence and notify background (icon badge) when the page asks.
// Rate-limit so a hostile page cannot spam `mpp:extension` request events and
// keep the SW
// awake. 250ms is loose enough to feel instant on a real page load and
// tight enough to throttle a tight dispatch loop.
//
// Two announcements happen per "fresh" request:
//   1. An immediate `mpp:extension` response carrying the cached
//      `walletConfigured`
//      value (possibly `undefined` on the very first request) so pages
//      that listen with a `once: true` handler still receive a discovery
//      response without waiting on a runtime hop.
//   2. A second `mpp:extension` response after the background reports the
//      current
//      wallet-configured state. Pages that care about accuracy should
//      listen for `mpp:extension` continuously (not with `once: true`)
//      and use the most recent payload.
const MPP_REQUEST_THROTTLE_MS = 250;
let lastMppRequestAt = 0;
window.addEventListener(MPP_EXTENSION_EVENT, (event: Event) => {
  const detail = (event as CustomEvent<MppRequestDetail>).detail;
  if (!detail || detail.type !== 'request') return;
  cachedRequestedPaymentMethods = takePaymentMethods(detail?.paymentMethods);
  cachedRequestedIntents = takeIntents(detail?.intents);
  const now = Date.now();
  if (now - lastMppRequestAt >= MPP_REQUEST_THROTTLE_MS) {
    lastMppRequestAt = now;
    sendRuntimeMessage<{ ok?: boolean; walletConfigured?: boolean }>({ type: MPP_REQUEST_TRIGGERED_EVENT })
      .then((response) => {
        if (response && typeof response.walletConfigured === 'boolean') {
          const changed = cachedWalletConfigured !== response.walletConfigured;
          cachedWalletConfigured = response.walletConfigured;
          // Only re-announce when the state actually changed (or this is
          // the first time we've learned it). Avoids a duplicate event on
          // every page load once the cache is warm.
          if (changed) dispatchAnnouncement();
        }
      })
      .catch(() => { /* SW unreachable; the cached value (if any) stands. */ });
  }
  // The announcement is dispatched on the page (no runtime hop), so always
  // respond immediately — pages that just want to discover the wallet
  // shouldn't be collateral damage of the throttle or the runtime round-trip.
  dispatchAnnouncement();
});

// Handle payment requests dispatched by the page.
window.addEventListener('mpp:challenge', (event: Event) => {
  const detail = (event as CustomEvent<MppExtChallengeDetail>).detail;
  const requestId = takeBoundedString(detail?.requestId, MAX_REQUEST_ID_LEN);
  const invoice = takeBoundedString(detail?.invoice, MAX_INVOICE_LEN);
  if (!requestId || !invoice) {
    log('[TIPT-CS] mpp:challenge rejected: missing/invalid requestId or invoice');
    return;
  }

  const scheme = takeBoundedString(detail.scheme, MAX_SHORT_FIELD_LEN) ?? 'L402';
  const macaroon = takeBoundedString(detail.macaroon, MAX_OPAQUE_LEN);
  const token = takeBoundedString(detail.token, MAX_OPAQUE_LEN);
  const challenge = takePaymentChallenge(detail.challenge);

  // Sanitise the optional amountSats. Validation that it's required (for
  // Spark) and matches the target kind happens in the background — keeping
  // the content script ignorant of payment-kind semantics keeps the
  // page-side surface as small as possible.
  let amountSats: number | undefined;
  if (typeof detail.amountSats === 'number'
    && Number.isFinite(detail.amountSats)
    && Number.isInteger(detail.amountSats)
    && detail.amountSats > 0
    && detail.amountSats <= Number.MAX_SAFE_INTEGER) {
    amountSats = detail.amountSats;
  }

  log('[TIPT-CS] mpp:challenge received, requestId:', requestId);

  void sendRuntimeMessage<CredentialResponse>({
    type: PAY_REQUEST_402,
    payload: {
      source: 'mpp',
      url: window.location.href,
      method: 'GET',
      challenge: {
        scheme,
        invoice,
        amountSats,
        macaroon,
        token,
        paymentChallenge: challenge,
      },
    },
  })
    .then((response) => {
      log('[TIPT-CS] Credential response:', response);
      window.dispatchEvent(new CustomEvent('mpp:credential', {
        detail: {
          requestId,
          approved: response.approved,
          credential: response.credential,
          error: response.error,
        },
      }));
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Payment failed.';
      log('[TIPT-CS] Credential error:', message);
      window.dispatchEvent(new CustomEvent('mpp:credential', {
        detail: { requestId, approved: false, error: message },
      }));
    });
});
