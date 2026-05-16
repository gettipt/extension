/// <reference types="chrome" />
import { payInvoiceFromSession } from './wallet-service';

// Background service worker for icon switching based on 402 responses.

const GREY_ICON = 'greyasterisk.png';
const GREEN_ICON = 'greenasterisk.png';
const ALLOWLIST_KEY = 'tipt_402_allowlist';
const tabsWith402 = new Set<number>();

interface ChallengePayload {
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
  };
}

interface PayRequestPayload {
  source: 'fetch' | 'xhr';
  url: string;
  method: string;
  challenge: ChallengePayload;
}

interface PromptResponse {
  approved: boolean;
  remember?: boolean;
}

function getStringValue(data: unknown): string | null {
  return typeof data === 'string' && data.length > 0 ? data : null;
}

function getHostFromUrl(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).host;
  } catch {
    return null;
  }
}

async function getAllowlist(): Promise<Record<string, true>> {
  const result = await chrome.storage.local.get([ALLOWLIST_KEY]);
  const raw = result[ALLOWLIST_KEY];
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const list: Record<string, true> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === true) {
      list[key] = true;
    }
  }
  return list;
}

async function rememberHost(host: string): Promise<void> {
  const list = await getAllowlist();
  list[host] = true;
  await chrome.storage.local.set({ [ALLOWLIST_KEY]: list });
}

async function isHostRemembered(host: string): Promise<boolean> {
  const list = await getAllowlist();
  return list[host] === true;
}

function toBase64UrlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildAuthorizationValue(challenge: ChallengePayload, preimage: string): string | null {
  const scheme = challenge.scheme?.trim() || 'L402';
  if (scheme.toLowerCase() === 'payment') {
    const paymentChallenge = challenge.paymentChallenge;
    if (!paymentChallenge) {
      return null;
    }

    const challengeEcho = {
      id: paymentChallenge.id,
      realm: paymentChallenge.realm,
      method: paymentChallenge.method,
      intent: paymentChallenge.intent,
      request: paymentChallenge.request,
      ...(paymentChallenge.expires ? { expires: paymentChallenge.expires } : {}),
    };

    const credential = {
      challenge: challengeEcho,
      payload: {
        preimage,
      },
    };

    return `Payment ${toBase64UrlUtf8(JSON.stringify(credential))}`;
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

function promptForPaymentApproval(tabId: number, payload: PayRequestPayload, host: string): Promise<PromptResponse> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tabId,
      {
        type: 'TIPT_PROMPT_402_PAYMENT',
        payload: {
          host,
          url: payload.url,
          method: payload.method,
          invoice: payload.challenge.invoice,
        },
      },
      (response: PromptResponse) => {
        if (chrome.runtime.lastError) {
          resolve({ approved: false });
          return;
        }

        resolve(response ?? { approved: false });
      },
    );
  });
}

async function handle402PaymentRequest(payload: PayRequestPayload, sender: chrome.runtime.MessageSender) {
  console.log('[TIPT-BG] Handling 402 payment request');
  const invoice = getStringValue(payload?.challenge?.invoice);
  if (!invoice) {
    console.log('[TIPT-BG] No invoice found in challenge');
    return { approved: false, error: 'No invoice found in 402 challenge.' };
  }

  const host = getHostFromUrl(payload.url);
  if (!host) {
    console.log('[TIPT-BG] Failed to extract host from URL:', payload.url);
    return { approved: false, error: 'Failed to resolve request host for 402 payment.' };
  }

  console.log('[TIPT-BG] Processing 402 payment for host:', host);
  let approved = await isHostRemembered(host);
  let remember = false;

  if (!approved) {
    console.log('[TIPT-BG] Host not remembered, prompting user');
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      console.log('[TIPT-BG] No tab ID available for prompt');
      return { approved: false, error: 'Cannot prompt for 402 payment approval in this context.' };
    }

    const prompt = await promptForPaymentApproval(tabId, payload, host);
    approved = !!prompt.approved;
    remember = !!prompt.remember;
    console.log('[TIPT-BG] User prompt result - approved:', approved, 'remember:', remember);
  } else {
    console.log('[TIPT-BG] Host is remembered, auto-approving');
  }

  if (!approved) {
    console.log('[TIPT-BG] Payment not approved, returning error');
    return { approved: false, error: 'Payment was not approved.' };
  }

  if (remember) {
    console.log('[TIPT-BG] Remembering host:', host);
    await rememberHost(host);
  }

  try {
    console.log('[TIPT-BG] Paying invoice:', invoice.slice(0, 20));
    const payment = await payInvoiceFromSession(invoice);
    console.log('[TIPT-BG] Payment successful, preimage:', payment.preimage.slice(0, 20));

    const authorization = buildAuthorizationValue(payload.challenge, payment.preimage);
    if (!authorization) {
      return { approved: false, error: 'Missing Payment challenge fields for MPP credential retry.' };
    }

    return {
      approved: true,
      authorization,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to pay invoice.';
    console.log('[TIPT-BG] Payment failed:', message);
    return { approved: false, error: message };
  }
}

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tab = await chrome.tabs.get(activeInfo.tabId);
  updateIcon(tab.id);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || changeInfo.url) {
    tabsWith402.delete(tabId);
    updateIcon(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabsWith402.delete(tabId);
});

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.statusCode !== 402) {
      return undefined;
    }

    if (details.tabId >= 0) {
      tabsWith402.add(details.tabId);
      updateIcon(details.tabId);
      return undefined;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTabId = tabs[0]?.id;
      if (activeTabId === undefined) {
        return;
      }

      tabsWith402.add(activeTabId);
      updateIcon(activeTabId);
    });

    return undefined;
  },
  { urls: ['<all_urls>'] },
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'PAGE_402_DETECTED') {
    console.log('[TIPT-BG] 402 detection event received');
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      return;
    }

    tabsWith402.add(tabId);
    updateIcon(tabId);
    return;
  }

  if (message?.type !== 'TIPT_402_PAY_REQUEST') {
    return;
  }

  console.log('[TIPT-BG] Payment request message received from content script');
  const payload = message.payload as PayRequestPayload;
  void handle402PaymentRequest(payload, sender).then((response) => {
    console.log('[TIPT-BG] Sending payment response:', response);
    sendResponse(response);
  });

  return true;
});

function updateIcon(tabId?: number) {
  if (tabId === undefined) return;

  const iconPath = tabsWith402.has(tabId) ? GREEN_ICON : GREY_ICON;

  chrome.action.setIcon({
    tabId,
    path: iconPath,
  });
}

// Set initial icon when service worker loads
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs[0]) {
    updateIcon(tabs[0].id);
  }
});
