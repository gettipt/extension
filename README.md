# TIPT (The Instant Payment Toolkit)

This project is a simplified Spark Network Bitcoin Lightning wallet built as a Chrome extension popup using React + TypeScript + Tailwind + Vite.

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
