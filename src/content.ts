/// <reference types="chrome" />

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

// Announce wallet presence to the page.
window.dispatchEvent(new CustomEvent('mpp:announce', { detail: announcement }));

// Re-announce and notify background (icon badge) when the page asks.
window.addEventListener('mpp:request', () => {
  chrome.runtime.sendMessage({ type: MPP_REQUEST_TRIGGERED_EVENT });
  window.dispatchEvent(new CustomEvent('mpp:announce', { detail: announcement }));
});

// Handle payment requests dispatched by the page.
window.addEventListener('mpp:pay', (event: Event) => {
  const detail = (event as CustomEvent<MppPayDetail>).detail;
  if (!detail?.requestId || !detail?.invoice) {
    console.log('[TIPT-CS] mpp:pay received with missing requestId or invoice');
    return;
  }

  console.log('[TIPT-CS] mpp:pay received, requestId:', detail.requestId);

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
      console.log('[TIPT-CS] Payment response:', response);
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
      console.log('[TIPT-CS] Payment error:', message);
      window.dispatchEvent(new CustomEvent('mpp:payresponse', {
        detail: { requestId: detail.requestId, approved: false, error: message },
      }));
    });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'TIPT_PROMPT_402_PAYMENT') {
    return;
  }

  console.log('[TIPT-CS] Prompt message received from background');
  const payload = message.payload as {
    host?: string;
    invoice?: string;
    method?: string;
    url?: string;
  };

  const host = payload?.host ?? 'this site';
  const method = payload?.method ?? 'GET';
  const url = payload?.url ?? '';
  const invoicePreview = payload?.invoice
    ? `${payload.invoice.slice(0, 22)}...`
    : 'No invoice provided';

  console.log('[TIPT-CS] Showing user confirmation dialog for host:', host);
  const approved = window.confirm(
    `TIPT payment request (${host})\n\n${method} ${url}\n\nInvoice: ${invoicePreview}\n\nPay this 402 challenge now?`,
  );

  let remember = false;
  if (approved) {
    console.log('[TIPT-CS] User approved payment, asking about remember');
    remember = window.confirm('Remember approval for this host and auto-approve next 402 payment requests?');
  }
  console.log('[TIPT-CS] User response - approved:', approved, 'remember:', remember);

  sendResponse({ approved, remember });
  return true;
});
