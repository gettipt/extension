/// <reference types="chrome" />
import { payInvoiceFromSession } from './wallet-service';

interface OffscreenPayRequest {
  type: 'TIPT_OFFSCREEN_PAY_INVOICE';
  payload?: {
    invoice?: string;
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

  const invoice = request.payload?.invoice;
  if (!invoice || typeof invoice !== 'string') {
    sendResponse({ ok: false, error: 'Missing invoice for offscreen payment.' } satisfies OffscreenPayResponse);
    return;
  }

  (async () => {
    try {
      const payment = await payInvoiceFromSession(invoice);
      sendResponse({ ok: true, preimage: payment.preimage } satisfies OffscreenPayResponse);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to pay invoice.';
      sendResponse({ ok: false, error: message } satisfies OffscreenPayResponse);
    }
  })();

  return true;
});
