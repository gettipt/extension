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
- Once the mneumonic is provided (and validated locally), the user is asked to create and confirm a 5-digit numeric PIN.
- The encrypted mnemonic and PIN verifier are stored in `chrome.storage.sync` so they survive across browser profiles.

### Unlock
- On subsequent launches the user re-enters their PIN to unlock.
- The session PIN is stored in `chrome.storage.session` (cleared when the browser closes).
- If the session PIN is missing the wallet is considered locked; any background payment attempt will fail with a "Wallet is locked" error.

### Network
- Wallets connect to the **Spark SDK** on **Mainnet**.
- The wallet instance is cached in the offscreen document and torn down after **90 seconds of idle** to release resources.

### Balance
- Balance is displayed in bitcoin (satoshis) or USD (togglable).
- USD conversion rate is fetched from CoinGecko every **5 minutes**.
- Balance updates are received via `transfer:claimed` and `deposit:confirmed` wallet events.
- When the balance increases while the Receive panel is open, the panel closes automatically.

### Transfer History
- The 10 most recent transfers are loaded after each balance update.
- Transfers are encrypted and cached in `chrome.storage.sync` so they appear instantly on next unlock.
- Up to 3 recent transfers are shown by default; a "Show all" toggle expands the list.

### Settings
- **Reset wallet** — removes the stored mnemonic and PIN, returning to the setup screen.

## Send

The Send panel accepts three input formats:

| Format | Example | Description |
|---|---|---|
| Lightning Address |`user@domain.com`| Resolved via LNURL-pay to fetch an invoice. |
| LNURL |`lnurl1…`| Decoded to a URL, metadata fetched, then an invoice is fetched. |
| Lightning Invoice |`lnbc…`| Decoded and paid directly.|

### LNURL / Lightning Address flow
1. User enters the address or LNURL and taps **Next**.
2. The extension fetches pay metadata (min/max sendable, description).
3. User enters a sats amount within the allowed range.
4. Invoice is fetched from the LNURL callback and paid.

### Fee policy
- Max fee follows Spark's recommendation: `max(5, ceil(amount × 0.17%))` sats.
- The UI shows the max spendable amount accounting for fees.
- For automated 402 payments, `getLightningSendFeeEstimate` is called first and the result is used as `maxFeeSats`, falling back to 50 sats if the estimate is unavailable.

### Payment execution
- `payLightningInvoice` is called via the Spark SDK.
- Because the SDK returns immediately after initiating, the preimage is polled every **750 ms** for up to **60 seconds**.

## Receive

- Tapping **Receive** generates a Lightning invoice via the Spark SDK.
- The invoice is displayed as a QR code and as copyable text.
- The panel closes automatically when an incoming payment is detected.

## 402 Payment Protocol (MPP Events)

### Overview
TIPT does not inject scripts or intercept network traffic. Instead, websites explicitly request payment from TIPT using browser `CustomEvent`s. The content script acts as a bridge between the page and the extension's background service worker.

### Wallet Advertisement
When a page loads, the content script immediately dispatches `mpp:announce` so the site knows TIPT is present. Sites can also trigger a fresh announcement at any time by dispatching `mpp:request`.

```js
// Fired by TIPT on page load
window.addEventListener('mpp:announce', (e) => {
  console.log(e.detail); // { name: 'TIPT', version: '0.0.0', capabilities: ['l402', 'lightning-invoice'] }
});

// Site can request a fresh announcement
window.dispatchEvent(new CustomEvent('mpp:request'));
```

### Payment Request
The site dispatches `mpp:pay` with the invoice and challenge details. TIPT pays the invoice and dispatches `mpp:payresponse` with the resulting `Authorization` header value.

```js
// Site requests payment
window.dispatchEvent(new CustomEvent('mpp:pay', {
  detail: {
    requestId: 'unique-id',   // Correlated in the response
    invoice: 'lnbc...',       // BOLT11 invoice
    scheme: 'L402',           // Optional: 'L402' | 'Payment' | other
    macaroon: '...',          // Optional: for L402
    paymentChallenge: { ... } // Optional: for Payment/MPP scheme
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
2. Content script forwards to the background service worker.
3. Background checks if the host is on the **allowlist** (auto-approve) or prompts the user via a `window.confirm` dialog.
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
│  Popup (React)                      │  Wallet UI — setup, unlock, send, receive
└────────────────┬────────────────────┘
                 │ chrome.storage
┌────────────────▼────────────────────┐
│  Background Service Worker          │  402 orchestration, allowlist, icon badge
└────┬───────────────────┬────────────┘
     │ chrome.tabs msg   │ chrome.runtime msg
┌────▼──────┐   ┌────────▼────────────┐
│ Content   │   │ Offscreen Document  │  Spark SDK wallet instance
│ Script    │   │ (wallet-service.ts) │
└────┬──────┘   └─────────────────────┘
     │ CustomEvents (mpp:announce, mpp:pay, mpp:payresponse)
     │
  Page JS
```

---

## Storage Keys

| Key | Area | Contents |
|---|---|---|
| `spark_pin` | sync | Salt + encrypted PIN verifier |
| `spark_wallet` | sync | Encrypted BIP-39 mnemonic |
| `spark_transfers_cache` | sync | Encrypted recent transfer list |
| `spark_session_pin` | session | Plaintext PIN for current browser session |
| `tipt_402_allowlist` | local | `{ [host]: true }` auto-approve map |

