/// <reference types="chrome" />

import { ensureOffscreen } from './offscreen';

export { ensureOffscreen };

export async function sendWalletMessage<T>(msg: Record<string, unknown>): Promise<T> {
  await ensureOffscreen();
  const response = await chrome.runtime.sendMessage(msg);
  return response as T;
}

export interface WalletEvent {
  event: 'transfer:claimed' | 'deposit:confirmed';
  balance: string;
}

// Connect via long-lived port. Offscreen listens and pushes wallet events down
// the port. Keeps the offscreen alive while the popup is open.
export function connectWalletPort(onEvent: (e: WalletEvent) => void): () => void {
  let port: chrome.runtime.Port | null = null;
  let closed = false;
  void (async () => {
    try {
      await ensureOffscreen();
      if (closed) return;
      port = chrome.runtime.connect({ name: 'tipt-wallet' });
      port.onMessage.addListener((message: unknown) => {
        const m = message as { type?: string; payload?: WalletEvent };
        if (m?.type === 'TIPT_WALLET_EVENT' && m.payload) onEvent(m.payload);
      });
    } catch {
      // Best-effort; popup still works without push events.
    }
  })();
  return () => {
    closed = true;
    try { port?.disconnect(); } catch { /* ignore */ }
  };
}
