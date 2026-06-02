/// <reference types="chrome" />
import {
  payInvoiceFromSession,
  initWalletFromMnemonic,
  getWalletBalance,
  getWalletTransfers,
  createWalletInvoice,
  getWalletFeeEstimate,
  payWalletInvoice,
  hasCachedWallet,
  disposeCachedWallet,
  ensureWalletForSession,
  registerWalletEventListener,
} from './wallet-service';

type Envelope = { ok: true; [key: string]: unknown } | { ok: false; error: string };

const handlers: Record<string, (payload: Record<string, unknown>) => Promise<Envelope>> = {
  async TIPT_OFFSCREEN_PAY_INVOICE(p) {
    const invoice = p.invoice as string | undefined;
    const sessionPin = p.sessionPin as string | undefined;
    const pinRaw = p.pinRaw as string | undefined;
    const walletRaw = p.walletRaw as string | undefined;
    if (!invoice) return { ok: false, error: 'Missing invoice for offscreen payment.' };
    if (!sessionPin || !pinRaw || !walletRaw) return { ok: false, error: 'Missing wallet credentials for offscreen payment.' };
    const r = await payInvoiceFromSession(invoice, sessionPin, pinRaw, walletRaw);
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
    const maxFeeSats = typeof p.maxFeeSats === 'number' ? p.maxFeeSats : 50;
    if (!invoice) return { ok: false, error: 'Missing invoice.' };
    // Auto-recover the wallet if it was torn down (e.g. offscreen restart).
    const sessionPin = p.sessionPin as string | undefined;
    const pinRaw = p.pinRaw as string | undefined;
    const walletRaw = p.walletRaw as string | undefined;
    const cached = await hasCachedWallet();
    if (!cached.hasWallet) {
      if (!sessionPin || !pinRaw || !walletRaw) {
        return { ok: false, error: 'Wallet not initialized and no credentials provided to re-initialize.' };
      }
      await ensureWalletForSession(sessionPin, pinRaw, walletRaw);
    }
    const r = await payWalletInvoice(invoice, maxFeeSats);
    return { ok: true, txId: r.txId };
  },
  async TIPT_HAS_WALLET() {
    const r = await hasCachedWallet();
    return { ok: true, hasWallet: r.hasWallet, balanceSats: r.balanceSats?.toString() };
  },
  async TIPT_DISPOSE_WALLET() {
    await disposeCachedWallet();
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
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
