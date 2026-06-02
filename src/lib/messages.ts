// Single source of truth for chrome.runtime message names.
//
// Every onMessage handler in the extension dispatches on `msg.type`, so a
// type-name collision between background and offscreen would silently
// route to the wrong worker. Keeping all type strings here makes
// collisions a compile-time problem.
//
// Naming convention:
//   * TIPT_OFFSCREEN_* — handled by offscreen.ts
//   * TIPT_402_* / TIPT_MPP_* — handled by background.ts
//   * TIPT_* (everything else) — handled by offscreen.ts
//
// The offscreen and background share the chrome.runtime.onMessage channel
// but use disjoint type strings, so it doesn't matter which worker is
// woken first.

export const MSG = {
  // Offscreen wallet ops (popup → offscreen)
  WALLET_CREATE: 'TIPT_WALLET_CREATE',
  GET_BALANCE: 'TIPT_GET_BALANCE',
  GET_TRANSFERS: 'TIPT_GET_TRANSFERS',
  CREATE_INVOICE: 'TIPT_CREATE_INVOICE',
  GET_FEE_ESTIMATE: 'TIPT_GET_FEE_ESTIMATE',
  PAY_INVOICE: 'TIPT_PAY_INVOICE',
  HAS_WALLET: 'TIPT_HAS_WALLET',
  DISPOSE_WALLET: 'TIPT_DISPOSE_WALLET',
  OFFSCREEN_PAY_INVOICE: 'TIPT_OFFSCREEN_PAY_INVOICE',

  // 402 / MPP background ops
  MPP_REQUEST_TRIGGERED: 'TIPT_MPP_REQUEST_TRIGGERED',
  PAY_REQUEST_402: 'TIPT_402_PAY_REQUEST',
  CONFIRM_RESPONSE_402: 'TIPT_402_CONFIRM_RESPONSE',
  ALLOWLIST_LIST_402: 'TIPT_402_ALLOWLIST_LIST',
  ALLOWLIST_REMOVE_402: 'TIPT_402_ALLOWLIST_REMOVE',
} as const;

export type Envelope<T = Record<string, unknown>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };
