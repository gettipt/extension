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
- pnpm 10+
- Google Chrome

## Build Process

Run from `extension/`:

```bash
pnpm install
pnpm run dev
pnpm run typecheck
pnpm run build
pnpm run preview
```

- `dev`: starts Vite in development mode.
- `typecheck`: runs TypeScript project build checks.
- `build`: runs typecheck, then creates the production build in `dist/`.
- `preview`: serves the production build locally.

## Quickstart

1. Install dependencies:

```bash
pnpm install
```

2. Build the extension:

```bash
pnpm run build
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
pnpm run build
```

2. Return to `chrome://extensions`.
3. Click Reload on the TIPT extension card.

