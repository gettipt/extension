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
import { classifyPaymentTarget, type PaymentKind } from './lib/payment-target';
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
// "Wallet not configured" attention badge — drawn on top of the green icon
// as an orange dot/exclamation when the page asks for a wallet but the user
// hasn't created/restored one yet. The badge text is a single character
// because Chrome truncates anything longer to fit the small badge area.
const ATTENTION_BADGE_TEXT = '!';
const ATTENTION_BADGE_COLOR = '#f59e0b';
const ALARM_PREFIX = 'tipt-confirm-';
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

// Initial confirm popup geometry. Anchored to the top-right of the user's
// currently focused browser window so the prompt appears in the same place
// that extensions like Honey and Rakuten use for their in-page toasts,
// rather than wherever Chrome decides to place an unpositioned popup
// window. Width and height are only the *initial* size — `ConfirmApp`
// resizes the window to fit its rendered content as soon as it mounts
// (see `useAutoResizeWindow` in src/ConfirmApp.tsx) so there is never
// a vertical or horizontal scrollbar.
const CONFIRM_POPUP_WIDTH = 380;
const CONFIRM_POPUP_HEIGHT = 320;
const CONFIRM_POPUP_MARGIN = 16;

// Wallet-setup popup geometry. When a 402 arrives but the user has no wallet
// yet, we open the main extension UI (index.html) so they can create/restore
// one before the payment approval continues. index.css locks the body to
// 324px, so 360px gives a little window chrome without a horizontal
// scrollbar; the height is generous enough for the onboarding screens.
const WALLET_SETUP_POPUP_WIDTH = 360;
const WALLET_SETUP_POPUP_HEIGHT = 600;

async function getConfirmPopupTopRight(): Promise<{ left: number; top: number } | null> {
  // chrome.windows.getLastFocused returns the most recently focused window
  // — which is the user's normal browser window where the 402 request just
  // fired. Filtering to type 'normal' avoids anchoring to a previously-open
  // TIPT confirm popup (which is itself a 'popup'-type window).
  try {
    const focused = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (
      !focused ||
      typeof focused.left !== 'number' ||
      typeof focused.top !== 'number' ||
      typeof focused.width !== 'number'
    ) {
      return null;
    }
    const rightEdge = focused.left + focused.width;
    // Don't push the popup off the left edge of the host window on very
    // narrow browser windows — fall back to the window's left margin.
    const left = Math.max(
      Math.round(focused.left + CONFIRM_POPUP_MARGIN),
      Math.round(rightEdge - CONFIRM_POPUP_WIDTH - CONFIRM_POPUP_MARGIN),
    );
    const top = Math.round(focused.top + CONFIRM_POPUP_MARGIN);
    return { left, top };
  } catch {
    // Best-effort positioning. If the API call fails for any reason we let
    // Chrome place the popup wherever it likes rather than blocking the
    // approval flow.
    return null;
  }
}

// Defensive caps duplicated from content.ts. The content-script boundary
// applies these on the way in, but a future regression there (or a direct
// internal sender invoking PAY_REQUEST_402) must not be able to bypass them.
// Keep these in sync with src/content.ts.
const MAX_INVOICE_LEN = 8192;
const MAX_SHORT_FIELD_LEN = 512;
const MAX_OPAQUE_LEN = 4096;
// Payment challenge `request` may carry a serialized method request including
// full BOLT11 invoices, so it needs a larger bound than short metadata fields.
const MAX_PAYMENT_REQUEST_LEN = 4096;
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

interface OffscreenSparkTransferResponse {
  ok: boolean;
  txId?: string;
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

// Open onboarding immediately after first install so users can configure a
// wallet before they ever hit a paywalled request.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== 'install') return;
  void (async () => {
    try {
      const existing = await getSynced(WALLET_KEY);
      if (typeof existing === 'string' && existing.length > 0) return;
      await chrome.tabs.create({
        url: chrome.runtime.getURL('index.html'),
        active: true,
      });
    } catch (err) {
      log('[TIPT-BG] Failed to open onboarding tab on install:', err);
    }
  })();
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
    || s.includes('wallet setup was not completed')
    || s.includes('cannot prompt')
    || s.includes('failed to resolve request host')
    || s.includes('no invoice found')
    || s.includes('not a recognised lightning invoice or spark address')
    || s.includes('spark transfers require')
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
  // Optional payer-supplied amount. Required for Spark transfers (no
  // amount embedded in a Spark address); ignored when present alongside a
  // BOLT11 invoice (the HRP amount is always authoritative for Lightning).
  // Validation is strict on both shape and range — reject anything that
  // wouldn't safely flow through the allowlist sats arithmetic.
  let challengeAmountSats: number | undefined;
  if (ch.amountSats !== undefined) {
    if (typeof ch.amountSats !== 'number'
      || !Number.isFinite(ch.amountSats)
      || !Number.isInteger(ch.amountSats)
      || ch.amountSats <= 0
      || ch.amountSats > Number.MAX_SAFE_INTEGER) {
      return null;
    }
    challengeAmountSats = ch.amountSats;
  }
  if (ch.macaroon !== undefined && (typeof ch.macaroon !== 'string' || ch.macaroon.length > MAX_OPAQUE_LEN)) return null;
  if (ch.token !== undefined && (typeof ch.token !== 'string' || ch.token.length > MAX_OPAQUE_LEN)) return null;
  if (ch.rawHeader !== undefined && (typeof ch.rawHeader !== 'string' || ch.rawHeader.length > MAX_OPAQUE_LEN)) return null;

  let paymentChallenge: ChallengePayload['paymentChallenge'];
  if (ch.paymentChallenge !== undefined) {
    if (!ch.paymentChallenge || typeof ch.paymentChallenge !== 'object') return null;
    const pc = ch.paymentChallenge as Record<string, unknown>;
    const shortRequired: Array<'id' | 'realm' | 'method' | 'intent'> = ['id', 'realm', 'method', 'intent'];
    for (const k of shortRequired) {
      const v = pc[k];
      if (typeof v !== 'string' || v.length === 0 || v.length > MAX_SHORT_FIELD_LEN) return null;
    }
    if (
      typeof pc.request !== 'string'
      || pc.request.length === 0
      || pc.request.length > MAX_PAYMENT_REQUEST_LEN
    ) return null;
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
      amountSats: challengeAmountSats,
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
  paymentKind: PaymentKind,
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
      paymentKind: paymentKind === 'unknown' ? 'lightning' : paymentKind,
    };
    pendingConfirms.set(id, { resolve, host });
    hostsWithPendingConfirm.add(host);

    void (async () => {
      try {
        await persistConfirmDetails(id, details);
        await chrome.alarms.create(`${ALARM_PREFIX}${id}`, { when: expiresAt });
        const coords = await getConfirmPopupTopRight();
        const win = await chrome.windows.create({
          url: chrome.runtime.getURL(`confirm.html?id=${encodeURIComponent(id)}`),
          type: 'popup',
          width: CONFIRM_POPUP_WIDTH,
          height: CONFIRM_POPUP_HEIGHT,
          focused: true,
          ...(coords ?? {}),
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

// Mirrors `requestPreimageFromOffscreen` but for Spark-native transfers.
// Returns the Spark transfer id (WalletTransfer.id) — there's no Lightning
// preimage on this path. The id is purely informational for the demo; real
// integrators would treat it as an opaque receipt.
function requestSparkTransferFromOffscreen(
  receiverSparkAddress: string,
  amountSats: number,
  walletRaw: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: MSG.OFFSCREEN_SPARK_TRANSFER,
        payload: { receiverSparkAddress, amountSats, walletRaw },
      },
      (response: OffscreenSparkTransferResponse) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.ok || !response.txId) {
          reject(new Error(response?.error ?? 'Offscreen Spark transfer failed.'));
          return;
        }
        resolve(response.txId);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Wallet-setup gate
// ---------------------------------------------------------------------------
// When a 402 payment arrives but the user hasn't created or restored a wallet
// yet, open the main extension UI (index.html) as a popup so they can set one
// up, then continue the payment approval flow once the encrypted wallet blob
// lands in chrome.storage. Reuses the confirm popup's 5-minute budget and
// top-right anchoring.

// Collapses concurrent no-wallet 402 requests onto a single setup window and
// a shared completion promise, so a page firing several payRequests doesn't
// spawn a stack of onboarding windows.
let walletSetupWait: Promise<boolean> | null = null;

async function ensureWalletConfigured(): Promise<boolean> {
  const existing = await getSynced(WALLET_KEY);
  if (typeof existing === 'string' && existing.length > 0) return true;
  if (!walletSetupWait) {
    walletSetupWait = openWalletSetupAndWait().finally(() => { walletSetupWait = null; });
  }
  return walletSetupWait;
}

function openWalletSetupAndWait(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let setupWindowId: number | undefined;

    const finish = (configured: boolean, closeWindow: boolean) => {
      if (settled) return;
      settled = true;
      chrome.storage.onChanged.removeListener(onStorageChanged);
      chrome.windows.onRemoved.removeListener(onWindowRemoved);
      clearTimeout(timer);
      if (closeWindow && typeof setupWindowId === 'number') {
        chrome.windows.remove(setupWindowId).catch(() => { /* already gone */ });
      }
      resolve(configured);
    };

    // The wallet blob is written via setItemDual → chrome.storage.local (and
    // best-effort sync). Either area landing the key means setup completed.
    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'local' && areaName !== 'sync') return;
      const change = changes[WALLET_KEY];
      if (change && typeof change.newValue === 'string' && change.newValue.length > 0) {
        finish(true, true);
      }
    };

    const onWindowRemoved = (windowId: number) => {
      if (windowId !== setupWindowId) return;
      // User closed the setup window. Re-read storage in case the write raced
      // the close; otherwise treat it as "setup not completed".
      void getSynced(WALLET_KEY).then((w) => {
        finish(typeof w === 'string' && w.length > 0, false);
      });
    };

    const timer = setTimeout(() => finish(false, true), CONFIRM_TIMEOUT_MS);

    chrome.storage.onChanged.addListener(onStorageChanged);
    chrome.windows.onRemoved.addListener(onWindowRemoved);

    void (async () => {
      try {
        const coords = await getConfirmPopupTopRight();
        const win = await chrome.windows.create({
          url: chrome.runtime.getURL('index.html'),
          type: 'popup',
          width: WALLET_SETUP_POPUP_WIDTH,
          height: WALLET_SETUP_POPUP_HEIGHT,
          focused: true,
          ...(coords ?? {}),
        });
        setupWindowId = win?.id;
        // The wallet may have been created between our initial check and the
        // window opening (e.g. the user already had the popup open). Re-check
        // so we don't strand them on a redundant setup window.
        const w = await getSynced(WALLET_KEY);
        if (typeof w === 'string' && w.length > 0) finish(true, true);
      } catch (err) {
        log('[TIPT-BG] Failed to open wallet setup popup:', err);
        finish(false, false);
      }
    })();
  });
}

async function handle402PaymentRequest(rawPayload: unknown, sender: chrome.runtime.MessageSender) {
  const tEnter = Date.now();
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

  // Classify Lightning vs Spark up-front so all downstream logic (amount
  // resolution, prompt UI, payment routing, authorization shape) shares
  // a single branch decision. Unknown prefixes fail closed — we never
  // try to "guess" which SDK call to use.
  const paymentKind = classifyPaymentTarget(invoice);
  if (paymentKind === 'unknown') {
    log('[TIPT-BG] Payment target not recognised as Lightning or Spark');
    return { approved: false, error: 'Payment target is not a recognised Lightning invoice or Spark address.' };
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

  log('[TIPT-BG] Processing 402 payment for host:', host, 'kind:', paymentKind);
  // Fire-and-forget prewarm of the offscreen + SparkWallet SDK while the
  // user reads the confirm popup (or while auto-approve runs). Idempotent;
  // safe to call on the auto-approve path too — the offscreen short-circuits
  // when `cachedWallet` already exists, so the cost is one IPC round-trip.
  prewarmWallet();

  // Amount resolution differs by kind:
  //   * Lightning: BOLT11 amount is authoritative (any payer-supplied
  //     amountSats is ignored — the invoice signs the amount).
  //   * Spark:     no embedded amount, so the payer MUST supply one. We
  //     reject the request otherwise rather than silently prompting with
  //     "Amount unspecified" — for Spark a missing amount means we have
  //     no way to enforce caps or to call wallet.transfer.
  let amountSats: number | null;
  if (paymentKind === 'lightning') {
    amountSats = decodeBolt11AmountSats(invoice);
  } else {
    const supplied = payload.challenge.amountSats;
    if (typeof supplied !== 'number' || supplied <= 0) {
      log('[TIPT-BG] Spark transfer missing required amountSats');
      return { approved: false, error: 'Spark transfers require a positive amountSats in the payment request.' };
    }
    amountSats = supplied;
  }

  // Wallet-existence gate. If the user hasn't set up a wallet yet, open the
  // onboarding UI and wait for them to create or restore one before going any
  // further. This deliberately precedes tryAutoApprove: a host the user
  // previously allowlisted must not silently "auto-approve" into a payment we
  // cannot fulfil — we'd only discover the missing wallet at pay time and
  // bounce back an opaque failure. Gating here also lets the brand-new wallet
  // continue straight into the normal confirm/auto-approve flow.
  const walletReady = await ensureWalletConfigured();
  if (!walletReady) {
    log('[TIPT-BG] Wallet setup not completed; aborting 402 payment');
    return { approved: false, error: 'Wallet setup was not completed.' };
  }
  // The wallet may have just been created — kick off prewarm now that there's
  // something to initialise. The earlier prewarm call no-ops when no wallet
  // exists, and prewarmWallet is idempotent, so this is safe in both paths.
  prewarmWallet();

  const auto = await tryAutoApprove(host, amountSats);
  const tAutoDecided = Date.now();
  log('[TIPT-BG] Auto-approve decision:', auto, 'amount:', amountSats, `(t+${tAutoDecided - tEnter} ms)`);

  let approved = auto.approved;
  let remember = false;
  let caps: { maxSatsPerPayment: number; maxSatsPerDay: number } | undefined;
  let tPromptResolved = tAutoDecided;

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

    const prompt = await promptForPaymentApproval(payload, host, amountSats, paymentKind);
    approved = !!prompt.approved;
    remember = !!prompt.remember;
    caps = prompt.caps;
    tPromptResolved = Date.now();
    log(
      '[TIPT-BG] User prompt result - approved:', approved, 'remember:', remember,
      `(user reaction t+${tPromptResolved - tAutoDecided} ms)`,
    );
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
    // Background can read chrome.storage; the offscreen cannot. Pass the
    // encrypted wallet blob along so the offscreen can re-initialise its
    // SDK instance if Chrome reclaimed the offscreen document. The PIN
    // never crosses this boundary — the offscreen decrypts using the
    // non-extractable CryptoKey cached in shared IndexedDB.
    const walletRaw = await getSynced(WALLET_KEY);
    if (!walletRaw) {
      return { approved: false, error: 'Wallet data not found.' };
    }

    const tBeforeOffscreen = Date.now();
    await ensureOffscreen();
    const tAfterOffscreen = Date.now();

    if (paymentKind === 'lightning') {
      log('[TIPT-BG] Paying Lightning invoice:', invoice.slice(0, 20));
      const preimage = await requestPreimageFromOffscreen(invoice, walletRaw);
      const tAfterPay = Date.now();
      log(
        '[TIPT-BG] Lightning payment successful, preimage len:', preimage.length,
        `| ensureOffscreen=${tAfterOffscreen - tBeforeOffscreen} ms`,
        `payInvoice=${tAfterPay - tAfterOffscreen} ms`,
        `total=${tAfterPay - tEnter} ms`,
      );

      const authorization = buildAuthorizationValue(payload.challenge, preimage);
      if (!authorization) {
        return { approved: false, error: 'Missing Payment challenge fields for MPP credential retry.' };
      }

      return { approved: true, authorization };
    }

    // Spark transfer branch. No Lightning preimage exists, so the
    // L402/Payment Authorization builder doesn't apply — we hand the
    // transfer id back in a scheme-tagged form for symmetry. The demo
    // and any future consumer treats this as an opaque receipt.
    log('[TIPT-BG] Sending Spark transfer to:', invoice.slice(0, 24), `amount=${amountSats}`);
    if (amountSats === null) {
      // Defensive — should be unreachable because we validated above.
      return { approved: false, error: 'Spark transfers require a positive amountSats in the payment request.' };
    }
    const txId = await requestSparkTransferFromOffscreen(invoice, amountSats, walletRaw);
    const tAfterPay = Date.now();
    log(
      '[TIPT-BG] Spark transfer successful, id:', txId,
      `| ensureOffscreen=${tAfterOffscreen - tBeforeOffscreen} ms`,
      `transfer=${tAfterPay - tAfterOffscreen} ms`,
      `total=${tAfterPay - tEnter} ms`,
    );

    return { approved: true, authorization: `SparkTransfer ${txId}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to pay invoice.';
    log('[TIPT-BG] Payment failed:', message);
    return { approved: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Wallet prewarm (mpp:payRequest → spin up offscreen + SparkWallet SDK)
// ---------------------------------------------------------------------------
// When a page actually requests a payment, kick off the offscreen document
// and SparkWallet SDK initialisation in the background so the cold-start
// cost is paid in parallel with the user reading the confirm popup, rather
// than serialised onto the critical path between clicking "Approve & Pay"
// and the page receiving its mpp:payResponse.
//
// Earlier iterations of this fired on mpp:request (page-load discovery).
// That was rejected because:
//   * Every MPP-aware page visit would cause wallet network activity even
//     when the user never paid.
//   * Spark's servers would learn the user's IP on mere page visits rather
//     than only when a payment is actually requested.
// Firing on mpp:payRequest keeps Spark's view of the user identical to
// today (they only see traffic when there's a real payment in flight),
// while still getting the parallelism win.
//
// Risks remaining:
//   * If the user *declines* the confirm popup, the SDK init was wasted
//     work. Acceptable — the SDK stays cached for subsequent payments and
//     declined-after-prompt is the minority case anyway.
//   * If the wallet is locked when the payRequest arrives, prewarm fails
//     silently (we cannot unlock for them) — the confirm popup is shown
//     anyway and the actual pay step will surface the locked error.
let prewarmInflight = false;

function prewarmWallet(): void {
  if (prewarmInflight) return;
  prewarmInflight = true;
  const startedAt = Date.now();
  void (async () => {
    try {
      const walletRaw = await getSynced(WALLET_KEY);
      if (!walletRaw) {
        log('[TIPT-BG] prewarm skipped: no wallet stored');
        return;
      }
      await ensureOffscreen();
      // Errors here are routine (most commonly "Wallet is locked") and
      // must NOT surface to the user — they merely mean prewarm couldn't
      // run. The user will see a confirm popup either way, and the actual
      // pay step that follows will produce a proper user-facing error if
      // the underlying state is still bad.
      const response = await chrome.runtime.sendMessage({
        type: MSG.PREWARM_WALLET,
        payload: { walletRaw },
      }) as { ok?: boolean; error?: string } | undefined;
      if (response?.ok) {
        log(`[TIPT-BG] prewarm completed in ${Date.now() - startedAt} ms`);
      } else {
        log('[TIPT-BG] prewarm declined by offscreen:', response?.error);
      }
    } catch (err) {
      log('[TIPT-BG] prewarm failed (non-fatal):', err);
    } finally {
      prewarmInflight = false;
    }
  })();
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
      sendResponse({ ok: true, walletConfigured: false });
      return;
    }
    // Returning `true` keeps the SW alive (and the message channel open)
    // until both the storage read and the icon/badge writes resolve. Without
    // this, Chrome may unload the SW mid-await and silently drop the swap,
    // especially when the worker had just spun up to handle this one
    // message.
    void (async () => {
      let walletConfigured = false;
      try {
        const walletRaw = await getSynced(WALLET_KEY);
        walletConfigured = typeof walletRaw === 'string' && walletRaw.length > 0;
      } catch {
        // Treat storage failure as "no wallet" rather than failing the
        // discovery handshake — pages can still call mpp:payRequest and
        // surface the eventual failure to the user.
      }

      const iconPromise = chrome.action
        .setIcon({ tabId, path: GREEN_ICON })
        .catch(() => { /* best-effort */ });

      let badgePromise: Promise<void> | Promise<unknown> = Promise.resolve();
      if (walletConfigured) {
        // Clear any prior attention badge — the user may have just finished
        // creating/restoring their wallet since the last mpp:request on
        // this tab and we want to drop the orange dot immediately.
        badgePromise = chrome.action
          .setBadgeText({ tabId, text: '' })
          .catch(() => { /* best-effort */ });
      } else {
        badgePromise = Promise.all([
          chrome.action.setBadgeBackgroundColor({ tabId, color: ATTENTION_BADGE_COLOR })
            .catch(() => { /* best-effort */ }),
          chrome.action.setBadgeText({ tabId, text: ATTENTION_BADGE_TEXT })
            .catch(() => { /* best-effort */ }),
        ]);
      }

      try {
        await Promise.all([iconPromise, badgePromise]);
      } finally {
        sendResponse({ ok: true, walletConfigured });
      }
    })();
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
