/// <reference types="chrome" />
import {
  initWalletFromMnemonic,
  getWalletBalance,
  getWalletTransfers,
  createWalletInvoice,
  getWalletFeeEstimate,
  payInvoice,
  hasCachedWallet,
  disposeWallet,
  registerWalletEventListener,
} from './wallet-service';
import { clearUnlockKey } from './lib/key-store';
import { isInternalSender } from './lib/runtime';
import { MSG, type Envelope } from './lib/messages';

const handlers: Record<string, (payload: Record<string, unknown>) => Promise<Envelope>> = {
  async [MSG.OFFSCREEN_PAY_INVOICE](p) {
    const invoice = p.invoice as string | undefined;
    const walletRaw = p.walletRaw as string | undefined;
    if (!invoice) return { ok: false, error: 'Missing invoice for offscreen payment.' };
    if (!walletRaw) return { ok: false, error: 'Missing wallet ciphertext for offscreen payment.' };
    const r = await payInvoice(invoice, { walletRaw, pollPreimage: true });
    if (!r.preimage) return { ok: false, error: 'Payment succeeded but preimage was not available.' };
    return { ok: true, preimage: r.preimage };
  },
  async [MSG.WALLET_CREATE](p) {
    const mnemonic = p.mnemonic as string | undefined;
    const r = await initWalletFromMnemonic(mnemonic);
    return { ok: true, mnemonic: r.mnemonic, balanceSats: r.balanceSats.toString() };
  },
  async [MSG.GET_BALANCE]() {
    const b = await getWalletBalance();
    return { ok: true, balance: b.toString() };
  },
  async [MSG.GET_TRANSFERS](p) {
    const limit = typeof p.limit === 'number' ? p.limit : 10;
    const offset = typeof p.offset === 'number' ? p.offset : 0;
    const t = await getWalletTransfers(limit, offset);
    return { ok: true, transfers: t };
  },
  async [MSG.CREATE_INVOICE](p) {
    const amountSats = typeof p.amountSats === 'number' ? p.amountSats : 0;
    const inv = await createWalletInvoice(amountSats);
    return { ok: true, invoice: inv };
  },
  async [MSG.GET_FEE_ESTIMATE](p) {
    const encodedInvoice = p.encodedInvoice as string | undefined;
    if (!encodedInvoice) return { ok: false, error: 'Missing encodedInvoice.' };
    const feeSats = await getWalletFeeEstimate(encodedInvoice);
    return { ok: true, feeSats };
  },
  async [MSG.PAY_INVOICE](p) {
    const invoice = p.invoice as string | undefined;
    if (!invoice) return { ok: false, error: 'Missing invoice.' };
    const maxFeeSats = typeof p.maxFeeSats === 'number' ? p.maxFeeSats : undefined;
    const walletRaw = p.walletRaw as string | undefined;
    const r = await payInvoice(invoice, { maxFeeSats, walletRaw });
    return { ok: true, txId: r.txId };
  },
  async [MSG.HAS_WALLET]() {
    return { ok: true, hasWallet: hasCachedWallet() };
  },
  async [MSG.DISPOSE_WALLET]() {
    await disposeWallet();
    await clearUnlockKey();
    return { ok: true };
  },
};

// Bail BEFORE any other work for messages that don't target the offscreen.
// Both background and offscreen attach onMessage listeners to the same
// chrome.runtime channel; cross-handler types (TIPT_402_*, TIPT_MPP_*) are
// routed exclusively to background. Returning undefined here keeps the
// listener out of the dispatch race so the popup's await resolves to the
// background's response and never to our "Unauthorized sender." short-circuit.
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const msg = message as { type?: string; payload?: Record<string, unknown> };
  const type = msg?.type;
  if (!type || !(type in handlers)) return;

  if (!isInternalSender(sender)) {
    sendResponse({ ok: false, error: 'Unauthorized sender.' } satisfies Envelope);
    return;
  }
  const handler = handlers[type];
  (async () => {
    try {
      const result = await handler(msg.payload ?? {});
      sendResponse(result);
    } catch (e) {
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) } satisfies Envelope);
    }
  })();
  return true;
});

// Long-lived port for wallet events. Popup connects with name 'tipt-wallet'.
chrome.runtime.onConnect.addListener((port) => {
  if (port.sender?.id !== chrome.runtime.id) return;
  if (port.name !== 'tipt-wallet') return;
  const unsubscribe = registerWalletEventListener((event, balance) => {
    try {
      port.postMessage({ type: 'TIPT_WALLET_EVENT', payload: { event, balance: balance.toString() } });
    } catch {
      unsubscribe();
    }
  });
  port.onDisconnect.addListener(() => unsubscribe());
});
