# TIPT (The Instant Payment Tool)

TIPT is a Lightning wallet Chrome extension.

## What It Does

- Protects access with a 6-digit PIN.
- Creates a new wallet or restores from a mnemonic.
- Shows wallet balance.
- Generates receive invoices (QR + copy).
- Sends payments via Lightning Address or LNURL.

## Prerequisites

- Node.js 20+
- npm 10+
- Google Chrome

## Quickstart

1. Install dependencies:

```bash
npm install
```

2. Build the extension:

```bash
npm run build:extension
```

3. Open Chrome extensions page:

```text
chrome://extensions
```

4. Enable Developer mode.
5. Click Load unpacked.
6. Select the `dist/extension` folder from this project.
7. Pin and open TIPT from the Chrome toolbar.

## First Run

1. Open TIPT.
2. Set your 6-digit PIN.
3. Create a new wallet or restore an existing one.
4. Verify you can view balance, receive, and send.

## Development Workflow

After any code change:

1. Rebuild:

```bash
npm run build:extension
```

2. Return to `chrome://extensions`.
3. Click Reload on the TIPT extension card.

