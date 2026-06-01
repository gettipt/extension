/// <reference types="chrome" />
import { payInvoiceFromSession } from './wallet-service';

interface OffscreenPayRequest {
  type: 'TIPT_OFFSCREEN_PAY_INVOICE';
  payload?: {
    invoice?: string;
    sessionPin?: string;
    pinRaw?: string;
    walletRaw?: string;
  };
}

interface OffscreenPayResponse {
  ok: boolean;
  preimage?: string;
  error?: string;
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const request = message as OffscreenPayRequest;
  if (request?.type !== 'TIPT_OFFSCREEN_PAY_INVOICE') {
    return;
  }

  const { invoice, sessionPin, pinRaw, walletRaw } = request.payload ?? {};
  if (!invoice || typeof invoice !== 'string') {
    sendResponse({ ok: false, error: 'Missing invoice for offscreen payment.' } satisfies OffscreenPayResponse);
    return;
  }
  if (!sessionPin || !pinRaw || !walletRaw) {
    sendResponse({ ok: false, error: 'Missing wallet credentials for offscreen payment.' } satisfies OffscreenPayResponse);
    return;
  }

  (async () => {
    try {
      const payment = await payInvoiceFromSession(invoice, sessionPin, pinRaw, walletRaw);
      sendResponse({ ok: true, preimage: payment.preimage } satisfies OffscreenPayResponse);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to pay invoice.';
      sendResponse({ ok: false, error: msg } satisfies OffscreenPayResponse);
    }
  })();

  return true;
});
