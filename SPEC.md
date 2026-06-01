# TIPT — Extension Specification

TIPT is a Chrome extension that embeds a self-custodial Lightning wallet and handles HTTP 402 Payment Required challenges on behalf of the user via an explicit MPP event protocol.

## Setup
- On first launch the user is prompted to either "Create Wallet" or "Restore Wallet".

### Create Wallet Workflow
- The user is prompted to create and confirm a 5-digit numeric PIN.
- Once the PIN is created, a BIP-39 mnemonic is generated and encrypted with a key derived from the PIN using PBKDF2.
- The encrypted mnemonic and PIN verifier are stored in `chrome.storage.sync` so they survive across browser profiles.
- The user is prompted to download a plaintext backup of their mnemonic before proceeding.

### Restore Wallet Workflow
- The user can restore a wallet by entering an existing BIP-39 mnemonic on the setup screen.
- Mnemonics can be pasted as text or imported from a `.txt` file.
- Once the mnemonic is provided (and validated locally), the user is asked to create and confirm a 5-digit numeric PIN.
- The encrypted mnemonic and PIN verifier are stored in `chrome.storage.sync` so they survive across browser profiles.

### Unlock
- On subsequent launches the user re-enters their PIN to unlock.
- The session PIN is stored in `chrome.storage.session` (cleared when the browser closes).
- If the session PIN is missing the wallet is considered locked; any background payment attempt will fail with a "Wallet is locked" error.

### Network
- Wallets connect to the **Spark SDK** on **Mainnet**.
- The wallet instance is cached in the offscreen document and torn down after **90 seconds of idle** to release resources.

### Balance
- Balance is displayed in satoshis or USD (togglable via ⇅ button).
- USD conversion rate is fetched from CoinGecko every **5 minutes**.
- Balance updates are received via `transfer:claimed` and `deposit:confirmed` wallet events.
- When the balance increases while the Receive panel is open, the panel closes automatically.

### Transfer History
- The 10 most recent transfers are loaded after each balance update.
- Transfers are encrypted and cached in `chrome.storage.sync` so they appear instantly on next unlock.
- Up to 4 recent transfers are shown by default; a "Show all" toggle expands the list.

### Settings
- **Reset wallet** — removes the stored mnemonic, PIN, and transfer cache, then reloads to the setup screen.

---

## Send

The Send panel accepts Lightning Addresses and LNURLs. Both resolve via LNURL-pay to fetch a BOLT11 invoice.

### Send flow

The send UI is a single screen with two labeled fields:
- **Recipient** — Lightning Address (e.g. `user@domain.com`) or LNURL
- **₿** — Amount in satoshis, with a **Send Max** button

Tapping **Review & Pay**:
1. If the LNURL has not yet been resolved, it is resolved now to fetch min/max sendable and the callback URL.
2. If no amount has been entered after resolution, the flow stops so the user can enter one.
3. The amount is validated against the LNURL min/max and the wallet balance.
4. A BOLT11 invoice is fetched from the LNURL callback for the requested amount.
5. `getLightningSendFeeEstimate` is called on the invoice to get the real network fee. Falls back to `max(5, ceil(amount × 0.17%))` if the SDK call fails.
6. **Fee safety guard**: if `amount + fee > balance`, the send amount is automatically reduced to `balance − fee` and a new invoice is fetched for the adjusted amount.
7. The **Review** screen is shown with: Amount / Network fee / Total deducted.

Tapping **Confirm & Pay** on the review screen calls `payLightningInvoice`. On success, the success notification is shown and automatically dismissed after **5 seconds**, returning to the main screen.

### Send Max
- Clicking **Send Max** populates the amount field with the full wallet balance (raw `balanceSats`).
- On **Review & Pay**, the effective send amount is computed as `getMaxSpendableSats(balance)` (fee-adjusted), capped by the LNURL maximum.

### Fee policy
- Formula: `max(5, ceil(amount × 0.0017))` sats (17 bps, minimum 5 sats).
- `getMaxSpendableSats` iterates down from `floor(balance × 10000/10017)` to find the largest amount where `amount + fee ≤ balance`.
- For the send UI, `getLightningSendFeeEstimate` is always attempted first; the formula is the fallback.
- For automated 402 payments (background), `getLightningSendFeeEstimate` is called first. The result is used directly if it is a finite number; otherwise the formula is applied to the invoice amount; 50 sats is the final fallback.

### Payment execution
- `payLightningInvoice` is called via the Spark SDK with `maxFeeSats = max(feeEstimate, formulaFee)`.
- Because the SDK returns immediately after initiating, the preimage is polled every **750 ms** for up to **60 seconds** via `getLightningSendRequest`.

---

## Receive

- Tapping **Receive** generates a Lightning invoice via the Spark SDK.
- The invoice is displayed as a QR code and as copyable text.
- The panel closes automatically when an incoming payment is detected.

---

## 402 Payment Protocol (MPP Events)

### Overview
TIPT does not inject scripts or intercept network traffic. Instead, websites explicitly request payment from TIPT using browser `CustomEvent`s. The content script (`content.ts`) runs at `document_start` on all URLs and acts as a bridge between the page and the background service worker.

### Wallet Advertisement
TIPT only announces itself when asked. When the page dispatches `mpp:request`, the content script responds with `mpp:announce` and also notifies the background to set the icon badge green for that tab.

```js
// Site asks if a wallet is present
window.dispatchEvent(new CustomEvent('mpp:request'));

// TIPT responds
window.addEventListener('mpp:announce', (e) => {
  console.log(e.detail);
  // { name: 'TIPT', version: '0.0.0', capabilities: ['l402', 'lightning-invoice'] }
});
```

> **Note:** Always register the `mpp:announce` listener before dispatching `mpp:request`, since CustomEvents are synchronous.

### Payment Request
The site dispatches `mpp:pay` with the invoice and challenge details. TIPT pays the invoice and dispatches `mpp:payresponse` with the resulting `Authorization` header value.

```js
// Site requests payment
window.dispatchEvent(new CustomEvent('mpp:pay', {
  detail: {
    requestId: 'unique-id',        // Correlated in the response
    invoice: 'lnbc...',            // BOLT11 invoice (required)
    scheme: 'L402',                // Optional: 'L402' | 'Payment' | other
    macaroon: '...',               // Optional: for L402
    token: '...',                  // Optional
    paymentChallenge: {            // Optional: for Payment/MPP scheme
      id, realm, method, intent, request, expires?, opaque?
    }
  }
}));

// Site listens for the result
window.addEventListener('mpp:payresponse', (e) => {
  const { requestId, approved, authorization, error } = e.detail;
  if (approved) {
    // Retry the original request with the Authorization header
  }
});
```

### Supported challenge schemes

| Scheme | Authorization format |
|---|---|
| `L402` | `L402 <macaroon>:<preimage>` |
| `Payment` (MPP) | `Payment <base64url(JCS credential)>` |
| Other / fallback | `Bearer <preimage>` |

The `Payment` credential echoes the challenge fields and embeds the preimage, serialized using **RFC 8785 JSON Canonicalization Scheme (JCS)** and base64url-encoded.

### Approval flow
1. Site dispatches `mpp:pay` with invoice and challenge details.
2. Content script forwards to the background service worker as `TIPT_402_PAY_REQUEST` with `source: 'mpp'`.
3. Background checks if the host is on the **allowlist** (auto-approve) or prompts the user via a `window.confirm` dialog in the content script.
4. User can optionally choose "Remember this host" to add it to the allowlist.
5. Background pays the invoice via the offscreen document and returns an `Authorization` header value.
6. Content script dispatches `mpp:payresponse` back to the page.
7. Site retries its original request with the `Authorization` header.

### Allowlist
- Per-host auto-approval stored in `chrome.storage.local`.
- Cache is invalidated via `chrome.storage.onChanged`.

---

## Architecture

```
┌─────────────────────────────────────┐
│  Popup (React — App.tsx)            │  Wallet UI — setup, unlock, send, receive
└────────────────┬────────────────────┘
                 │ chrome.storage / chrome.runtime
┌────────────────▼────────────────────┐
│  Background Service Worker          │  402 orchestration, allowlist, icon badge
│  (background.ts)                    │
└────┬───────────────────┬────────────┘
     │ chrome.tabs msg   │ chrome.runtime msg
┌────▼──────────┐  ┌─────▼───────────────┐
│ Content Script│  │ Offscreen Document  │  Spark SDK wallet instance
│ (content.ts)  │  │ (wallet-service.ts) │
└────┬──────────┘  └─────────────────────┘
     │ CustomEvents
     │ mpp:announce  (TIPT → page)
     │ mpp:request   (page → TIPT)
     │ mpp:pay       (page → TIPT)
     │ mpp:payresponse (TIPT → page)
  Page JS
```

---

## Manifest

- **Manifest version**: 3
- **Permissions**: `tabs`, `storage`, `offscreen`
- **Host permissions**: `<all_urls>`
- **Content script**: `content.js` injected at `document_start` on all URLs
- **Background**: `background.js` module service worker
- **CSP**: `script-src 'self' 'wasm-unsafe-eval'` (required for Spark SDK WASM)

---

## Storage Keys

| Key | Area | Contents |
|---|---|---|
| `spark_pin` | sync | Salt + encrypted PIN verifier |
| `spark_wallet` | sync | Encrypted BIP-39 mnemonic |
| `spark_transfers_cache` | sync | Encrypted recent transfer list |
| `spark_session_pin` | session | Plaintext PIN for current browser session |
| `tipt_402_allowlist` | local | `{ [host]: true }` auto-approve map |

