/// <reference types="chrome" />

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
let ensurePromise: Promise<void> | null = null;
let ensured = false;

export async function ensureOffscreen(): Promise<void> {
  if (ensured) return;
  if (!ensurePromise) {
    ensurePromise = (async () => {
      if (!chrome.offscreen?.createDocument) return;
      if (chrome.offscreen.hasDocument) {
        const exists = await chrome.offscreen.hasDocument();
        if (exists) {
          ensured = true;
          return;
        }
      }
      try {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_DOCUMENT_PATH,
          reasons: [chrome.offscreen.Reason.LOCAL_STORAGE],
          justification: 'Process Spark SDK wallet operations outside the service worker runtime.',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('Only a single offscreen document may be created')) throw error;
      }
      ensured = true;
    })().finally(() => {
      ensurePromise = null;
    });
  }
  await ensurePromise;
}

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
