# TIPT (The Instant Payment Tool)

TIPS is a simplified lightning wallet built as a Chrome extension.

Core flows included in this MVP:
- Set up and unlock with a 6-digit PIN
- Create a new wallet or recover from mnemonic phrase
- View live balance
- Receive via generated Lightning invoice (QR + copy)
- Send via Lightning Address or LNURL

## Tech Stack

- React + TypeScript
- Tailwind CSS
- Vite (dev server + build tooling)
- Spark SDK (`@buildonspark/spark-sdk`)

## Prerequisites

Install dependencies:

```bash
npm install
```

## Dev Testing (Web App)

Use Vite dev server for local development:

```bash
npm run dev
```

Then open the URL shown in terminal.

## Build Extension Changes

Build the extension bundle:

```bash
npm run build:extension
```

Build output is generated at:

```text
dist/extension/
```

## MPP Lightning Extension SDK (client-side)

The browser-side SDK that extends the Lightning MPP client flow and routes 402 payment approval through this extension now lives in its own package: [`lightning-mpp-extension-sdk`](https://www.npmjs.com/package/lightning-mpp-extension-sdk).

```bash
npm install lightning-mpp-extension-sdk @buildonspark/lightning-mpp-sdk mppx
```

```ts
import { createTiptLightningClient } from 'lightning-mpp-extension-sdk'

const tipt = createTiptLightningClient({
  polyfill: false,
})

const response = await tipt.fetch('https://api.example.com/paid-endpoint')
```

Behavior:
- Intercepts `402` responses via `Mppx.create`.
- Probes for extension with `mpp:extension` (`type: 'request'`) including `paymentMethods: ['lightning']` and `intents: ['charge']`.
- Converts Lightning `Payment` challenge fields into TIPT `mpp:challenge`.
- Receives `mpp:credential.credential` from extension and retries the original request automatically.

## Load in Chrome as an Extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked**
4. Select this folder:

```text
dist/extension
```

5. Click the extensions icon in the Chrome toolbar and open **TIPT**

## Update Workflow

After making code changes:

1. Rebuild:

```bash
npm run build:extension
```

2. Go back to `chrome://extensions`
3. Click **Reload** on the Spark Wallet extension card
