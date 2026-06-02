# TIPT — Extension Specification

TIPT is a Chrome extension that embeds a self-custodial Lightning wallet and handles HTTP 402 Payment Required challenges on behalf of the user via an explicit MPP event protocol.

## Setup
- On first launch the user is prompted to either "Create Wallet" or "Restore Wallet".

### Create Wallet Workflow
- The user is prompted to create and confirm a 5-digit numeric PIN.
- Once the PIN is created, a BIP-39 mnemonic is generated and encrypted with a key derived from the PIN using **PBKDF2-SHA256 with 600,000 iterations** (OWASP 2024 guidance).
- The encrypted mnemonic and PIN verifier are written to **both `chrome.storage.local` and `chrome.storage.sync`** via `setItemDual` (see *Cross-device wallet sync*). The PIN payload includes its `iterations` value so legacy blobs can be detected.
- The user is prompted to download a plaintext backup of their mnemonic before proceeding.

### Restore Wallet Workflow
- The user can restore a wallet by entering an existing BIP-39 mnemonic on the setup screen.
- Mnemonics can be pasted as text or imported from a `.txt` file.
- Once the mnemonic is provided (and validated locally), the user is asked to create and confirm a 5-digit numeric PIN.
- The encrypted mnemonic and PIN verifier are written to **both `chrome.storage.local` and `chrome.storage.sync`** via `setItemDual` (see *Cross-device wallet sync*).
- When the mnemonic was supplied via file upload, the backup-prompt screen is skipped (the user already has a copy on disk).

### Unlock
- On subsequent launches the user re-enters their PIN to unlock.
- The session PIN is stored in `chrome.storage.session` (cleared when the browser closes).
- If the session PIN is missing the wallet is considered locked; any background payment attempt will fail with a "Wallet is locked" error.

#### PIN attempt throttling
- Failed PIN unlock attempts are tracked under `spark_pin_attempts` in `chrome.storage.local` as `{ count, lockedUntil }`.
- Lockout thresholds are applied at **5 / 10 / 15** failed attempts, producing lockouts of **30 s / 5 min / 1 h** respectively (`PIN_LOCKOUT_THRESHOLDS` / `PIN_LOCKOUT_DURATIONS_MS` in `src/constants.ts`).
- While locked, the unlock screen displays the remaining seconds and rejects PIN entries.
- A successful unlock clears the counter.

#### Lazy PBKDF2 migration
- If a stored PIN payload is missing the `iterations` field, or if its value is below the current default (600,000), the unlock path treats it as **legacy 100,000 iterations** for the verification step.
- On successful unlock with legacy iterations, both the PIN verifier and the wallet mnemonic blob are re-encrypted under a new key derived at 600,000 iterations and written back via `setItemDual` (to both `local` and `sync`). The migration is best-effort and silently falls back to the old key on failure.

#### Cross-device wallet sync
- `spark_pin` and `spark_wallet` are written to **both `chrome.storage.local` (fast, per-device) and `chrome.storage.sync` (cross-device propagation via the user's signed-in Chrome profile)**. Encrypted blobs are well under the per-item 8 KB sync quota.
- Reads go through `getSynced(key)` (`src/lib/storage.ts`), which prefers `local` and falls back to `sync`. When a value is found only in `local` (e.g., a previous install that wrote to `local`-only), `getSynced` transparently backfills `sync`. When a value is found only in `sync` (e.g., a brand-new device signed into the same Chrome profile), `getSynced` caches it to `local` for subsequent fast reads.
- Sync writes are best-effort: a failed `sync.set` (quota, disabled, etc.) does not block the local write. Reset (`removeItemDual`) clears both areas.
- Device-only keys (`spark_pin_attempts`, `spark_transfers_cache`, `tipt_402_allowlist`, `spark_btc_usd_rate`) remain in their respective single areas — they are not synced. The PIN-derived AES-GCM `CryptoKey` is cached separately in shared **IndexedDB** (`src/lib/key-store.ts`) as a non-extractable handle — never as raw PIN bytes — and is cleared on browser startup so it behaves like the old session-only PIN.

### Network
- Wallets connect to the **Spark SDK** on **Mainnet**.
- The wallet instance is cached in the offscreen document for the lifetime of the offscreen document. It is only torn down explicitly when the user resets their wallet (via the popup sending `TIPT_DISPOSE_WALLET`) or when Chrome reclaims the offscreen document (rare; only under memory pressure or extension reload). Tearing the SDK down between operations was previously done on a 90 s idle timer, but that caused user-visible "Wallet not initialized." errors when the popup was left open while filling in a payment, so the timer was removed. The popup's `TIPT_PAY_INVOICE` now also passes the user's session credentials so the offscreen handler can transparently re-init the wallet if Chrome happens to tear the offscreen document down between popup open and Confirm & Pay.

### Balance
- Balance is displayed in satoshis or USD (togglable via ⇅ button).
- USD conversion rate is fetched from CoinGecko every **5 minutes**. The refresh effect uses an `AbortController` and aborts any in-flight request on cleanup.
- Balance updates are received via `transfer:claimed` and `deposit:confirmed` wallet events pushed over a long-lived port (see *Offscreen → Popup event broadcast*).
- When the balance increases while the Receive panel is open, the panel closes automatically.

### Transfer History
- The 10 most recent transfers are loaded after each balance update (debounced **500 ms**).
- Transfers are encrypted with the derived `CryptoKey` and cached in `chrome.storage.local` under `spark_transfers_cache` so they appear instantly on next unlock.
- Up to 4 recent transfers are shown by default; a "Show all" toggle expands the list.
- Transfer formatting/grouping helpers live in `src/lib/transfers.ts` (extracted from `App.tsx`).
- The offscreen handler normalises each transfer through `JSON.parse(JSON.stringify(..., bigintReplacer))` before posting it across `chrome.runtime.sendMessage`. The Spark SDK's `getTransfers` response occasionally embeds `bigint` values (uint64 proto fields) that would otherwise silently break message serialisation and make transfers never appear in the popup.

### Settings
- **Backup mnemonic** — downloads a plaintext `TIPT-Wallet-Backup.txt`. The in-memory mnemonic is cleared from React state once the app transitions to `ready`, so `downloadBackupFile()` is `async` and re-derives the mnemonic on demand by decrypting `spark_wallet` with the cached `CryptoKey`.
- **Reset wallet** — confirms via `globalThis.confirm`, then `removeItemDual` clears `spark_pin` and `spark_wallet` from both `local` and `sync`; removes `spark_transfers_cache` and `spark_pin_attempts` from `local`; removes the session PIN; clears the in-memory key; and reloads to the setup screen.

---

## Send

The Send panel accepts Lightning Addresses and LNURLs. Both resolve via LNURL-pay to fetch a BOLT11 invoice.

### LNURL URL safety
- Only `https://` URLs are accepted.
- The hostname must not be a loopback / private / link-local / multicast IPv4 literal, an IPv6 loopback / link-local / unique-local literal, `localhost`, a `.local` / `.localhost` name, or a `.onion` address.
- The initial LNURL/`.well-known/lnurlp` URL **and** the `callback` URL returned by the server are both validated, so a malicious server cannot redirect TIPT to a private network for the invoice fetch.

### Send flow

The send UI is a single screen with two labeled fields:
- **Recipient** — Lightning Address (e.g. `user@domain.com`) or LNURL
- **Amount** — Amount in bitcoin (satoshis), with a **Send Max** button

Tapping **Review & Pay**:
1. If the LNURL has not yet been resolved, it is resolved now to fetch min/max sendable and the callback URL (both URLs pass `assertSafeUrl`).
2. If no amount has been entered after resolution, the flow stops so the user can enter one.
3. The amount is validated against the LNURL min/max and the wallet balance.
4. A BOLT11 invoice is fetched from the LNURL callback for the requested amount.
5. `TIPT_GET_FEE_ESTIMATE` is sent to the offscreen to get the real network fee. Falls back to `getMaxFeeSats(amount) = max(5, ceil(amount × 0.0017))` if the SDK call fails.
6. **Fee safety guard**: if `amount + fee > balance`, the send amount is automatically reduced to `balance − fee` and a new invoice is fetched for the adjusted amount. The fee is re-estimated for the adjusted invoice (falling back to the previously computed fee).
7. The **Review** screen is shown with: Amount / Network fee / Total deducted.

Tapping **Confirm & Pay** on the review screen sends `TIPT_PAY_INVOICE` (with `{ invoice, maxFeeSats, walletRaw? }`) to the offscreen. The encrypted wallet blob is included so the offscreen handler can re-initialize the SparkWallet if the cached instance has been torn down — the AES-GCM key required to decrypt it is loaded from shared IndexedDB inside the offscreen, so the PIN never crosses the IPC boundary. On success, the success notification is shown and automatically dismissed after **5 seconds**, returning to the main screen.

### Send Max
- Clicking **Send Max** populates the amount field with the full wallet balance (raw `balanceSats`).
- On **Review & Pay**, the effective send amount is computed as `getMaxSpendableSats(balance)` (fee-adjusted), capped by the LNURL maximum.

### Fee policy
- Formula: `getMaxFeeSats(amount) = max(25, ceil(amount × 0.0017))` sats (17 bps, minimum 25 sats). Implemented in `src/lib/fees.ts`.
- `getMaxSpendableSats(balance)` returns the largest `a` such that `a + getMaxFeeSats(a) ≤ balance`. The implementation is algebraic — `floor((balance − 25) × 10000 / 10017)` — with a tiny ±1 correction at the boundary; no general-purpose loop.
- For the send UI, the offscreen's `getLightningSendFeeEstimate` is always attempted first via `TIPT_GET_FEE_ESTIMATE`; the formula is the fallback.
- For automated 402 payments (background → offscreen), `getLightningSendFeeEstimate` is called first inside `payInvoice`. If it returns a finite `feeEstimate`/`fee`/`estimatedFee`, that value is used (clamped to at least 25). Otherwise the formula is applied to the invoice amount returned by the SDK; 50 sats is the final fallback.

### Payment execution
- The popup sends `TIPT_PAY_INVOICE` to the offscreen with `{ invoice, maxFeeSats: max(feeEstimate, getMaxFeeSats(amount)), walletRaw? }`. The offscreen first checks whether a wallet is cached. If not, and `walletRaw` was supplied, it calls `ensureWalletFromBlob` (which uses the cached AES key from IndexedDB) to re-initialize before paying. It then calls the unified `payInvoice` helper (which wraps `payLightningInvoice` on the cached SDK instance) and returns `{ ok, txId? }`.
- After a successful payment the popup immediately sends `TIPT_GET_BALANCE` to the offscreen to refresh the displayed balance.

---

## Receive

- Tapping **Receive** sends `TIPT_CREATE_INVOICE` (with `amountSats: 0`) to the offscreen document, which generates a Lightning invoice via the Spark SDK.
- The invoice is displayed as a QR code and as copyable text.
- The panel closes automatically when an incoming payment is detected.

---

## 402 Payment Protocol (MPP Events)

### Overview
TIPT does not inject scripts or intercept network traffic. Instead, websites explicitly request payment from TIPT using browser `CustomEvent`s. The content script (`content.ts`) runs at `document_start` on all URLs and acts as a bridge between the page and the background service worker.

> **Build constraint:** Content scripts in Manifest V3 are loaded as **classic scripts, not ES modules** — `import` statements at the top of `content.ts` would cause a syntax error in the page. `src/content.ts` therefore inlines its own debug-logger and **must not import from any other module**. The popup, background, and offscreen entries are all module-loaded and may import freely.

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
3. Background checks if the host is on the **allowlist** (auto-approve) or opens a dedicated **confirm popup window** (`confirm.html`) via `chrome.windows.create({ type: 'popup', width: 380, height: 460 })`.
4. The confirm popup renders `ConfirmApp` (`src/ConfirmApp.tsx`), which sends `TIPT_402_CONFIRM_READY` to the background to fetch the pending request details and then displays host / URL / invoice plus a "Remember this site" checkbox.
5. The popup sends `TIPT_402_CONFIRM_RESPONSE` with `{ id, approved, remember }` and closes itself.
6. If the user does not respond, the background **auto-declines after 5 minutes** (pending confirms are held in an in-memory `Map<id, PendingConfirm>` keyed by a `crypto.randomUUID()`; a timer auto-resolves on expiry).
7. On approval, the background pays the invoice via the offscreen document and returns an `Authorization` header value.
8. Content script dispatches `mpp:payresponse` back to the page.
9. Site retries its original request with the `Authorization` header.

> The previous design used `window.confirm()` inside the content script (via a `TIPT_PROMPT_402_PAYMENT` message). That path has been removed.

### Allowlist
- Per-host auto-approval stored in `chrome.storage.local` under `tipt_402_allowlist` as `{ [host]: true }`.
- Cache is invalidated via `chrome.storage.onChanged`.

---

## Architecture

```
┌──────────────────────────────┐        ┌─────────────────────────────────┐
│  Popup (React — App.tsx +    │        │  Confirm popup window           │
│  src/components/*)           │        │  (confirm.html + ConfirmApp.tsx)│
│  Wallet UI: setup, unlock,   │        │  Per-request 402 approval UI    │
│  send, receive               │        └────────────────┬────────────────┘
└──────┬─────────┬─────────────┘                         │
       │         │ chrome.runtime.connect                │ TIPT_402_CONFIRM_READY
       │         │ ('tipt-wallet' port)                  │ TIPT_402_CONFIRM_RESPONSE
       │         │ + chrome.runtime.sendMessage          │
       │         │   (wallet ops)                        │
       │         │                                       ▼
       │    ┌────▼────────────────────────────┐  ┌───────────────────────┐
       │    │  Offscreen Document             │  │  Background Service   │
       │    │  (offscreen.ts +                │◀─┤  Worker               │
       │    │   wallet-service.ts)            │  │  (background.ts)      │
       │    │  Sole SparkWallet SDK owner.    │  │                       │
       │    │  Cached instance persists for   │  │  402 orchestration,   │
       │    │  the offscreen lifetime; only   │  │  allowlist, badge,    │
       │    │  disposed on explicit reset.    │  │  confirm window mgmt  │
       │    └─────────────────────────────────┘  └────────┬──────────────┘
       │                                                  │ chrome.tabs.sendMessage
       │ chrome.storage.local / .session                  │
       │ (single source of truth in src/lib/storage.ts)   │
       │                                          ┌───────▼────────┐
       │                                          │  Content Script│
       │                                          │  (content.ts)  │  CustomEvents (mpp:*)
       │                                          └───────┬────────┘
       │                                                  │ mpp:announce  (TIPT → page)
       │                                                  │ mpp:request   (page → TIPT)
       │                                                  │ mpp:pay       (page → TIPT)
       │                                                  │ mpp:payresponse (TIPT → page)
       │                                                Page JS
       │
       └─── src/lib/ ─── storage, wallet-client (ensureOffscreen, sendWalletMessage,
                         connectWalletPort), fees, transfers, format, logger,
                         pin-attempts
```

### Offscreen document as sole wallet owner

The offscreen document (`offscreen.ts` + `wallet-service.ts`) is the **only** place in the extension that holds a `SparkWallet` SDK instance. Neither the popup nor the background service worker instantiates one directly. The Spark SDK is bundled exclusively into the offscreen entry — the popup chunk does not import it.

| Concern | Popup (`App.tsx`) | Background (`background.ts`) | Offscreen (`wallet-service.ts`) |
|---|---|---|---|
| `chrome.storage` access | ✅ Full access (via `src/lib/storage.ts`) | ✅ Full access | ❌ Not available |
| `chrome.runtime` messaging | ✅ | ✅ | ✅ (only API available) |
| Spark SDK / WASM | ❌ Not bundled | ❌ Service workers can't run WASM reliably | ✅ Runs in a document context |
| Wallet lifecycle | ❌ | ❌ | ✅ Single cached instance for offscreen lifetime; explicit `TIPT_DISPOSE_WALLET` on reset |

### Popup ↔ Offscreen messages

Before sending any wallet message the popup calls `ensureOffscreen()` (`src/lib/wallet-client.ts`), which calls `chrome.offscreen.createDocument` if the offscreen document does not already exist. The result is **memoized** after the first successful creation. All wallet messages are sent via `sendWalletMessage` (a thin `chrome.runtime.sendMessage` wrapper).

The offscreen `chrome.runtime.onMessage` listener is structured as a single handler map (`handlers: Record<string, (payload) => Promise<Envelope>>`) instead of a long `if`-chain. Every handler returns either `{ ok: true, ... }` or `{ ok: false, error }`; thrown errors are caught and converted to the same `{ ok: false, error }` envelope.

| Message type | Payload | Response |
|---|---|---|
| `TIPT_WALLET_CREATE` | `{ mnemonic?: string }` | `{ ok, mnemonic, balanceSats: string }` |
| `TIPT_GET_BALANCE` | *(none)* | `{ ok, balance: string }` |
| `TIPT_GET_TRANSFERS` | `{ limit, offset }` | `{ ok, transfers }` |
| `TIPT_CREATE_INVOICE` | `{ amountSats }` | `{ ok, invoice }` |
| `TIPT_GET_FEE_ESTIMATE` | `{ encodedInvoice }` | `{ ok, feeSats }` |
| `TIPT_PAY_INVOICE` | `{ invoice, maxFeeSats, walletRaw? }` | `{ ok, txId? }` (handler auto-initializes the wallet from `walletRaw` + the IndexedDB-cached AES key if no cached SDK instance exists) |
| `TIPT_HAS_WALLET` | *(none)* | `{ ok, hasWallet, balanceSats? }` (returns cached balance when a wallet is initialized) |
| `TIPT_DISPOSE_WALLET` | *(none)* | `{ ok }` (popup sends this from the wallet-reset flow so the offscreen tears down its SDK instance) |

### Offscreen → Popup event broadcast (long-lived port)

The popup opens a long-lived port via `chrome.runtime.connect({ name: 'tipt-wallet' })` (see `connectWalletPort` in `src/lib/wallet-client.ts`). The offscreen registers an `onConnect` listener for that name and attaches a per-port wallet-event listener.

When `transfer:claimed` or `deposit:confirmed` fires on the SDK, the offscreen pushes a message **down the port**:

```ts
{ type: 'TIPT_WALLET_EVENT', payload: { event: 'transfer:claimed' | 'deposit:confirmed', balance: string } }
```

The popup's port listener updates `balanceSats` from `payload.balance`. Using a port (instead of a broadcast `sendMessage`) keeps the offscreen document alive while the popup is open and disposes its listener on port disconnect.

### Background ↔ Offscreen relationship (402 flow)

Because the offscreen document cannot access `chrome.storage`, the background reads all credentials before delegating. The `TIPT_OFFSCREEN_PAY_INVOICE` message carries:

```ts
{
  invoice: string,      // BOLT11 to pay
  walletRaw: string,    // encrypted mnemonic (local first, sync fallback for legacy installs)
}
```

`payInvoice` (in `wallet-service.ts`) is the single unified pay path used by both the popup send flow and the background 402 flow. When called from the 402 path with `pollPreimage: true`, if the SDK response does not already contain a preimage it polls `getLightningSendRequest` every **750 ms** for up to **60 seconds** to retrieve it. The popup send flow does not poll — it returns the `txId` from the immediate `payLightningInvoice` result.

`disposeWallet` calls only `cleanupConnections()` and `removeAllListeners()`; the previous custom teardown logic was removed.

---

## Source layout

```
src/
├── App.tsx                 # Top-level wallet UI (~760 lines; was ~1320 pre-refactor)
├── ConfirmApp.tsx          # 402 confirm popup React app
├── background.ts           # MV3 service worker, 402 orchestration, confirm window mgmt
├── confirm.tsx             # confirm.html entry point
├── constants.ts            # Storage keys, PIN policy, PinAttemptsState interface
├── content.ts              # MPP CustomEvent bridge (mpp:request / mpp:pay / mpp:payresponse)
├── crypto.ts               # PBKDF2 (default 600k, legacy 100k) + AES-GCM helpers
├── lnurl.ts                # LNURL resolve + safe-URL guard (https only, no private hosts)
├── main.tsx                # index.html entry point
├── offscreen.ts            # Offscreen entry; handler map + wallet-event port
├── wallet-service.ts       # Sole SparkWallet owner; persists for offscreen lifetime, disposed via TIPT_DISPOSE_WALLET
├── components/
│   ├── BackupPromptScreen.tsx
│   ├── ErrorScreen.tsx
│   ├── IdleScreen.tsx
│   ├── InitializingScreen.tsx
│   ├── LoadingScreen.tsx
│   ├── PinInput.tsx
│   ├── PinLockScreen.tsx
│   ├── PinSetupScreen.tsx
│   ├── Spinner.tsx
│   └── ready/
│       ├── ActionTabs.tsx
│       ├── BalanceCard.tsx
│       ├── ReadyHeader.tsx     # Owns its own settings-menu open/close state
│       ├── ReadyScreen.tsx
│       ├── ReceivePanel.tsx
│       ├── SendPanel.tsx
│       └── TransferList.tsx
└── lib/
    ├── fees.ts             # getMaxFeeSats, getMaxSpendableSats (algebraic)
    ├── format.ts           # formatSats, formatUsd
    ├── logger.ts           # log/warn gated by import.meta.env.DEV; error always on
    ├── pin-attempts.ts     # PIN attempt tracking + lockout policy
    ├── storage.ts          # getItem/setItem/removeItem + setItemDual/getSynced/removeItemDual for chrome.storage
    ├── transfers.ts        # Transfer formatting/grouping helpers + WalletTransfer type
    └── wallet-client.ts    # ensureOffscreen, sendWalletMessage, connectWalletPort
```

### Bundle layout (after `vite build`)

- **Popup chunk** ≈ **64 KB** — no Spark SDK; only React, the UI, and the lib helpers.
- **Offscreen chunk** ≈ **5.4 MB** — contains the Spark SDK + WASM glue. Isolating the SDK to this entry is what keeps the popup small.
- **Confirm chunk** — tiny React app for the 402 approval popup.
- **`background.js`** and **`content.js`** — emitted as unhashed files at the extension root (per `vite.config.ts` output rule) so the manifest can reference them by stable name.

---

## Logging

`src/lib/logger.ts` exposes `log`, `warn`, and `error`:
- `log` and `warn` are no-ops in production builds and active only when `import.meta.env.DEV` is `true` (Vite replaces this at build time).
- `error` always writes to the console.

`background.ts` and `content.ts` use `log` for trace output; production builds therefore emit no console noise except for genuine errors.

---

## Security notes

- **PBKDF2 600,000 iterations** for new PINs; legacy 100k blobs are detected and re-encrypted lazily on the next successful unlock.
- **PIN attempt throttling** with 30 s / 5 min / 1 h lockouts at 5 / 10 / 15 failures.
- **LNURL safe-URL guard** applies to both the initial LNURL endpoint and the server-returned `callback`. https-only; no loopback / private / link-local / multicast / `.onion`.
- **Wallet secrets in both `chrome.storage.local` and `chrome.storage.sync`** via `setItemDual`. Local is the primary read path (fast); sync exists so a user signed into the same Chrome profile on another device automatically picks up their encrypted wallet. The PIN is required on every device to decrypt — sync only transports the ciphertext.
- **Mnemonic not retained in React state** after the app reaches `ready`. The backup-download flow re-derives the mnemonic on demand using the cached `CryptoKey`.
- **Confirm popup window** replaces the page-level `window.confirm`, so a hostile page cannot suppress, race, or visually spoof the dialog.
- **PIN-derived AES-GCM key cached in shared IndexedDB** (`src/lib/key-store.ts`) as a **non-extractable** `CryptoKey`. The raw PIN is never persisted — the previous `chrome.storage.session` entry that held it in plaintext has been removed. Background, popup, and offscreen contexts share the same extension-origin IDB and read the key directly to decrypt the wallet on 402 challenges without user interaction. `chrome.runtime.onStartup` clears the IDB entry on every browser launch, so the key's lifetime still matches a single browser session.

---

## Performance notes

- **Offscreen creation memoized** — `ensureOffscreen()` short-circuits after first success.
- **BTC price refresh aborts** in-flight requests on effect cleanup via `AbortController`.
- **`loadTransfers` debounced 500 ms** on balance changes.
- **`getMaxSpendableSats` algebraic** — closed-form solution; no general-purpose loop.
- **`chrome.storage` is the single source of truth** — no `localStorage` write-through layer.
- **Spark SDK isolated to offscreen** — popup bundle stays small.

---

## Manifest

- **Manifest version**: 3
- **Permissions**: `tabs`, `storage`, `offscreen`
- **Host permissions**: `<all_urls>`
- **Content script**: `content.js` injected at `document_start` on all URLs
- **Background**: `background.js` module service worker
- **CSP**: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` (WASM eval required for the Spark SDK in the offscreen document)
- **Extension pages**: `index.html` (popup, default action), `offscreen.html` (offscreen document), `confirm.html` (per-request 402 approval popup window)

---

## Storage Keys

| Key | Area | Contents |
|---|---|---|
| `spark_pin` | `chrome.storage.local` + `chrome.storage.sync` | `{ salt, iterations, verifier: { iv, ct } }`. Written via `setItemDual` (both areas). Reads via `getSynced` (local first, sync fallback). |
| `spark_wallet` | `chrome.storage.local` + `chrome.storage.sync` | Encrypted BIP-39 mnemonic: `{ iv, ct }`. Written via `setItemDual` (both areas). Reads via `getSynced` (local first, sync fallback). |
| `tipt_unlock_key` (IndexedDB) | shared `IDBDatabase` at extension origin | Non-extractable PBKDF2/AES-GCM `CryptoKey`. Stored via `src/lib/key-store.ts`. Cleared on `chrome.runtime.onStartup`, so its lifetime mirrors the previous `chrome.storage.session` PIN entry — but the raw PIN is never persisted. |
| `spark_btc_usd_rate` | `chrome.storage.local` | `{ rate: number, fetchedAt: number }` cached BTC→USD spot for the equivalent display. Refreshed every 5 minutes. |
| `spark_transfers_cache` | `chrome.storage.local` | AES-GCM-encrypted JSON of the 10 most recent transfers, keyed by the PIN-derived `CryptoKey`. |
| `spark_pin_attempts` | `chrome.storage.local` | `{ count, lockedUntil }` for PIN unlock throttling. |
| `tipt_402_allowlist` | `chrome.storage.local` | `{ [host]: true }` auto-approve map for the 402 confirm flow. |

All storage access goes through `src/lib/storage.ts` (`getItem` / `setItem` / `removeItem` / `getWithMigration`); there is no `localStorage` write-through.

