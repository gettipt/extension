# TIPT — Extension Specification

TIPT is a Chrome extension that embeds a self-custodial Lightning wallet and automatically pays HTTP 402 Payment Required challenges on behalf of the user.

---

## Wallet

### Setup
- On first launch the user creates a 5-digit numeric PIN.
- A BIP-39 mnemonic is generated (or recovered) and encrypted with a key derived from the PIN using PBKDF2.
- The encrypted mnemonic and PIN verifier are stored in `chrome.storage.sync` so they survive across browser profiles.
- The user is prompted to download a plaintext backup of their mnemonic before proceeding.

### Unlock
- On subsequent launches the user re-enters their PIN to unlock.
- The session PIN is stored in `chrome.storage.session` (cleared when the browser closes).
- If the session PIN is missing the wallet is considered locked; any background payment attempt will fail with a "Wallet is locked" error.

### Recovery
- The user can restore a wallet by entering an existing BIP-39 mnemonic on the setup screen.
- Mnemonics can be pasted as text or imported from a `.txt` file.

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

---

## Send

The Send panel accepts three input formats:

| Format | Description |
|---|---|
| Lightning invoice (`lnbc…`) | Decoded and paid directly. |
| Lightning Address (`user@domain.com`) | Resolved via LNURL-pay to fetch an invoice. |
| LNURL (`lnurl1…`) | Decoded to a URL, metadata fetched, then an invoice is fetched. |

### LNURL / Lightning Address flow
1. User enters the address or LNURL and taps **Next**.
2. The extension fetches pay metadata (min/max sendable, description).
3. User enters a sats amount within the allowed range.
4. Invoice is fetched from the LNURL callback and paid.

### Fee policy
- Max fee is `max(10, ceil(amount × 1%))` sats.
- The UI shows the max spendable amount accounting for fees.

### Payment execution
- `payLightningInvoice` is called via the Spark SDK.
- Because the SDK returns immediately after initiating, the preimage is polled every **750 ms** for up to **60 seconds**.

---

## Receive

- Tapping **Receive** generates a Lightning invoice via the Spark SDK.
- The invoice is displayed as a QR code and as copyable text.
- The panel closes automatically when an incoming payment is detected.

---

## Automatic 402 Payment (Page Hook)

### Overview
TIPT intercepts HTTP 402 responses and pays them automatically so the page request succeeds without user friction.

### Detection
The page hook (`page-hook.js`) is injected into every page as a `<script>` tag by the content script. It patches `window.fetch` and `XMLHttpRequest` to inspect responses for:

- HTTP status `402`
- `WWW-Authenticate` header containing `payment`, `invoice`, `challenge`, or `l402`
- JSON response body signals (`status: 402`, `"payment required"` in title/message/error fields)

### Supported challenge schemes

| Scheme | Authorization format |
|---|---|
| `L402` | `L402 <macaroon>:<preimage>` |
| `Payment` (MPP) | `Payment <base64url(JCS credential)>` |
| Other / fallback | `Bearer <preimage>` |

The `Payment` credential echoes the challenge fields and embeds the preimage, serialized using **RFC 8785 JSON Canonicalization Scheme (JCS)** and base64url-encoded.

### Approval flow
1. Page hook detects a 402 and posts a message to the content script.
2. Content script forwards to the background service worker.
3. Background checks if the host is on the **allowlist** (auto-approve) or prompts the user via a `window.confirm` dialog.
4. User can optionally check "Remember this host" to add it to the allowlist.
5. Background pays the invoice via the offscreen document and returns an `Authorization` header value.
6. Page hook retries the original request with the `Authorization` header.

### Allowlist
- Per-host auto-approval stored in `chrome.storage.local`.
- Cache is invalidated via `chrome.storage.onChanged`.

### MPP provider advertisement
When the page hook installs it dispatches `mpp:announce` immediately and re-dispatches on every `mpp:request` event, advertising TIPT as an available Lightning wallet provider to the page.

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
     │ window.postMessage
┌────▼──────────┐
│ Page Hook     │  Patches fetch / XHR, dispatches mpp:announce
│ (page-hook.js)│
└───────────────┘
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
