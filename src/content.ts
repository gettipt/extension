/// <reference types="chrome" />

// IMPORTANT: Content scripts in MV3 are loaded as classic scripts, not ES
// modules. They cannot use `import` statements at runtime. Keep this file
// self-contained: do NOT import from any other module in this codebase.

const DEBUG = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
function log(...args: unknown[]): void { if (DEBUG) console.log(...args); }

const MPP_REQUEST_TRIGGERED_EVENT = 'TIPT_MPP_REQUEST_TRIGGERED';

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

// Announce presence and notify background (icon badge) when the page asks.
window.addEventListener('mpp:request', () => {
  chrome.runtime.sendMessage({ type: MPP_REQUEST_TRIGGERED_EVENT });
  window.dispatchEvent(new CustomEvent('mpp:announce', { detail: announcement }));
});

// Handle payment requests dispatched by the page.
window.addEventListener('mpp:pay', (event: Event) => {
  const detail = (event as CustomEvent<MppPayDetail>).detail;
  if (!detail?.requestId || !detail?.invoice) {
    log('[TIPT-CS] mpp:pay received with missing requestId or invoice');
    return;
  }

  log('[TIPT-CS] mpp:pay received, requestId:', detail.requestId);

  void sendRuntimeMessage<PayResponse>({
    type: 'TIPT_402_PAY_REQUEST',
    payload: {
      source: 'mpp',
      url: window.location.href,
      method: 'GET',
      challenge: {
        scheme: detail.scheme ?? 'L402',
        invoice: detail.invoice,
        macaroon: detail.macaroon,
        token: detail.token,
        paymentChallenge: detail.paymentChallenge,
      },
    },
  })
    .then((response) => {
      log('[TIPT-CS] Payment response:', response);
      window.dispatchEvent(new CustomEvent('mpp:payresponse', {
        detail: {
          requestId: detail.requestId,
          approved: response.approved,
          authorization: response.authorization,
          error: response.error,
        },
      }));
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Payment failed.';
      log('[TIPT-CS] Payment error:', message);
      window.dispatchEvent(new CustomEvent('mpp:payresponse', {
        detail: { requestId: detail.requestId, approved: false, error: message },
      }));
    });
});
