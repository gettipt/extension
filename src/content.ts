/// <reference types="chrome" />

const BRIDGE_EVENT = 'TIPT_PAGE_402';
const PAYMENT_REQUEST_EVENT = 'TIPT_402_PAYMENT_REQUEST';
const PAYMENT_RESPONSE_EVENT = 'TIPT_402_PAYMENT_RESPONSE';

interface PagePaymentRequest {
  requestId: string;
  payload: Record<string, unknown>;
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

function handleBridgeEvent(event: MessageEvent) {
  if (event.source !== window) return;

  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === BRIDGE_EVENT) {
    console.log('[TIPT-CS] Bridge event received: 402 detected');
    chrome.runtime.sendMessage({ type: 'PAGE_402_DETECTED', payload: data.payload ?? null });
    return;
  }

  if (data.type !== PAYMENT_REQUEST_EVENT) return;

  const request = data as PagePaymentRequest;
  if (typeof request.requestId !== 'string' || !request.payload) {
    console.log('[TIPT-CS] Invalid payment request event');
    return;
  }

  console.log('[TIPT-CS] Payment request received, forwarding to background, requestId:', request.requestId);
  void sendRuntimeMessage<Record<string, unknown>>({
    type: 'TIPT_402_PAY_REQUEST',
    payload: request.payload,
  })
    .then((response) => {
      console.log('[TIPT-CS] Background response received:', response);
      window.postMessage({
        type: PAYMENT_RESPONSE_EVENT,
        requestId: request.requestId,
        response,
      }, '*');
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Payment request failed.';
      console.log('[TIPT-CS] Background request failed:', message);
      window.postMessage({
        type: PAYMENT_RESPONSE_EVENT,
        requestId: request.requestId,
        response: { approved: false, error: message },
      }, '*');
    });
}

function injectPageHook() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('page-hook.js');

  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

window.addEventListener('message', handleBridgeEvent);
injectPageHook();

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
