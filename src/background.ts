/// <reference types="chrome" />

import { log } from './lib/logger';

// Background service worker.

const GREEN_ICON = 'greenasterisk.png';
const MPP_REQUEST_TRIGGERED_EVENT = 'TIPT_MPP_REQUEST_TRIGGERED';
const ALLOWLIST_KEY = 'tipt_402_allowlist';
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
let allowlistCache: Record<string, true> | null = null;
let allowlistLoadPromise: Promise<Record<string, true>> | null = null;
let offscreenInitPromise: Promise<void> | null = null;

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
    opaque?: string;
  };
}

interface PayRequestPayload {
  source: 'fetch' | 'xhr' | 'mpp';
  url: string;
  method: string;
  challenge: ChallengePayload;
}

interface PromptResponse {
  approved: boolean;
  remember?: boolean;
}

interface OffscreenPayResponse {
  ok: boolean;
  preimage?: string;
  error?: string;
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
  if (allowlistCache) {
    return allowlistCache;
  }

  if (allowlistLoadPromise) {
    return allowlistLoadPromise;
  }

  allowlistLoadPromise = (async () => {
  const result = await chrome.storage.local.get([ALLOWLIST_KEY]);
  const raw = result[ALLOWLIST_KEY];
  if (!raw || typeof raw !== 'object') {
      allowlistCache = {};
      return allowlistCache;
  }

  const list: Record<string, true> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === true) {
      list[key] = true;
    }
  }
    allowlistCache = list;
    return allowlistCache;
  })();

  try {
    return await allowlistLoadPromise;
  } finally {
    allowlistLoadPromise = null;
  }
}

async function rememberHost(host: string): Promise<void> {
  const list = await getAllowlist();
  list[host] = true;
  allowlistCache = list;
  await chrome.storage.local.set({ [ALLOWLIST_KEY]: list });
}

async function isHostRemembered(host: string): Promise<boolean> {
  const list = await getAllowlist();
  return list[host] === true;
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') {
    return;
  }

  if (!(ALLOWLIST_KEY in changes)) {
    return;
  }

  const newValue = changes[ALLOWLIST_KEY]?.newValue;
  if (!newValue || typeof newValue !== 'object') {
    allowlistCache = {};
    return;
  }

  const parsed: Record<string, true> = {};
  for (const [key, value] of Object.entries(newValue as Record<string, unknown>)) {
    if (value === true) {
      parsed[key] = true;
    }
  }
  allowlistCache = parsed;
});

function toBase64UrlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// RFC 8785 JSON Canonicalization Scheme: sorts object keys lexicographically (Unicode code point order)
function jcsStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(jcsStringify).join(',') + ']';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const pairs = Object.keys(obj)
      .sort()
      .map(k => JSON.stringify(k) + ':' + jcsStringify(obj[k]));
    return '{' + pairs.join(',') + '}';
  }
  return JSON.stringify(value);
}

function decodeOpaqueToObject(opaque: string): Record<string, string> | undefined {
  try {
    // The opaque is base64url-encoded JSON. Older mppx server versions expect
    // the decoded object in the credential echo, not the raw base64url string.
    const json = atob(opaque.replace(/-/g, '+').replace(/_/g, '/').padEnd(
      opaque.length + (4 - opaque.length % 4) % 4, '=',
    ));
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // If decode fails, fall back to omitting opaque
  }
  return undefined;
}

function buildAuthorizationValue(challenge: ChallengePayload, preimage: string): string | null {
  const scheme = challenge.scheme?.trim() || 'L402';
  if (scheme.toLowerCase() === 'payment') {
    const paymentChallenge = challenge.paymentChallenge;
    if (!paymentChallenge) {
      return null;
    }

    // Decode opaque from base64url to its JSON object. Older server-side mppx
    // versions expect the opaque as an object (legacy format) rather than the
    // spec-compliant base64url string introduced in newer versions.
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
      payload: {
        preimage,
      },
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

interface PendingConfirm {
  details: { host: string; url: string; method: string; invoice: string };
  resolve: (response: PromptResponse) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const pendingConfirms = new Map<string, PendingConfirm>();
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

function promptForPaymentApproval(_tabId: number, payload: PayRequestPayload, host: string): Promise<PromptResponse> {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const details = {
      host,
      url: payload.url,
      method: payload.method,
      invoice: payload.challenge.invoice,
    };
    const timeoutId = setTimeout(() => {
      const pending = pendingConfirms.get(id);
      if (pending) {
        pendingConfirms.delete(id);
        pending.resolve({ approved: false });
      }
    }, CONFIRM_TIMEOUT_MS);
    pendingConfirms.set(id, { details, resolve, timeoutId });
    chrome.windows.create({
      url: chrome.runtime.getURL(`confirm.html?id=${encodeURIComponent(id)}`),
      type: 'popup',
      width: 380,
      height: 460,
      focused: true,
    }).catch(() => {
      const pending = pendingConfirms.get(id);
      if (pending) {
        clearTimeout(pending.timeoutId);
        pendingConfirms.delete(id);
        pending.resolve({ approved: false });
      }
    });
  });
}

async function ensureOffscreenDocument(): Promise<void> {
  if (!chrome.offscreen?.createDocument) {
    throw new Error('Offscreen documents are not supported in this Chrome runtime.');
  }

  if (!offscreenInitPromise) {
    offscreenInitPromise = (async () => {
      if (chrome.offscreen.hasDocument) {
        const hasDocument = await chrome.offscreen.hasDocument();
        if (hasDocument) {
          return;
        }
      }

      try {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_DOCUMENT_PATH,
          reasons: ['LOCAL_STORAGE'],
          justification: 'Process Spark SDK invoice payments outside the service worker runtime.',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('Only a single offscreen document may be created')) {
          throw error;
        }
      }
    })().finally(() => {
      offscreenInitPromise = null;
    });
  }

  await offscreenInitPromise;
}

function requestPreimageFromOffscreen(
  invoice: string,
  sessionPin: string,
  pinRaw: string,
  walletRaw: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: 'TIPT_OFFSCREEN_PAY_INVOICE',
        payload: { invoice, sessionPin, pinRaw, walletRaw },
      },
      (response: OffscreenPayResponse) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (!response?.ok || !response.preimage) {
          reject(new Error(response?.error ?? 'Offscreen payment failed.'));
          return;
        }

        resolve(response.preimage);
      },
    );
  });
}

async function handle402PaymentRequest(payload: PayRequestPayload, sender: chrome.runtime.MessageSender) {
  log('[TIPT-BG] Handling 402 payment request');
  const invoice = getStringValue(payload?.challenge?.invoice);
  if (!invoice) {
    log('[TIPT-BG] No invoice found in challenge');
    return { approved: false, error: 'No invoice found in 402 challenge.' };
  }

  const host = getHostFromUrl(payload.url);
  if (!host) {
    log('[TIPT-BG] Failed to extract host from URL:', payload.url);
    return { approved: false, error: 'Failed to resolve request host for 402 payment.' };
  }

  log('[TIPT-BG] Processing 402 payment for host:', host);
  let approved = await isHostRemembered(host);
  let remember = false;

  if (!approved) {
    log('[TIPT-BG] Host not remembered, prompting user');
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      log('[TIPT-BG] No tab ID available for prompt');
      return { approved: false, error: 'Cannot prompt for 402 payment approval in this context.' };
    }

    const prompt = await promptForPaymentApproval(tabId, payload, host);
    approved = !!prompt.approved;
    remember = !!prompt.remember;
    log('[TIPT-BG] User prompt result - approved:', approved, 'remember:', remember);
  } else {
    log('[TIPT-BG] Host is remembered, auto-approving');
  }

  if (!approved) {
    log('[TIPT-BG] Payment not approved, returning error');
    return { approved: false, error: 'Payment was not approved.' };
  }

  if (remember) {
    log('[TIPT-BG] Remembering host:', host);
    await rememberHost(host);
  }

  try {
    log('[TIPT-BG] Paying invoice:', invoice.slice(0, 20));

    // Read credentials in background (offscreen docs lack chrome.storage access).
    const sessionItems = await chrome.storage.session.get(['spark_session_pin']);
    const sessionPin = typeof sessionItems['spark_session_pin'] === 'string' ? sessionItems['spark_session_pin'] : null;
    if (!sessionPin) {
      return { approved: false, error: 'Wallet is locked. Open TIPT and unlock first.' };
    }
    const localItems = await chrome.storage.local.get(['spark_pin', 'spark_wallet']);
    const syncItems = await chrome.storage.sync.get(['spark_pin', 'spark_wallet']);
    const pinRaw = typeof localItems['spark_pin'] === 'string' ? localItems['spark_pin']
      : typeof syncItems['spark_pin'] === 'string' ? syncItems['spark_pin'] : null;
    const walletRaw = typeof localItems['spark_wallet'] === 'string' ? localItems['spark_wallet']
      : typeof syncItems['spark_wallet'] === 'string' ? syncItems['spark_wallet'] : null;
    if (!pinRaw || !walletRaw) {
      return { approved: false, error: 'Wallet data not found.' };
    }

    await ensureOffscreenDocument();
    const preimage = await requestPreimageFromOffscreen(invoice, sessionPin, pinRaw, walletRaw);
    log('[TIPT-BG] Payment successful, preimage:', preimage, '(len:', preimage.length, ')');

    const authorization = buildAuthorizationValue(payload.challenge, preimage);
    if (!authorization) {
      return { approved: false, error: 'Missing Payment challenge fields for MPP credential retry.' };
    }

    return {
      approved: true,
      authorization,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to pay invoice.';
    log('[TIPT-BG] Payment failed:', message);
    return { approved: false, error: message };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === MPP_REQUEST_TRIGGERED_EVENT) {
    log('[TIPT-BG] mpp:request listener trigger received');
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      chrome.action.setIcon({ tabId, path: GREEN_ICON });
    }
    return;
  }

  if (message?.type === 'TIPT_402_CONFIRM_READY') {
    const id = message.payload?.id;
    const pending = typeof id === 'string' ? pendingConfirms.get(id) : undefined;
    if (!pending) {
      sendResponse({ ok: false, error: 'Payment request not found or expired.' });
      return;
    }
    sendResponse({ ok: true, details: pending.details });
    return;
  }

  if (message?.type === 'TIPT_402_CONFIRM_RESPONSE') {
    const id = message.payload?.id;
    const approved = !!message.payload?.approved;
    const remember = !!message.payload?.remember;
    const pending = typeof id === 'string' ? pendingConfirms.get(id) : undefined;
    if (pending) {
      clearTimeout(pending.timeoutId);
      pendingConfirms.delete(id);
      pending.resolve({ approved, remember });
    }
    sendResponse({ ok: true });
    return;
  }

  if (message?.type !== 'TIPT_402_PAY_REQUEST') {
    return;
  }

  log('[TIPT-BG] Payment request message received from content script');
  const payload = message.payload as PayRequestPayload;
  void handle402PaymentRequest(payload, sender).then((response) => {
    log('[TIPT-BG] Sending payment response:', response);
    sendResponse(response);
  });

  return true;
});

