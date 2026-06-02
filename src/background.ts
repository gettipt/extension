/// <reference types="chrome" />

import { log } from './lib/logger';
import { ensureOffscreen } from './lib/offscreen';
import { clearUnlockKey } from './lib/key-store';
import { isInternalSender } from './lib/runtime';
import { getSynced } from './lib/storage';
import { nonEmptyString } from './lib/object-helpers';
import {
  pendingConfirmStorageKey,
  type PersistedConfirmDetails,
} from './lib/confirm-protocol';
import { WALLET_KEY } from './constants';
import { decodeBolt11AmountSats } from './lib/bolt11';
import { MSG } from './lib/messages';
import { scrubLegacyState } from './lib/migrate-legacy';
import {
  tryAutoApprove,
  rememberHost,
  loadAllowlist,
  removeHost,
  listAllowlist,
} from './lib/allowlist';
import {
  buildAuthorizationValue,
  type ChallengePayload,
} from './lib/auth-credentials';

// Background service worker.

const GREEN_ICON = 'greenasterisk.png';
const ALARM_PREFIX = 'tipt-confirm-';
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

// Defensive caps duplicated from content.ts. The content-script boundary
// applies these on the way in, but a future regression there (or a direct
// internal sender invoking PAY_REQUEST_402) must not be able to bypass them.
// Keep these in sync with src/content.ts.
const MAX_INVOICE_LEN = 8192;
const MAX_SHORT_FIELD_LEN = 512;
const MAX_OPAQUE_LEN = 4096;
const MAX_REQUEST_ID_LEN = 256;

interface PayRequestPayload {
  source: 'fetch' | 'xhr' | 'mpp';
  url: string;
  method: string;
  challenge: ChallengePayload;
}

interface PromptResponse {
  approved: boolean;
  remember?: boolean;
  caps?: { maxSatsPerPayment: number; maxSatsPerDay: number };
}

interface OffscreenPayResponse {
  ok: boolean;
  preimage?: string;
  error?: string;
}

function getHostFromUrl(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).host;
  } catch {
    return null;
  }
}

// The confirm popup is the only context allowed to drive the per-request
// approval handshake. Restrict acceptance to messages whose sender URL is
// our own confirm.html.
function isConfirmPopup(sender: chrome.runtime.MessageSender): boolean {
  if (!isInternalSender(sender)) return false;
  const expected = chrome.runtime.getURL('confirm.html');
  return typeof sender.url === 'string' && sender.url.startsWith(expected);
}

// Mimic chrome.storage.session lifetime for the IndexedDB-cached unlock key:
// wipe it on browser startup so a stolen-laptop attacker can't reuse a
// previously-unlocked key after power-cycling. Also clear the legacy
// spark_session_pin entry from old installs.
chrome.runtime.onStartup.addListener(() => {
  void clearUnlockKey();
  scrubLegacyState();
});

// ---------------------------------------------------------------------------
// 402 error sanitisation
// ---------------------------------------------------------------------------
// The raw error strings inside handle402PaymentRequest leak wallet-state
// fingerprints to the calling page ("Wallet is locked", "Wallet data not
// found", SDK internals, etc.). Map them to one of four opaque codes at the
// background→content boundary so the page only learns success/failure plus
// a coarse category. Internal logs still get full detail.
export type Mpp402ErrorCode = 'declined' | 'unavailable' | 'locked' | 'failed';

function sanitise402Error(raw: string | undefined): Mpp402ErrorCode {
  if (!raw) return 'failed';
  const s = raw.toLowerCase();
  if (s.includes('wallet is locked')) return 'locked';
  if (s.includes('was not approved') || s.includes('previous payment approval')) return 'declined';
  if (
    s.includes('wallet data not found')
    || s.includes('wallet not initialized')
    || s.includes('cannot prompt')
    || s.includes('failed to resolve request host')
    || s.includes('no invoice found')
    || s.includes('missing payment challenge fields')
  ) return 'unavailable';
  return 'failed';
}

// ---------------------------------------------------------------------------
// Background-side payload re-validation
// ---------------------------------------------------------------------------
// content.ts already caps each MPP field at the page boundary. Re-apply the
// same caps here so a future regression in the content script (or a direct
// internal sender) can never push unbounded strings into the JCS canonicaliser
// or the SDK. Returns the trusted payload, or null if any field is malformed.
function validate402Payload(payload: unknown): PayRequestPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (p.source !== 'fetch' && p.source !== 'xhr' && p.source !== 'mpp') return null;
  if (typeof p.url !== 'string' || p.url.length === 0 || p.url.length > MAX_REQUEST_ID_LEN * 8) return null;
  if (typeof p.method !== 'string' || p.method.length === 0 || p.method.length > MAX_SHORT_FIELD_LEN) return null;
  const challenge = p.challenge;
  if (!challenge || typeof challenge !== 'object') return null;
  const ch = challenge as Record<string, unknown>;
  const scheme = typeof ch.scheme === 'string' ? ch.scheme : '';
  if (scheme.length > MAX_SHORT_FIELD_LEN) return null;
  if (typeof ch.invoice !== 'string' || ch.invoice.length === 0 || ch.invoice.length > MAX_INVOICE_LEN) return null;
  if (ch.macaroon !== undefined && (typeof ch.macaroon !== 'string' || ch.macaroon.length > MAX_OPAQUE_LEN)) return null;
  if (ch.token !== undefined && (typeof ch.token !== 'string' || ch.token.length > MAX_OPAQUE_LEN)) return null;
  if (ch.rawHeader !== undefined && (typeof ch.rawHeader !== 'string' || ch.rawHeader.length > MAX_OPAQUE_LEN)) return null;

  let paymentChallenge: ChallengePayload['paymentChallenge'];
  if (ch.paymentChallenge !== undefined) {
    if (!ch.paymentChallenge || typeof ch.paymentChallenge !== 'object') return null;
    const pc = ch.paymentChallenge as Record<string, unknown>;
    const required: Array<'id' | 'realm' | 'method' | 'intent' | 'request'> = ['id', 'realm', 'method', 'intent', 'request'];
    for (const k of required) {
      const v = pc[k];
      if (typeof v !== 'string' || v.length === 0 || v.length > MAX_SHORT_FIELD_LEN) return null;
    }
    if (pc.expires !== undefined && (typeof pc.expires !== 'string' || pc.expires.length > MAX_SHORT_FIELD_LEN)) return null;
    if (pc.opaque !== undefined && (typeof pc.opaque !== 'string' || pc.opaque.length > MAX_OPAQUE_LEN)) return null;
    paymentChallenge = {
      id: pc.id as string,
      realm: pc.realm as string,
      method: pc.method as string,
      intent: pc.intent as string,
      request: pc.request as string,
      expires: pc.expires as string | undefined,
      opaque: pc.opaque as string | undefined,
    };
  }

  return {
    source: p.source,
    url: p.url,
    method: p.method,
    challenge: {
      scheme,
      invoice: ch.invoice,
      rawHeader: ch.rawHeader as string | undefined,
      macaroon: ch.macaroon as string | undefined,
      token: ch.token as string | undefined,
      paymentChallenge,
    },
  };
}

// ---------------------------------------------------------------------------
// Pending confirm state
// ---------------------------------------------------------------------------
// The Promise resolver lives in-memory (it cannot be serialised). MV3 keeps
// the service worker alive while the awaited `sendResponse` is pending — up
// to a 5-minute hard cap — which matches CONFIRM_TIMEOUT_MS. If the worker
// is recycled before the user responds, the in-memory resolver is lost and
// the awaiting content-script message channel will close. The alarm and the
// chrome.storage.session entry ensure we still clean up persisted state in
// that case, and that the confirm popup can rehydrate display details
// without an extra round-trip to the worker.

interface PendingConfirm {
  resolve: (response: PromptResponse) => void;
  host: string;
  windowId?: number;
}
const pendingConfirms = new Map<string, PendingConfirm>();
// Track in-flight confirm hosts so a single hostile page cannot spam
// chrome.windows.create and pile up dozens of focus-stealing prompts.
// Once a host has a pending confirm, any new TIPT_402_PAY_REQUEST from
// that host is rejected until the existing one resolves or expires.
const hostsWithPendingConfirm = new Set<string>();

async function persistConfirmDetails(id: string, details: PersistedConfirmDetails): Promise<void> {
  await chrome.storage.session.set({ [pendingConfirmStorageKey(id)]: details });
}

async function clearConfirmDetails(id: string): Promise<void> {
  await chrome.storage.session.remove(pendingConfirmStorageKey(id)).catch(() => { /* best-effort */ });
  await chrome.alarms.clear(`${ALARM_PREFIX}${id}`).catch(() => { /* best-effort */ });
}

function resolvePendingConfirm(id: string, response: PromptResponse): void {
  const pending = pendingConfirms.get(id);
  if (!pending) return;
  pendingConfirms.delete(id);
  hostsWithPendingConfirm.delete(pending.host);
  const windowId = pending.windowId;
  pending.resolve(response);
  // Drop the X-close watcher now that we own the resolution. Calling
  // chrome.windows.remove on an already-closed window is fine.
  if (windowId !== undefined) confirmWindowToId.delete(windowId);
}

// Maps the confirm-popup chrome window id to its pending request id so the
// onRemoved listener can mark a user-X-closed window as a decline without
// waiting up to 5 minutes for the alarm.
const confirmWindowToId = new Map<number, string>();

function promptForPaymentApproval(
  payload: PayRequestPayload,
  host: string,
  amountSats: number | null,
): Promise<PromptResponse> {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const expiresAt = Date.now() + CONFIRM_TIMEOUT_MS;
    const details: PersistedConfirmDetails = {
      host,
      url: payload.url,
      method: payload.method,
      invoice: payload.challenge.invoice,
      amountSats,
      expiresAt,
    };
    pendingConfirms.set(id, { resolve, host });
    hostsWithPendingConfirm.add(host);

    void (async () => {
      try {
        await persistConfirmDetails(id, details);
        await chrome.alarms.create(`${ALARM_PREFIX}${id}`, { when: expiresAt });
        const win = await chrome.windows.create({
          url: chrome.runtime.getURL(`confirm.html?id=${encodeURIComponent(id)}`),
          type: 'popup',
          width: 380,
          height: 540,
          focused: true,
        });
        if (typeof win?.id === 'number') {
          confirmWindowToId.set(win.id, id);
          const pending = pendingConfirms.get(id);
          if (pending) pending.windowId = win.id;
        }
      } catch (err) {
        log('[TIPT-BG] Failed to open confirm popup:', err);
        await clearConfirmDetails(id);
        resolvePendingConfirm(id, { approved: false });
      }
    })();
  });
}

// Treat a user closing the confirm popup with [X] as an immediate decline.
// Without this, hostsWithPendingConfirm keeps the host locked out of new
// 402 requests until the 5-min alarm expires.
chrome.windows.onRemoved.addListener((windowId) => {
  const id = confirmWindowToId.get(windowId);
  if (!id) return;
  confirmWindowToId.delete(windowId);
  if (!pendingConfirms.has(id)) return;
  resolvePendingConfirm(id, { approved: false });
  void clearConfirmDetails(id);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  const id = alarm.name.slice(ALARM_PREFIX.length);
  resolvePendingConfirm(id, { approved: false });
  void chrome.storage.session.remove(pendingConfirmStorageKey(id)).catch(() => { /* best-effort */ });
});

function requestPreimageFromOffscreen(invoice: string, walletRaw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: MSG.OFFSCREEN_PAY_INVOICE,
        payload: { invoice, walletRaw },
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

async function handle402PaymentRequest(rawPayload: unknown, sender: chrome.runtime.MessageSender) {
  log('[TIPT-BG] Handling 402 payment request');
  const payload = validate402Payload(rawPayload);
  if (!payload) {
    log('[TIPT-BG] 402 payload failed re-validation; dropping');
    return { approved: false, error: 'No invoice found in 402 challenge.' };
  }
  const invoice = nonEmptyString(payload.challenge.invoice);
  if (!invoice) {
    log('[TIPT-BG] No invoice found in challenge');
    return { approved: false, error: 'No invoice found in 402 challenge.' };
  }

  // SECURITY: derive the host from `sender.url` (or `sender.tab?.url`),
  // which the browser sets to the URL of the frame that dispatched the
  // CustomEvent — NEVER from `payload.url`, which is page-supplied and
  // therefore spoofable. A malicious page could otherwise claim
  // `url: 'https://victim-you-allowlisted.com/'` and trigger auto-approve.
  const authoritativeUrl = sender.url ?? sender.tab?.url;
  const host = authoritativeUrl ? getHostFromUrl(authoritativeUrl) : null;
  if (!host) {
    log('[TIPT-BG] Failed to extract host from sender URL');
    return { approved: false, error: 'Failed to resolve request host for 402 payment.' };
  }

  log('[TIPT-BG] Processing 402 payment for host:', host);
  const amountSats = decodeBolt11AmountSats(invoice);
  const auto = await tryAutoApprove(host, amountSats);
  log('[TIPT-BG] Auto-approve decision:', auto, 'amount:', amountSats);

  let approved = auto.approved;
  let remember = false;
  let caps: { maxSatsPerPayment: number; maxSatsPerDay: number } | undefined;

  if (!approved) {
    if (sender.tab?.id === undefined) {
      log('[TIPT-BG] No tab ID available for prompt');
      return { approved: false, error: 'Cannot prompt for 402 payment approval in this context.' };
    }

    // Reject piling up multiple confirm popups for the same host so a
    // hostile page cannot spam window.dispatchEvent and create a
    // focus-stealing DoS. The existing prompt must resolve (approve,
    // decline, or 5-minute alarm expiry) before this host can request
    // another approval.
    if (hostsWithPendingConfirm.has(host)) {
      log('[TIPT-BG] Rejecting duplicate confirm for host:', host);
      return { approved: false, error: 'A previous payment approval is still pending for this site.' };
    }

    const prompt = await promptForPaymentApproval(payload, host, amountSats);
    approved = !!prompt.approved;
    remember = !!prompt.remember;
    caps = prompt.caps;
    log('[TIPT-BG] User prompt result - approved:', approved, 'remember:', remember);
  }

  if (!approved) {
    log('[TIPT-BG] Payment not approved, returning error');
    return { approved: false, error: 'Payment was not approved.' };
  }

  if (remember && caps && amountSats !== null && amountSats > 0) {
    log('[TIPT-BG] Remembering host with caps:', host, caps);
    try {
      await rememberHost(host, {
        maxSatsPerPayment: caps.maxSatsPerPayment,
        maxSatsPerDay: caps.maxSatsPerDay,
        initialSpentSats: amountSats,
      });
    } catch (err) {
      log('[TIPT-BG] Failed to remember host:', err);
    }
  }

  try {
    log('[TIPT-BG] Paying invoice:', invoice.slice(0, 20));

    // Background can read chrome.storage; the offscreen cannot. Pass the
    // encrypted wallet blob along so the offscreen can re-initialise its
    // SDK instance if Chrome reclaimed the offscreen document. The PIN
    // never crosses this boundary — the offscreen decrypts using the
    // non-extractable CryptoKey cached in shared IndexedDB.
    const walletRaw = await getSynced(WALLET_KEY);
    if (!walletRaw) {
      return { approved: false, error: 'Wallet data not found.' };
    }

    await ensureOffscreen();
    const preimage = await requestPreimageFromOffscreen(invoice, walletRaw);
    log('[TIPT-BG] Payment successful, preimage len:', preimage.length);

    const authorization = buildAuthorizationValue(payload.challenge, preimage);
    if (!authorization) {
      return { approved: false, error: 'Missing Payment challenge fields for MPP credential retry.' };
    }

    return { approved: true, authorization };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to pay invoice.';
    log('[TIPT-BG] Payment failed:', message);
    return { approved: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Message dispatch
// ---------------------------------------------------------------------------

type MessageHandler = (
  message: { type: string; payload?: Record<string, unknown> },
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | void;

const handlers: Record<string, MessageHandler> = {
  [MSG.MPP_REQUEST_TRIGGERED](_message, sender, sendResponse) {
    log('[TIPT-BG] mpp:request listener trigger received');
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({ ok: true });
      return;
    }
    // Returning `true` keeps the SW alive (and the message channel open)
    // until `setIcon` resolves. Without this, Chrome may unload the SW
    // mid-await and silently drop the icon swap, especially when the
    // worker had just spun up to handle this one message.
    chrome.action
      .setIcon({ tabId, path: GREEN_ICON })
      .catch(() => { /* best-effort */ })
      .finally(() => sendResponse({ ok: true }));
    return true;
  },

  [MSG.CONFIRM_RESPONSE_402](message, sender, sendResponse) {
    if (!isConfirmPopup(sender)) {
      sendResponse({ ok: false, error: 'Unauthorized sender.' });
      return;
    }
    const payload = message.payload ?? {};
    const id = typeof payload.id === 'string' ? payload.id : '';
    const approved = !!payload.approved;
    const remember = !!payload.remember;
    const rawCaps = payload.caps;
    let caps: { maxSatsPerPayment: number; maxSatsPerDay: number } | undefined;
    if (remember && rawCaps && typeof rawCaps === 'object') {
      const c = rawCaps as { maxSatsPerPayment?: unknown; maxSatsPerDay?: unknown };
      const perPayment = typeof c.maxSatsPerPayment === 'number' && Number.isFinite(c.maxSatsPerPayment)
        ? Math.max(0, Math.floor(c.maxSatsPerPayment)) : 0;
      const perDay = typeof c.maxSatsPerDay === 'number' && Number.isFinite(c.maxSatsPerDay)
        ? Math.max(0, Math.floor(c.maxSatsPerDay)) : 0;
      if (perPayment > 0) caps = { maxSatsPerPayment: perPayment, maxSatsPerDay: perDay };
    }
    if (id) resolvePendingConfirm(id, { approved, remember, caps });
    void clearConfirmDetails(id);
    sendResponse({ ok: true });
  },

  [MSG.ALLOWLIST_LIST_402](_message, sender, sendResponse) {
    if (!isInternalSender(sender)) {
      sendResponse({ ok: false, error: 'Unauthorized sender.' });
      return true;
    }
    void (async () => {
      try {
        const entries = await listAllowlist();
        sendResponse({ ok: true, entries });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  },

  [MSG.ALLOWLIST_REMOVE_402](message, sender, sendResponse) {
    if (!isInternalSender(sender)) {
      sendResponse({ ok: false, error: 'Unauthorized sender.' });
      return true;
    }
    const host = typeof message.payload?.host === 'string' ? message.payload.host : '';
    if (!host) {
      sendResponse({ ok: false, error: 'Missing host.' });
      return true;
    }
    void (async () => {
      try {
        await removeHost(host);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  },

  [MSG.PAY_REQUEST_402](message, sender, sendResponse) {
    // 402 payment requests must originate from a content script in a real tab.
    if (!sender.tab || !sender.url) {
      log('[TIPT-BG] 402 request missing sender.tab/sender.url; dropping');
      return;
    }

    log('[TIPT-BG] Payment request message received from content script');
    void handle402PaymentRequest(message.payload, sender).then((response) => {
      log('[TIPT-BG] Sending payment response:', response);
      // Sanitise any error string before it crosses back to the page so the
      // site only learns one of four coarse codes — never wallet internals.
      // Approved responses pass through unchanged.
      const sanitised = response.approved
        ? response
        : { approved: false as const, error: sanitise402Error(response.error) };
      sendResponse(sanitised);
    });
    return true;
  },
};

// Same defensive pattern as the offscreen listener: ignore messages without
// a matching handler BEFORE doing any sender-validation work. Both contexts
// share the chrome.runtime.onMessage channel; staying out of the dispatch
// race for messages we don't own keeps the sender's promise wired to the
// listener that actually responds.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const msg = message as { type?: string; payload?: Record<string, unknown> } | undefined;
  if (!msg || typeof msg.type !== 'string') return;
  const handler = handlers[msg.type];
  if (!handler) return;
  if (!isInternalSender(sender)) return;
  return handler(msg as { type: string; payload?: Record<string, unknown> }, sender, sendResponse);
});

// Warm the allowlist cache on SW boot so the first 402 request doesn't pay
// an extra storage round-trip. Best-effort; tryAutoApprove will load lazily
// if this fails.
void loadAllowlist().catch(() => { /* best-effort */ });
