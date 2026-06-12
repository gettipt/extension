# TIPT — Extension Specification

TIPT is a Chrome extension that embeds a self-custodial Bitcoin wallet (Lightning via BOLT11 + Spark off-Lightning transfers) and handles HTTP 402 Payment Required challenges on behalf of the user via an explicit MPP event protocol.

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
- Successful unlock derives a non-extractable AES-GCM `CryptoKey` from the PIN via PBKDF2 and caches the key handle (never the raw PIN) in shared IndexedDB (`src/lib/key-store.ts`). The cache is wiped on `chrome.runtime.onStartup` so it behaves like a session-only value.
- If the cached key is missing the wallet is considered locked; any background 402 payment attempt will fail with a "Wallet is locked" error.

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
- Device-only keys (`spark_pin_attempts`, `spark_transfers_cache`, `tipt_402_allowlist`, `spark_btc_usd_rate`) remain in their respective single areas — they are not synced. The 402 allowlist is intentionally per-device: a user who trusts a host on their laptop must explicitly re-trust it on their phone. The PIN-derived AES-GCM `CryptoKey` is cached separately in shared **IndexedDB** (`src/lib/key-store.ts`) as a non-extractable handle — never as raw PIN bytes — and is cleared on browser startup so it behaves like the old session-only PIN.

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
- **Backup mnemonic** — downloads a plaintext `TIPT-Wallet-Backup.txt`. The action is gated behind a re-prompt for the PIN via `PinPromptModal`, even when the wallet is already unlocked, so a brief moment of unattended-device access cannot exfiltrate the recovery phrase. The in-memory mnemonic is cleared from React state once the app transitions to `ready`, so `downloadBackupFile()` is `async` and re-derives the mnemonic on demand by decrypting `spark_wallet` with the cached `CryptoKey`. The download dialog warns explicitly that the file is plain text and grants full spending authority.
- **Trusted Sites** — opens the `TrustedSitesScreen`, which lists every host on the 402 allowlist with its `maxSatsPerPayment`, `maxSatsPerDay`, and `spentToday` counters. Each row offers a "Remove" button. Read/write happens through `TIPT_402_ALLOWLIST_LIST` / `TIPT_402_ALLOWLIST_REMOVE` messages handled in the background service worker.
- **Copy Spark Address** — a one-click settings item that asks the offscreen for the wallet's bech32m Spark address (`sp1…`, per [Spark addressing docs](https://docs.spark.money/wallets/addressing#spark-addresses)) via `TIPT_GET_SPARK_ADDRESS` and writes it to the clipboard with `navigator.clipboard.writeText`. The address is derived from already-loaded identity material so there is no Spark cluster round trip; the button briefly flips to "Copied!" / "Copy failed" to give visible feedback and re-enables itself on the next menu open. Unlike Backup / Delete this action does **not** require a PIN re-prompt because the Spark address is a public identifier — anyone who sees an invoice or sends payments to the wallet already learns it.
- **Delete wallet** — gated behind the same PIN re-prompt (`PinPromptModal`, destructive variant). The previous `globalThis.confirm` dialog was removed in favour of the modal so the user has to actively reproduce the PIN before any data is wiped. On confirm, `removeItemDual` clears `spark_pin` and `spark_wallet` from both `local` and `sync`; `spark_transfers_cache`, `spark_pin_attempts`, and `spark_btc_usd_rate` are removed from `local`; the legacy `spark_session_pin` is dropped from `session`; the IndexedDB-cached AES key is cleared; and the page reloads to the setup screen.

---

## Send

The Send panel accepts Lightning Addresses and LNURLs. Both resolve via LNURL-pay to fetch a BOLT11 invoice.

### LNURL URL safety
- Only `https://` URLs are accepted.
- The hostname must not be a loopback / private / link-local / multicast IPv4 literal, an IPv6 loopback / link-local / unique-local literal, `localhost`, a `.local` / `.localhost` name, or a `.onion` address.
- The initial LNURL/`.well-known/lnurlp` URL **and** the `callback` URL returned by the server are both validated, so a malicious server cannot redirect TIPT to a private network for the invoice fetch.
- The `.well-known/lnurlp` JSON response must include `tag === 'payRequest'`. Other LNURL response shapes (`login`, `withdrawRequest`, etc.) are rejected even when they happen to expose a `callback` field.
- The callback URL is composed with `URL` + `URLSearchParams.set('amount', …)` rather than naïve string concatenation, so a `callback` that contains a `#fragment` no longer ends up with `amount=` parsed inside the fragment instead of the query.

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
TIPT only announces itself when asked. The page and extension use a single discovery event, `mpp:extension`, and distinguish direction by `detail.type` (`'request'` from the page, `'response'` from TIPT). TIPT also notifies the background to set the toolbar icon for that tab. When **no wallet is configured**, the background additionally paints an orange `!` badge on the icon to draw the user's attention so they know they need to open the extension and create or restore one before the site's payment will succeed.

```js
// Site asks if a wallet is present and declares desired methods + intents
window.dispatchEvent(new CustomEvent('mpp:extension', {
  detail: { type: 'request', paymentMethods: ['lightning'], intents: ['charge'] }
}));

// TIPT responds
window.addEventListener('mpp:extension', (e) => {
  if (e.detail?.type !== 'response') return;
  console.log(e.detail);
  // {
  //   type: 'response',
  //   name: 'TIPT',
  //   version: '0.0.1',
  //   intents: ['charge'],
  //   paymentMethods: ['lightning'],
  //   requestedIntents: ['charge'],
  //   requestedPaymentMethods: ['lightning'],
  //   supportsRequestedIntents: true,
  //   supportsRequestedPaymentMethods: true,
  //   walletConfigured: true | false | undefined,
  // }
});
```

The extension advertises Lightning-only support in discovery:
- `intents: ['charge']`
- `paymentMethods: ['lightning']`

Payments flow through the same `mpp:challenge` event.

`walletConfigured` reports whether the user has set up a wallet in the extension yet — i.e., whether `chrome.storage` holds an encrypted wallet blob under `WALLET_KEY`. Sites can use this to render a friendlier "set up your wallet first" hint instead of letting the payment fail at the confirm step. Two notes:

- The first `mpp:extension` response on a page may arrive with `walletConfigured: undefined` because the content script dispatches an immediate announcement *before* it has finished asking the background. As soon as the background replies, the content script dispatches a second `mpp:extension` response with the resolved value (but only if it differs from the cached value — so steady-state pages still see exactly one event per request). Pages that care about the field should register a continuous listener, not a `once: true` listener.
- The toolbar icon swap is **per tab**, so the orange badge only appears on tabs that have actually advertised an MPP discovery request. Once the user creates a wallet, the next `mpp:extension` request from a given tab clears that tab's badge.

> **Note:** Always register the `mpp:extension` listener before dispatching the `type: 'request'` event, since CustomEvents are synchronous.

### Payment Request
The site dispatches `mpp:challenge` with the payment target and (for Spark transfers) the amount. TIPT settles the payment and dispatches `mpp:credential` with the resulting credential value.

```js
// Site requests payment
window.dispatchEvent(new CustomEvent('mpp:challenge', {
  detail: {
    requestId: 'unique-id',        // Correlated in the response
    invoice: 'lnbc...',            // BOLT11 invoice OR Spark address ('spark1…' / 'sp1…') (required)
    amountSats: 1000,              // REQUIRED for Spark addresses; IGNORED for BOLT11 (amount embedded)
    scheme: 'L402',                // Optional: 'L402' | 'Payment' | 'SparkTransfer' | other
    macaroon: '...',               // Optional: for L402
    token: '...',                  // Optional
    challenge: {                   // Optional: for Payment/MPP scheme
      id, realm, method, intent, request, expires?, opaque?
    }
  }
}));

// Site listens for the result
window.addEventListener('mpp:credential', (e) => {
  const { requestId, approved, credential, error } = e.detail;
  if (approved) {
    // Retry the original request with the Authorization header
  }
});
```

The wire field is named `invoice` for back-compatibility with sites already integrating MPP, but the meaning is generalised to "payment target" — it may be a BOLT11 invoice or a Spark address. The extension classifies by prefix (see *Payment kinds*).

### SDK wrapper for automatic 402 handling

The browser-side wrapper now lives in the external `lightning-mpp-extension-sdk` package and provides `createLightningMppExtensionClient()`, built on top of `@buildonspark/lightning-mpp-sdk` + `mppx` client primitives:

1. Intercepts HTTP `402` responses through `Mppx.create`.
2. Reads the `lightning/charge` challenge and dispatches `mpp:challenge` to TIPT.
3. Waits for `mpp:credential` and uses the returned `credential` value as the retry credential.
4. Automatically retries the original request with `Authorization: <credential>`.

This keeps website integration aligned with MPP challenge semantics while preserving TIPT as the payment-authority UX and wallet execution surface.

### Payment kinds

TIPT discriminates payment targets via `src/lib/payment-target.ts`. The classifier uses pure prefix matching on the lowercased value (Lightning HRPs always start with `ln`, Spark addresses always start with `sp` — the two families are disjoint, so prefix matching is unambiguous):

| Kind | Prefixes | SDK call | Authorization shape |
|---|---|---|---|
| `lightning` | `lnbc`, `lntb`, `lntbs`, `lnbcrt` | `wallet.payLightningInvoice({ invoice, maxFeeSats })` | `L402` / `Payment` / `Bearer` + preimage (see *Supported challenge schemes*) |
| `spark` | `spark1`, `sparkt1`, `sparkrt1`, `sparks1`, `sparkl1`, plus legacy `sp1`, `spt1`, `sprt1`, `sps1`, `spl1` | `wallet.transfer({ amountSats, receiverSparkAddress })` | `SparkTransfer <transferId>` — the Spark transfer id, opaque to TIPT |
| `unknown` | anything else | — | request rejected with `unavailable` error code |

The Spark prefix list mirrors the SDK's `AddressNetwork` + `LegacyAddressNetwork` constants. Spark invoices issued via `createSatsInvoice` share the same prefix family (they encode additional invoice fields inside the bech32m payload but the prefix bytes are identical), so they route through the same branch.

For Spark transfers there is no Lightning preimage and no L402 macaroon, so `buildAuthorizationValue` does not apply. The background returns `credential: 'SparkTransfer <id>'` — purely informational for MPP integrations; a real-world consumer would specify its own verification scheme on top of the Spark transfer id.

### Supported challenge schemes

| Scheme | Authorization format |
|---|---|
| `L402` | `L402 <macaroon>:<preimage>` |
| `Payment` (MPP) | `Payment <base64url(JCS credential)>` |
| Other / fallback | `Bearer <preimage>` |

The `Payment` credential echoes the challenge fields and embeds the preimage, serialized using **RFC 8785 JSON Canonicalization Scheme (JCS)** and base64url-encoded.

### Approval flow
1. Site dispatches `mpp:challenge` with invoice and challenge details.
2. Content script forwards to the background service worker as `TIPT_402_PAY_REQUEST` with `source: 'mpp'`. The background derives the request host from `sender.url` (the browser-attested URL of the dispatching frame), never from the page-supplied `payload.url`, so a hostile page cannot impersonate a previously-allowlisted host. The content script also rate-limits `mpp:extension` discovery requests to once per **250 ms** per tab so a hostile page cannot spam the service worker awake by spinning `dispatchEvent`.
3. Background runs `classifyPaymentTarget(invoice)` (see *Payment kinds*). Unknown prefixes are rejected with the `unavailable` error code; the request never enters the prompt/payment path. For Lightning targets the BOLT11 amount is decoded via `src/lib/bolt11.ts` (a minimal HRP regex; the full Spark SDK cannot run inside the MV3 service worker). The decoded amount is required for any auto-approval path — zero-amount or unparseable invoices always prompt. The HRP regex anchors the amount group to `(0|[1-9]\d*)` so non-canonical encodings like `lnbc0001m1…` are rejected up-front. For Spark targets the BOLT11 decoder is bypassed and the payer-supplied `amountSats` becomes authoritative; the request is rejected outright if `amountSats` is missing, non-positive, or non-integer.
4. **Wallet-setup gate.** Before any auto-approve or prompt, the background checks `getSynced(WALLET_KEY)`. If no wallet is configured, it opens the main extension UI (`index.html`) as a top-right popup window (`chrome.windows.create({ type: 'popup' })`, anchored like the confirm popup) so the user can create or restore a wallet, and waits — via a `chrome.storage.onChanged` listener on `WALLET_KEY` (the encrypted blob is written by `setItemDual` to `local` and best-effort `sync`) — for setup to complete. As soon as the wallet blob lands, the setup window is closed and the approval flow continues normally. Concurrent no-wallet challenge requests collapse onto a single setup window and a shared completion promise (`walletSetupWait`). This gate deliberately precedes `tryAutoApprove` so a host the user previously allowlisted can never silently auto-approve into a payment the extension cannot fulfil — the missing wallet would otherwise only surface as an opaque failure at pay time. If the user closes the setup window without finishing, or the shared 5-minute budget (`CONFIRM_TIMEOUT_MS`) elapses, the request is aborted with the `unavailable` error code. A successful setup also re-triggers `prewarmWallet()` so the freshly-created wallet's offscreen SDK starts initialising before the confirm popup resolves.
5. Background calls `tryAutoApprove(host, amountSats)` (see *Allowlist*). When the host has caps that permit the payment, it atomically debits `spentToday` and proceeds without prompting.
6. Otherwise, the background opens a dedicated **confirm popup window** (`confirm.html`) via `chrome.windows.create({ type: 'popup', width: 380, height: 320 })`. Those dimensions are only the *initial* size — `ConfirmApp` runs `useAutoResizeWindow`, which uses a `ResizeObserver` on the root container plus `chrome.windows.update` to size the window so its inner content area exactly matches the rendered DOM (no vertical or horizontal scrollbar) and to re-anchor the right edge so the popup stays glued to the top-right corner as the optional cap field expands/collapses. The popup is positioned at the top-right of the currently focused normal browser window (computed from `chrome.windows.getLastFocused({ windowTypes: ['normal'] })` with a 16 px margin) so it appears in the same place as the in-page toasts from extensions like Honey or Rakuten rather than wherever Chrome would place an unpositioned popup. If the lookup fails the popup falls back to Chrome's default placement. Pending request details — `{ host, url, method, invoice, amountSats, expiresAt, paymentKind }` — are written to `chrome.storage.session` under `tipt_pending_confirm_<id>` and the in-memory promise resolver is kept in a `Map<id, PendingConfirm>` keyed by `crypto.randomUUID()`. The created `window.id` is also tracked in `confirmWindowToId: Map<number, string>` so a `chrome.windows.onRemoved` listener can resolve the pending entry as *declined* the instant the user closes the popup with the [X] button (instead of waiting for the 5-minute alarm to free the host's confirm slot).
7. The confirm popup renders `ConfirmApp` (`src/ConfirmApp.tsx`) and reads the request details directly from `chrome.storage.session` (no round-trip to the service worker is required). It relies on the popup window's own title bar (`TIPT — Approve Payment`) for the heading and shows: a *Method* badge ("Lightning — BOLT11 invoice" or "Spark — off-Lightning transfer", color-coded), *Site* (host), *Amount* (sats), and — for Spark transfers only — a truncated *Recipient* address (mono, first 14 + last 8 chars; full address available via the row's `title=` tooltip). The raw HTTP request line and the BOLT11 invoice / Spark address are not surfaced in their entirety in the UI by default — they remain in `chrome.storage.session` for the background's own use. An "Auto-approve future payments from this site, up to the daily cap below" checkbox reveals a single *Max per day (sats)* input (default 2× the current amount, low enough that runaway approvals are bounded in single-digit transactions). The collected daily cap is sent as both `maxSatsPerPayment` and `maxSatsPerDay` in `TIPT_402_CONFIRM_RESPONSE`, so a single number is the only constraint on subsequent auto-approvals. Auto-approve is only offered when `amountSats` is known (always true for Spark transfers, conditional on a parseable BOLT11 HRP amount for Lightning).
8. The popup sends `TIPT_402_CONFIRM_RESPONSE` with `{ id, approved, remember, caps? }` and closes itself **only after** the message has been acknowledged. If `chrome.runtime.sendMessage` throws (e.g., the service worker was recycled between the user clicking Approve and the message dispatch) or the background returns `{ ok: false }`, `ConfirmApp` surfaces the error in the popup and keeps the window open so the user can retry rather than silently losing the approval and waiting for the 5-minute timeout. The background's onMessage handler restricts acceptance to messages whose `sender.url` starts with the extension's own `confirm.html`. The shared `PENDING_CONFIRM_PREFIX` / `pendingConfirmStorageKey(id)` / `PersistedConfirmDetails` definitions live in `src/lib/confirm-protocol.ts` so the popup and worker cannot drift on the storage key prefix or payload shape.
9. If the user does not respond, the background **auto-declines after 5 minutes**. Expiry is enforced by `chrome.alarms` (`tipt-confirm-<id>`) so the timer survives service worker restarts. The alarm handler resolves any in-memory pending entry and removes the `tipt_pending_confirm_<id>` session-storage record.
10. On approval, the background settles the payment via the offscreen document. **Lightning** targets go through `TIPT_OFFSCREEN_PAY_INVOICE` and return a Lightning preimage which is fed into `buildAuthorizationValue` to produce an `L402`/`Payment`/`Bearer` `Authorization` header. **Spark** targets go through `TIPT_OFFSCREEN_SPARK_TRANSFER` (which calls `wallet.transfer({ amountSats, receiverSparkAddress })`) and return a Spark transfer id, returned as `credential: 'SparkTransfer <id>'`. When `remember` is set and `amountSats > 0`, the background persists the host + caps via `rememberHost(host, { maxSatsPerPayment, maxSatsPerDay, initialSpentSats: amountSats })`. The `Authorization` builder, JCS canonicaliser, base64url encoder, and opaque-decoder live in `src/lib/auth-credentials.ts` (separated from `background.ts` to keep the service-worker entry focused on orchestration).
11. **All error strings returned to the page are first mapped to one of four opaque codes** — `'declined' | 'unavailable' | 'locked' | 'failed'` — via `sanitise402Error`. The site therefore learns success/failure plus a coarse category and cannot fingerprint internal wallet state (locked vs. uninitialised vs. SDK-specific error). Internal `[TIPT-BG]` logs still capture the full message for developer diagnostics.
12. Content script dispatches `mpp:credential` back to the page.
13. Site retries its original request with the `Authorization` header.

> The previous design used `window.confirm()` inside the content script (via a `TIPT_PROMPT_402_PAYMENT` message). That path has been removed. The earlier `TIPT_402_CONFIRM_READY` round-trip used by the confirm popup to fetch its display details was also removed in favour of a direct `chrome.storage.session` read.

### Allowlist
- Per-host auto-approval stored in `chrome.storage.local` under `tipt_402_allowlist`. Each entry has the shape:

  ```ts
  {
    maxSatsPerPayment: number;  // single-invoice cap (sats)
    maxSatsPerDay: number;      // rolling per-day cap (sats); 0 = unlimited per day
    spentToday: number;         // running total for `dayKey`
    dayKey: string;             // UTC date `YYYY-MM-DD`; running total resets when this changes
    addedAt: number;            // epoch ms
  }
  ```

- Legacy `Record<host, true>` entries from versions before per-host caps are silently dropped on first load. The user must re-grant explicit caps the next time a previously-allowlisted host requests payment.
- `tryAutoApprove(host, amountSats)` enforces caps: it returns `{ approved: false }` whenever `amountSats` is unknown (e.g. zero-amount invoice), exceeds `maxSatsPerPayment`, or would push `spentToday + amountSats` over `maxSatsPerDay`. Otherwise it atomically updates `spentToday` and returns `{ approved: true }`.
- The popup can list and revoke entries via `TIPT_402_ALLOWLIST_LIST` and `TIPT_402_ALLOWLIST_REMOVE` messages handled in the background. Both are gated to internal (extension-origin) senders.
- All I/O is routed through `getItem`/`setItem` in `src/lib/storage.ts`, which gives the allowlist storage-layer memcache + hash-deduped sync writes for free. `allowlist.ts` keeps an additional module-level `cache: Allowlist | null` holding the *parsed* object so concurrent `tryAutoApprove` calls mutate the same reference — without this, two parallel parses would each see `spentToday = N`, both write `N + amt`, and silently lose one of the increments. A focused `chrome.storage.onChanged` listener (scoped to the single allowlist key) nulls the parsed cache when another extension context writes to it.
- Persisting every `spentToday` increment is deliberate: MV3 service workers can be terminated at any moment, so deferring the write via a setTimeout/debounce could lose pending bumps and silently make the daily cap more permissive than the user authorised. `chrome.alarms` has 30 s minimum precision, too coarse to be useful here.

---

## Architecture

```
┌──────────────────────────────┐        ┌─────────────────────────────────┐
│  Popup (React — App.tsx +    │        │  Confirm popup window           │
│  src/components/*)           │        │  (confirm.html + ConfirmApp.tsx)│
│  Wallet UI: setup, unlock,   │        │  Per-request 402 approval UI    │
│  send, receive               │        └────────────────┬────────────────┘
└──────┬─────────┬─────────────┘                         │
       │         │ chrome.runtime.connect                │ TIPT_402_CONFIRM_RESPONSE
       │         │ ('tipt-wallet' port)                  │ + chrome.storage.session
       │         │ + chrome.runtime.sendMessage          │   (rehydrate request)
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
       │                                                  │ chrome.windows.create
       │ chrome.storage.local / .session                  │ (confirm popup)
       │ (single source of truth in src/lib/storage.ts)   │
       │                                          ┌───────▼────────┐
       │                                          │  Content Script│
       │                                          │  (content.ts)  │  CustomEvents (mpp:*)
       │                                          └───────┬────────┘
       │                                                  │ mpp:extension   (page ⇄ TIPT, type=request/response)
       │                                                  │ mpp:challenge    (page → TIPT)
       │                                                  │ mpp:credential   (TIPT → page)
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

**Multi-listener dispatch hardening.** Both the background service worker and the offscreen document attach `chrome.runtime.onMessage` listeners to the same channel. To stop them from interfering on each other's traffic, each listener bails out (returns `undefined`) BEFORE running any sender validation when the incoming `msg.type` is not in its own handler map. This keeps a context completely out of the dispatch race for messages it doesn't own, so the sender's `await` reliably wires to the listener that actually responds rather than resolving to `undefined`. The popup-side allowlist screen (`TrustedSitesScreen.tsx`) also retries `chrome.runtime.sendMessage` once with a short delay if the first attempt resolves to `undefined`, as defense-in-depth against transient service-worker recycle races.

| Message type | Payload | Response |
|---|---|---|
| `TIPT_WALLET_CREATE` | `{ mnemonic?: string }` | `{ ok, mnemonic, balanceSats: string }` |
| `TIPT_GET_BALANCE` | *(none)* | `{ ok, balance: string }` |
| `TIPT_GET_TRANSFERS` | `{ limit, offset }` | `{ ok, transfers }` |
| `TIPT_CREATE_INVOICE` | `{ amountSats }` | `{ ok, invoice }` |
| `TIPT_GET_FEE_ESTIMATE` | `{ encodedInvoice }` | `{ ok, feeSats }` |
| `TIPT_PAY_INVOICE` | `{ invoice, maxFeeSats, walletRaw? }` | `{ ok, txId? }` (handler auto-initializes the wallet from `walletRaw` + the IndexedDB-cached AES key if no cached SDK instance exists) |
| `TIPT_OFFSCREEN_SPARK_TRANSFER` | `{ receiverSparkAddress, amountSats, walletRaw }` | `{ ok, txId }` (calls `wallet.transfer`; same cold-restart pattern as `TIPT_PAY_INVOICE`) |
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

The Spark-transfer counterpart `TIPT_OFFSCREEN_SPARK_TRANSFER` carries:

```ts
{
  receiverSparkAddress: string,
  amountSats: number,   // payer-supplied; required and validated > 0 in background
  walletRaw: string,
}
```

`payInvoice` (in `wallet-service.ts`) is the single unified pay path used by both the popup send flow and the background 402 flow. When called from the 402 path with `pollPreimage: true`, if the SDK response does not already contain a preimage it polls `getLightningSendRequest` every **750 ms** for up to **60 seconds** to retrieve it. The popup send flow does not poll — it returns the `txId` from the immediate `payLightningInvoice` result. `payToSparkAddress` is the Spark sibling — it reuses the same `ensureWalletFromBlob` cold-restart logic but calls `wallet.transfer({ amountSats, receiverSparkAddress })` and returns `{ txId }` taken from the SDK's `WalletTransfer.id`. There is no preimage to poll for, so the Spark path returns as soon as the SDK call resolves.

`disposeWallet` calls only `cleanupConnections()` and `removeAllListeners()`; the previous custom teardown logic was removed.

---

## Source layout

```
src/
├── App.tsx                 # Top-level wallet UI (~770 lines; was ~1320 pre-refactor)
├── ConfirmApp.tsx          # 402 confirm popup React app — reads `tipt_pending_confirm_<id>` directly
├── background.ts           # MV3 service worker, 402 orchestration, allowlist caps, confirm window mgmt
├── confirm.tsx             # confirm.html entry point (uses `bootstrap()`)
├── constants.ts            # Storage keys, PIN policy, PinAttemptsState interface
├── content.ts              # MPP CustomEvent bridge (mpp:extension / mpp:challenge / mpp:credential)
├── crypto.ts               # PBKDF2 (default 600k, legacy 100k) + AES-GCM helpers
├── lnurl.ts                # LNURL resolve + safe-URL guard (https only, no private hosts)
├── main.tsx                # index.html entry point (uses `bootstrap()`)
├── main-bootstrap.tsx      # Shared React boot helper — gates StrictMode on import.meta.env.DEV
├── offscreen.ts            # Offscreen entry; handler map + wallet-event port
├── wallet-service.ts       # Sole SparkWallet owner; persists for offscreen lifetime, disposed via TIPT_DISPOSE_WALLET
├── components/
│   ├── BackupPromptScreen.tsx     # Backup download UI with explicit plain-text warning
│   ├── ErrorScreen.tsx
│   ├── IdleScreen.tsx
│   ├── InitializingScreen.tsx
│   ├── LoadingScreen.tsx
│   ├── PinInput.tsx
│   ├── PinLockScreen.tsx
│   ├── PinPromptModal.tsx         # Re-prompt overlay; gates Backup / Delete
│   ├── PinSetupScreen.tsx
│   ├── Spinner.tsx
│   ├── TrustedSitesScreen.tsx     # Allowlist list + revoke UI
│   └── ready/
│       ├── ActionTabs.tsx
│       ├── BalanceCard.tsx
│       ├── ReadyHeader.tsx     # Settings menu (Backup / Trusted Sites / Copy Spark Address / Delete)
│       ├── ReadyScreen.tsx
│       ├── ReceivePanel.tsx
│       ├── SendPanel.tsx
│       └── TransferList.tsx
└── lib/
    ├── allowlist.ts       # 402 allowlist with per-host caps; routes I/O through storage.ts + caches the parsed object
    ├── auth-credentials.ts # JCS canonicaliser + base64url + opaque decoder + Authorization builder for 402 retries
    ├── bolt11.ts          # Minimal HRP amount decoder used inside the MV3 service worker; rejects leading-zero amounts
    ├── confirm-protocol.ts # Shared PENDING_CONFIRM_PREFIX + pendingConfirmStorageKey + PersistedConfirmDetails
    ├── fees.ts            # getMaxFeeSats, getMaxSpendableSats (algebraic)
    ├── format.ts          # formatSats, formatUsd
    ├── http.ts            # safeJsonFetch — timeout, byte cap, redirect: 'error'
    ├── key-store.ts       # IndexedDB-backed non-extractable AES key cache
    ├── logger.ts          # log/warn gated by import.meta.env.DEV; error always on
    ├── messages.ts        # MSG constant + Envelope<T>; single source of truth for runtime message strings
    ├── migrate-legacy.ts  # scrubLegacyState — wipes pre-S7 plaintext PIN entry
    ├── object-helpers.ts  # getStringField + nonEmptyString — safe property/value extraction from unknown payloads
    ├── payment-target.ts  # classifyPaymentTarget + paymentKindLabel — prefix-based Lightning-vs-Spark routing
    ├── pin-attempts.ts    # PIN attempt tracking + lockout policy + verifyPin
    ├── runtime.ts         # isInternalSender — shared MV3 sender check
    ├── storage.ts         # getItem/setItem/... + in-memory cache + chrome.storage.onChanged invalidation + sync hash dedupe
    ├── transfers.ts       # Transfer formatting/grouping helpers + WalletTransfer type
    └── wallet-client.ts   # ensureOffscreen, sendWalletMessage, connectWalletPort
```

`src/hooks/useBtcUsdRate.ts` — extracted hook owning the BTC/USD spot price (cache seed, mount-time freshness check, 5-minute refresh interval).

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
- **PIN attempt throttling** with 30 s / 5 min / 1 h lockouts at 5 / 10 / 15 failures. The throttle is shared by the unlock screen and the `PinPromptModal` re-auth flow, so an attacker cannot bypass it by attacking the backup / delete prompts.
- **PIN re-prompt for sensitive actions** — Back-up-mnemonic and Delete-wallet both require a fresh PIN entry through `PinPromptModal`, even when the wallet is already unlocked. This defeats brief-physical-access attacks where an attacker would otherwise be able to exfiltrate the recovery phrase or wipe the wallet from a cached session.
- **Backup file warning** — the backup screen states explicitly that the downloaded file is plain text and grants full spending authority, to deter users from sending it through chat / email / cloud sync.
- **LNURL safe-URL guard** applies to both the initial LNURL endpoint and the server-returned `callback`. https-only; no loopback / private / link-local / multicast / `.onion`.
- **Safe HTTP fetches** — every outbound HTTP call to an untrusted endpoint (LNURL servers, CoinGecko) goes through `safeJsonFetch` (`src/lib/http.ts`), which enforces an `AbortController` timeout, streams the body with a byte cap, validates `Content-Length` when present, and sets `redirect: 'error'` so a hostile server cannot transparently send TIPT through a redirect into a private host.
- **402 host attestation** — the background derives the 402 request host from `sender.url` (the browser-attested URL of the dispatching frame), not from the page-supplied `payload.url`. A malicious page therefore cannot impersonate an already-allowlisted host.
- **One-confirm-per-host queueing** — `background.ts` keeps a `Set<host>` of hosts with an in-flight confirm popup and rejects further 402 requests from the same host until the user responds (or the 5 min alarm expires). A malicious page therefore cannot DoS the user with a stack of confirm windows.
- **Per-host caps with daily reset** — `tryAutoApprove` requires a successfully-decoded invoice amount and enforces `maxSatsPerPayment` plus a UTC-day `maxSatsPerDay` cap, with the running counter persisted to `chrome.storage.local`. Zero-amount or unparseable invoices always prompt.
- **Confirm popup sender check** — `TIPT_402_CONFIRM_RESPONSE` is only accepted when the sender URL starts with the extension's own `confirm.html`, so a content script that happens to share the same extension origin cannot spoof user approvals.
- **JCS hardened** — the RFC 8785 canonicaliser throws on non-finite numbers, `Symbol` / function values, and other unsupported types instead of silently emitting `null`, so a hostile server cannot trick TIPT into signing a payment credential that the upstream service then validates differently.
- **Opaque payload validation** — the optional `challenge.opaque` field is base64url-decoded and parsed as JSON, then validated as a flat `Record<string, string>` with each value ≤1024 chars. Nested objects, arrays, numbers, or oversize strings are rejected — preventing a hostile server from injecting structure into the JCS-signed credential TIPT echoes back.
- **Page-input length caps** — the content script (`src/content.ts`) rejects `mpp:challenge` payloads with `invoice` (BOLT11 invoice or Spark address) > 8192 chars, request IDs > 256 chars, opaque blobs > 4096 chars, or any short field (realm, method, intent) > 512 chars. Spark addresses are bounded at 1024 chars by the SDK itself, so the 8192 cap is conservative but harmless. The `amountSats` field, when present, must be a finite positive integer ≤ `Number.MAX_SAFE_INTEGER`. The `bolt11.decodeBolt11AmountSats` helper enforces the same 8192-char cap and a 19-digit amount cap on every decode path.
- **Manifest-permission minimisation** — `tabs` was removed; `host_permissions` was narrowed from `<all_urls>` to `https://*/*`; content scripts run on `https://*/*` plus `http://localhost/*` and `http://127.0.0.1/*` for local integration testing (production traffic still requires HTTPS — only the content-script injection match expands).
- **Wallet secrets in both `chrome.storage.local` and `chrome.storage.sync`** via `setItemDual`. Local is the primary read path (fast); sync exists so a user signed into the same Chrome profile on another device automatically picks up their encrypted wallet. The PIN is required on every device to decrypt — sync only transports the ciphertext.
- **Mnemonic not retained in React state** after the app reaches `ready`. The backup-download flow re-derives the mnemonic on demand using the cached `CryptoKey`.
- **Confirm popup window** replaces the page-level `window.confirm`, so a hostile page cannot suppress, race, or visually spoof the dialog.
- **PIN-derived AES-GCM key cached in shared IndexedDB** (`src/lib/key-store.ts`) as a **non-extractable** `CryptoKey`. The raw PIN is never persisted — the previous `chrome.storage.session` entry that held it in plaintext has been removed. Background, popup, and offscreen contexts share the same extension-origin IDB and read the key directly to decrypt the wallet on 402 challenges without user interaction. `chrome.runtime.onStartup` clears the IDB entry on every browser launch, so the key's lifetime still matches a single browser session.
- **AES-GCM ciphertext encoded as base64** for new writes (was hex); the decoder accepts either format so existing installs continue to read pre-migration blobs. Base64 is ~33 % smaller than hex, giving meaningful headroom under the `chrome.storage.sync` 8 KB per-item quota.
- **CSP `connect-src` restricted** — the extension's CSP whitelists `'self' https:` for `connect-src`, `'self' data:` for `img-src`, and `'self' 'unsafe-inline'` for `style-src`. `wss:` was dropped because nothing in the bundled code (Spark SDK, hooks, components) opens a WebSocket — verified by grepping the built `offscreen.js` for `new WebSocket(`. `https:` is retained because LNURL pay is an open protocol whose `callback` field can point to any HTTPS host operated by the recipient's wallet — narrowing to a fixed allowlist would break payments to arbitrary Lightning Addresses.
- **Storage sync-hash integrity** — `setItem` stamps the SHA-256 dedupe hash **after** the `chrome.storage.sync.set` await resolves, not before. A quota / offline failure no longer poisons the dedupe map with a hash that doesn't reflect on-disk state. Likewise, the `chrome.storage.onChanged` listener always *clears* the stale `lastSyncHash[key]` entry on any external sync change — the other context wrote a value we didn't compute the hash for, so the only correct local state is "unknown."
- **Confirm popup window-close = decline** — closing the confirm popup with the [X] button used to leave the host in the `hostsWithPendingConfirm` set until the 5-minute alarm fired (UX wedge + low-grade DoS on the user's own browsing). A `chrome.windows.onRemoved` listener now resolves the pending entry as declined the instant the window is closed.
- **ConfirmApp respond() surfaces errors** — `chrome.runtime.sendMessage` failures (e.g., service worker recycled mid-click) used to be swallowed by `finally { window.close() }`, leaving the user thinking they had approved while the awaiting tab silently timed out at 5 minutes. The popup now keeps itself open and shows the error so the user can retry.
- **`mpp:extension` request rate limiting** — the content script throttles `mpp:extension` discovery requests to once per 250 ms per tab, so a hostile page can't spam the service worker awake with a `dispatchEvent` loop.
- **Sanitised 402 error responses** — every error string returned from `handle402PaymentRequest` is mapped at the background→content boundary to one of four opaque codes (`'declined' | 'unavailable' | 'locked' | 'failed'`) by `sanitise402Error`. A site can no longer fingerprint internal wallet state ("Wallet is locked", "Wallet data not found", SDK internals) from the `mpp:credential` event. Internal logs keep the full message.
- **Background-side 402 payload revalidation** — `validate402Payload` re-applies the same length / type / required-field caps that `src/content.ts` enforces at the page boundary (invoice ≤ 8192, short fields ≤ 512, opaque ≤ 4096, `amountSats` is a finite positive integer ≤ `Number.MAX_SAFE_INTEGER`, etc.) before anything is fed into the JCS canonicaliser, BOLT11 decoder, payment-target classifier, or the SDK. A future regression in the content script — or a direct internal sender bypass — therefore can't push unbounded strings through the worker.
- **LNURL trailing-dot normalisation** — `isDisallowedHost` strips a trailing FQDN dot before its `.local` / `.onion` suffix checks, so a hostile LNURL of `https://service.onion./…` (or `https://printer.local./…`) can no longer slip past the private-network guard.

---

## Performance notes

- **Offscreen creation memoized** — `ensureOffscreen()` short-circuits after first success.
- **BTC price refresh aborts** in-flight requests on effect cleanup via `AbortController`. The initial fetch is skipped when the persisted cache is < 60 s old, removing one HTTP round-trip from most popup opens.
- **`loadTransfers` debounced 1500 ms** on balance changes; the longer window collapses the burst of `transfer:claimed` + `deposit:confirmed` + post-send `getBalance` events into one `getTransfers` round-trip per real-world payment.
- **`pollForPreimage` initial poll at 250 ms**, then exponential backoff to 1 s (was 5 s). Smaller ceiling captures the actual preimage-availability moment within ≤ 1 s of when the SDK exposes it, instead of leaving the user waiting up to ~5 s of pure idle time between an SDK update and the next poll.
- **Offscreen + SparkWallet SDK prewarm on `mpp:challenge`** — `handle402PaymentRequest` fires a fire-and-forget `prewarmWallet()` as soon as a valid invoice arrives, in parallel with the auto-approve check and (when needed) the confirm popup. By the time the user clicks **Approve & Pay**, the offscreen document is up and `SparkWallet.initialize` has already run (or is well underway), so the cold-start cost is no longer serialised onto the critical path between the click and the page receiving its `mpp:credential`. A `prewarmInflight` guard collapses concurrent calls and `ensureWalletFromBlob` is itself idempotent (returns the cached SDK instance on the second call). Prewarm intentionally does **not** fire on `mpp:extension` discovery, since that would cause wallet network activity — and an IP exposure to the Spark cluster — on every MPP-aware page visit even when the user never pays.
- **402 timing logs (DEV builds only)** — `handle402PaymentRequest` and `payInvoice` log per-stage timings: time spent in `tryAutoApprove`, user reaction time in the confirm popup, `ensureOffscreen`, fee-estimate round trip, `payLightningInvoice`, and `pollForPreimage`. Run a 402 flow with `npm run dev` and inspect the service-worker / offscreen consoles to see exactly where any given request spent its wall time.
- **In-memory storage cache** — `src/lib/storage.ts` caches every read in a `Map<string, string|null>` and invalidates via `chrome.storage.onChanged`. Popup-open flows that touch the same key 5+ times (e.g. `getSynced(WALLET_KEY)`) now hit the disk once.
- **Hash-deduped sync writes** — identical `chrome.storage.sync.set` calls are SHA-256-deduped and skipped, so chronic re-writes (e.g. allowlist `loadAllowlist` save-on-noop) don't burn through the 120-write-per-minute quota.
- **`safeJsonFetch` fast path** — responses with `Content-Length ≤ 1024` skip the stream-reader plumbing and just await `.text()`. Useful for the ~150-byte CoinGecko price response. The byte-cap check also short-circuits on `text.length > maxBytes` (UTF-16 code units are always ≤ UTF-8 byte length), avoiding a `TextEncoder().encode()` allocation when the body is obviously too big.
- **Parallel popup-mount reads** — `App.tsx` issues `getSynced(WALLET_KEY)` and `loadUnlockKey()` in a `Promise.all` on mount, shaving one IndexedDB / `chrome.storage` round-trip off every popup open.
- **Single Authorization-credential helper module** — `src/lib/auth-credentials.ts` factors the JCS canonicaliser, base64url-utf8 encoder, opaque decoder, and `buildAuthorizationValue` out of `background.ts`. The service worker entry shrinks by ~110 lines and the helpers are independently testable.
- **`getMaxSpendableSats` algebraic** — closed-form solution; no general-purpose loop.
- **`chrome.storage` is the single source of truth** — no `localStorage` write-through layer.
- **Spark SDK isolated to offscreen** — popup bundle stays small.
- **SDK payload serialisation contract** — `getWalletTransfers` runs SDK responses through `normaliseBigints`, which converts `bigint` → decimal string, `Date` → ISO string, `Map`/`Set` → object/array, and passes typed arrays through untouched. Without the `Date` branch every transfer's timestamp would round-trip to `{}` (because `Object.entries(date)` returns `[]`) and the popup would render "Unknown date" for every row.
- **`mpp:extension` request handler keeps the SW alive until icon + badge writes resolve** — the background MPP_REQUEST_TRIGGERED handler returns `true` and calls `sendResponse({ok:true, walletConfigured})` once it has finished reading the wallet blob from `chrome.storage` and painting the icon/badge for the tab. Without `return true` Chrome may unload the service worker mid-`await` and silently drop the icon swap when the worker had just spun up to handle this one message. The content script's `chrome.runtime.sendMessage` is wrapped in `.catch(() => {})` to suppress the unhandled-promise warning that fires on host pages when the SW is genuinely unreachable; in that case the page-side cache of `walletConfigured` is left unchanged so the previously-known value still rides along on the immediate `mpp:extension` response.

---

## Manifest

- **Manifest version**: 3
- **Permissions**: `storage`, `offscreen`, `alarms`
- **Host permissions**: `https://*/*` (narrowed from `<all_urls>` so the extension can never run cross-origin requests against `http://`, `file://`, or `chrome-extension://` targets)
- **Content script**: `content.js` injected at `document_start` on `https://*/*`, plus `http://localhost/*` and `http://127.0.0.1/*` so local integration pages are testable during development. 402 payments on the production web still require HTTPS endpoints; the loopback origins are a developer convenience only.
- **Background**: `background.js` module service worker
- **CSP**: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https:; img-src 'self' data:; style-src 'self' 'unsafe-inline'`. WASM eval is required for the Spark SDK in the offscreen document; `wss:` was dropped from `connect-src` after a grep of the built `offscreen.js` confirmed nothing in the bundle uses `new WebSocket(`. LNURL pay requires arbitrary HTTPS reach so `https:` is retained.
- **Extension pages**: `index.html` (popup, default action), `offscreen.html` (offscreen document), `confirm.html` (per-request 402 approval popup window)
- The `tabs` permission was removed when the 402 flow stopped using `chrome.tabs.sendMessage` (responses are now delivered via the per-request popup window). The `alarms` permission was added to enforce confirm-popup expiry across service-worker restarts.

---

## Storage Keys

| Key | Area | Contents |
|---|---|---|
| `spark_pin` | `chrome.storage.local` + `chrome.storage.sync` | `{ salt, iterations, verifier: { iv, ct } }`. Written via `setItemDual` (both areas). Reads via `getSynced` (local first, sync fallback). |
| `spark_wallet` | `chrome.storage.local` + `chrome.storage.sync` | Encrypted BIP-39 mnemonic: `{ iv, ct }`. Written via `setItemDual` (both areas). Reads via `getSynced` (local first, sync fallback). |
| `tipt_unlock_key` (IndexedDB) | shared `IDBDatabase` at extension origin | Non-extractable PBKDF2/AES-GCM `CryptoKey`. Stored via `src/lib/key-store.ts`. Cleared on `chrome.runtime.onStartup`, so its lifetime mirrors the previous `chrome.storage.session` PIN entry — but the raw PIN is never persisted. |
| `spark_btc_usd_rate` | `chrome.storage.local` | `{ rate: number, ts: number }` cached BTC→USD spot for the equivalent display. Refreshed every 5 minutes; the initial-mount refresh is skipped when the cached value is younger than 60 s. |
| `spark_transfers_cache` | `chrome.storage.local` | AES-GCM-encrypted JSON of the 10 most recent transfers, keyed by the PIN-derived `CryptoKey`. |
| `spark_pin_attempts` | `chrome.storage.local` | `{ count, lockedUntil }` for PIN unlock throttling. |
| `tipt_402_allowlist` | `chrome.storage.local` | Per-host auto-approve entries `{ [host]: { maxSatsPerPayment, maxSatsPerDay, spentToday, dayKey, addedAt } }`. Legacy `host: true` entries are dropped on load. |
| `tipt_pending_confirm_<id>` | `chrome.storage.session` | Per-pending-confirm display payload `{ host, url, method, invoice, amountSats, expiresAt }` used by the confirm popup to rehydrate without re-querying the service worker. Cleared on user response, on the matching `chrome.alarms` expiry, or when the session ends. |

All storage access goes through `src/lib/storage.ts` (`getItem` / `setItem` / `removeItem` / `getWithMigration`); there is no `localStorage` write-through.
