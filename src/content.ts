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
const MAX_REQUEST_ID_LEN = 256;

interface MppPayDetail {
  requestId: string;
  invoice: string;
  scheme?: string;
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

interface PayResponse {
  approved: boolean;
  authorization?: string;
  error?: string;
}

const announcement = {
  name: 'TIPT',
  version: '0.0.0',
  capabilities: ['l402', 'lightning-invoice'],
};

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

function takePaymentChallenge(raw: unknown): MppPayDetail['paymentChallenge'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Record<string, unknown>;
  const id = takeBoundedString(c.id, MAX_SHORT_FIELD_LEN);
  const realm = takeBoundedString(c.realm, MAX_SHORT_FIELD_LEN);
  const method = takeBoundedString(c.method, MAX_SHORT_FIELD_LEN);
  const intent = takeBoundedString(c.intent, MAX_SHORT_FIELD_LEN);
  const request = takeBoundedString(c.request, MAX_SHORT_FIELD_LEN);
  if (!id || !realm || !method || !intent || !request) return undefined;
  const expires = c.expires !== undefined ? takeBoundedString(c.expires, MAX_SHORT_FIELD_LEN) : undefined;
  const opaque = c.opaque !== undefined ? takeBoundedString(c.opaque, MAX_OPAQUE_LEN) : undefined;
  return { id, realm, method, intent, request, expires, opaque };
}

// Announce presence and notify background (icon badge) when the page asks.
// Rate-limit so a hostile page cannot spam `mpp:request` and keep the SW
// awake (background only sets an icon, so impact is small — but
// defense-in-depth is cheap). 250ms is loose enough to feel instant on a
// real page load and tight enough to throttle a tight dispatch loop.
const MPP_REQUEST_THROTTLE_MS = 250;
let lastMppRequestAt = 0;
window.addEventListener('mpp:request', () => {
  const now = Date.now();
  if (now - lastMppRequestAt >= MPP_REQUEST_THROTTLE_MS) {
    lastMppRequestAt = now;
    // Fire-and-forget — background only flips the toolbar icon. The
    // `.catch` swallows the unhandled-rejection warning Chrome logs on the
    // host page when the SW happens to be unreachable.
    chrome.runtime.sendMessage({ type: MPP_REQUEST_TRIGGERED_EVENT }).catch(() => {});
  }
  // The announcement is dispatched on the page (no runtime hop), so always
  // respond — pages that just want to discover the wallet shouldn't be
  // collateral damage of the throttle.
  window.dispatchEvent(new CustomEvent('mpp:response', { detail: announcement }));
});

// Handle payment requests dispatched by the page.
window.addEventListener('mpp:payRequest', (event: Event) => {
  const detail = (event as CustomEvent<MppPayDetail>).detail;
  const requestId = takeBoundedString(detail?.requestId, MAX_REQUEST_ID_LEN);
  const invoice = takeBoundedString(detail?.invoice, MAX_INVOICE_LEN);
  if (!requestId || !invoice) {
    log('[TIPT-CS] mpp:payRequest rejected: missing/invalid requestId or invoice');
    return;
  }

  const scheme = takeBoundedString(detail.scheme, MAX_SHORT_FIELD_LEN) ?? 'L402';
  const macaroon = takeBoundedString(detail.macaroon, MAX_OPAQUE_LEN);
  const token = takeBoundedString(detail.token, MAX_OPAQUE_LEN);
  const paymentChallenge = takePaymentChallenge(detail.paymentChallenge);

  log('[TIPT-CS] mpp:payRequest received, requestId:', requestId);

  void sendRuntimeMessage<PayResponse>({
    type: PAY_REQUEST_402,
    payload: {
      source: 'mpp',
      url: window.location.href,
      method: 'GET',
      challenge: {
        scheme,
        invoice,
        macaroon,
        token,
        paymentChallenge,
      },
    },
  })
    .then((response) => {
      log('[TIPT-CS] Payment response:', response);
      window.dispatchEvent(new CustomEvent('mpp:payResponse', {
        detail: {
          requestId,
          approved: response.approved,
          authorization: response.authorization,
          error: response.error,
        },
      }));
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Payment failed.';
      log('[TIPT-CS] Payment error:', message);
      window.dispatchEvent(new CustomEvent('mpp:payResponse', {
        detail: { requestId, approved: false, error: message },
      }));
    });
});
