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

type Envelope = { ok: true; [key: string]: unknown } | { ok: false; error: string };

// Defense in depth: drop any message whose sender doesn't claim our own
// extension id. `chrome.runtime.onMessage` is, by design, internal-only
// (it never delivers external messages unless `externally_connectable` is
// set, which we don't set), but enforcing the invariant makes the contract
// explicit and future-proofs us against config drift.
function isInternalSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id;
}

const handlers: Record<string, (payload: Record<string, unknown>) => Promise<Envelope>> = {
  async TIPT_OFFSCREEN_PAY_INVOICE(p) {
    const invoice = p.invoice as string | undefined;
    const walletRaw = p.walletRaw as string | undefined;
    if (!invoice) return { ok: false, error: 'Missing invoice for offscreen payment.' };
    if (!walletRaw) return { ok: false, error: 'Missing wallet ciphertext for offscreen payment.' };
    const r = await payInvoice(invoice, { walletRaw, pollPreimage: true });
    if (!r.preimage) return { ok: false, error: 'Payment succeeded but preimage was not available.' };
    return { ok: true, preimage: r.preimage };
  },
  async TIPT_WALLET_CREATE(p) {
    const mnemonic = p.mnemonic as string | undefined;
    const r = await initWalletFromMnemonic(mnemonic);
    return { ok: true, mnemonic: r.mnemonic, balanceSats: r.balanceSats.toString() };
  },
  async TIPT_GET_BALANCE() {
    const b = await getWalletBalance();
    return { ok: true, balance: b.toString() };
  },
  async TIPT_GET_TRANSFERS(p) {
    const limit = typeof p.limit === 'number' ? p.limit : 10;
    const offset = typeof p.offset === 'number' ? p.offset : 0;
    const t = await getWalletTransfers(limit, offset);
    return { ok: true, transfers: t };
  },
  async TIPT_CREATE_INVOICE(p) {
    const amountSats = typeof p.amountSats === 'number' ? p.amountSats : 0;
    const inv = await createWalletInvoice(amountSats);
    return { ok: true, invoice: inv };
  },
  async TIPT_GET_FEE_ESTIMATE(p) {
    const encodedInvoice = p.encodedInvoice as string | undefined;
    if (!encodedInvoice) return { ok: false, error: 'Missing encodedInvoice.' };
    const feeSats = await getWalletFeeEstimate(encodedInvoice);
    return { ok: true, feeSats };
  },
  async TIPT_PAY_INVOICE(p) {
    const invoice = p.invoice as string | undefined;
    if (!invoice) return { ok: false, error: 'Missing invoice.' };
    const maxFeeSats = typeof p.maxFeeSats === 'number' ? p.maxFeeSats : undefined;
    const walletRaw = p.walletRaw as string | undefined;
    const r = await payInvoice(invoice, { maxFeeSats, walletRaw });
    return { ok: true, txId: r.txId };
  },
  async TIPT_HAS_WALLET() {
    return { ok: true, hasWallet: hasCachedWallet() };
  },
  async TIPT_DISPOSE_WALLET() {
    await disposeWallet();
    await clearUnlockKey();
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isInternalSender(sender)) return;
  const msg = message as { type?: string; payload?: Record<string, unknown> };
  const type = msg?.type;
  if (!type) return;
  const handler = handlers[type];
  if (!handler) return;
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
