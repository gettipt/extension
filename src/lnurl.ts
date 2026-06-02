import { bech32 } from 'bech32';
import { safeJsonFetch } from './lib/http';

export interface LnurlPayInfo {
  callback: string;
  minSendableMsats: number;
  maxSendableMsats: number;
  description: string;
}

function decodeLnurlToUrl(lnurl: string): string {
  const { words } = bech32.decode(lnurl, 2000);
  const bytes = bech32.fromWords(words);
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function lightningAddressToUrl(address: string): string {
  const [user, domain] = address.split('@');
  return `https://${domain}/.well-known/lnurlp/${user}`;
}

function isDisallowedHost(host: string): boolean {
  // Normalise: lowercase + drop trailing FQDN dot. URL.hostname doesn't
  // include the dot when the URL is parsed (`https://foo.local./` → `foo.local`),
  // but a literal trailing dot can slip in via direct string callers. The
  // dot is purely a DNS root indicator and doesn't change the resolved host,
  // so endsWith-checks like `.local` / `.onion` would otherwise miss
  // `foo.local.` / `bar.onion.`.
  let h = host.toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);

  // Block well-known local / special-use names.
  if (h === 'localhost' || h === '0.0.0.0') return true;
  if (h.endsWith('.local') || h.endsWith('.localhost')) return true;
  if (h.endsWith('.onion') || h.endsWith('.onion]')) return true;

  // Reject ALL IP literals. No legitimate LNURL service uses one, and trying
  // to enumerate private ranges (especially IPv6: ::1, ::ffff:127.0.0.1,
  // 64:ff9b::/96 NAT64, IPv4-mapped, etc.) is error-prone. Allowlisting DNS
  // names is strictly safer.

  // IPv4 literal (URL.hostname returns no brackets for IPv4).
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;

  // IPv6 literal: URL.hostname returns these wrapped in brackets, and a colon
  // is otherwise illegal in a hostname (ports are separated and stripped).
  if (h.includes(':')) return true;
  if (h.startsWith('[') || h.endsWith(']')) return true;

  return false;
}

function assertSafeUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL.');
  }
  if (url.protocol !== 'https:') {
    throw new Error('LNURL endpoints must use https.');
  }
  if (isDisallowedHost(url.hostname)) {
    throw new Error('LNURL endpoint host is not allowed.');
  }
  return url;
}

// Bounded fetch parameters for every LNURL HTTP call. `safeJsonFetch`
// sets `redirect: 'error'` so a server can't redirect us to a private
// network or non-HTTPS scheme after the initial assertSafeUrl; the timeout
// and byte cap defend against hung sockets and oversized responses.
const LNURL_TIMEOUT_MS = 10_000;
const LNURL_MAX_BYTES = 32 * 1024;

interface LnurlPayResponse {
  tag?: unknown;
  status?: string;
  reason?: string;
  callback?: unknown;
  minSendable?: unknown;
  maxSendable?: unknown;
  metadata?: unknown;
}

interface LnurlInvoiceResponse {
  status?: string;
  reason?: string;
  pr?: unknown;
}

export async function resolveLnurlPayInfo(input: string): Promise<LnurlPayInfo> {
  let url: string;
  const trimmed = input.trim();

  if (trimmed.toLowerCase().startsWith('lnurl')) {
    url = decodeLnurlToUrl(trimmed);
  } else if (trimmed.includes('@')) {
    url = lightningAddressToUrl(trimmed);
  } else {
    throw new Error('Unsupported input — use a Lightning Address (user@domain.com) or LNURL.');
  }

  const safeUrl = assertSafeUrl(url);
  const data = await safeJsonFetch<LnurlPayResponse>(safeUrl.toString(), {
    timeoutMs: LNURL_TIMEOUT_MS,
    maxBytes: LNURL_MAX_BYTES,
  });
  if (data && data.status === 'ERROR') throw new Error(data.reason ?? 'LNURL error');

  if (!data || typeof data !== 'object') {
    throw new Error('LNURL response was not a JSON object.');
  }
  // Reject non-payRequest LNURL types (lnurl-auth, lnurl-withdraw, etc.) —
  // they happen to share fields with payRequest in some implementations but
  // mean very different things. Accepting one as a payRequest could let a
  // malicious server trick the popup into paying when the user intended a
  // different LNURL flow.
  if (typeof data.tag !== 'string' || data.tag !== 'payRequest') {
    throw new Error('Not a payRequest LNURL endpoint.');
  }
  if (typeof data.callback !== 'string' || data.callback.length === 0) {
    throw new Error('LNURL response missing "callback" string.');
  }
  if (typeof data.minSendable !== 'number' || !Number.isFinite(data.minSendable)) {
    throw new Error('LNURL response missing "minSendable" number.');
  }
  if (typeof data.maxSendable !== 'number' || !Number.isFinite(data.maxSendable)) {
    throw new Error('LNURL response missing "maxSendable" number.');
  }

  // Constrain callback host so we never make a follow-up request to a private network.
  assertSafeUrl(data.callback);

  let description = '';
  try {
    const meta: [string, string][] = JSON.parse(data.metadata as string);
    const t = meta.find(([type]) => type === 'text/plain');
    if (t) description = t[1];
  } catch { /**/ }

  return {
    callback: data.callback,
    minSendableMsats: data.minSendable,
    maxSendableMsats: data.maxSendable,
    description,
  };
}

export async function fetchInvoiceFromCallback(
  callback: string,
  amountMsats: number,
): Promise<string> {
  // Use URL parsing for amount append so a callback containing a `#fragment`
  // does NOT end up with `amount=...` inside the fragment (string concat
  // with `?`/`&` puts it after the fragment when the URL has one).
  const callbackUrl = assertSafeUrl(callback);
  callbackUrl.searchParams.set('amount', String(amountMsats));
  const safeUrl = assertSafeUrl(callbackUrl.toString());
  const data = await safeJsonFetch<LnurlInvoiceResponse>(safeUrl.toString(), {
    timeoutMs: LNURL_TIMEOUT_MS,
    maxBytes: LNURL_MAX_BYTES,
  });
  if (data && data.status === 'ERROR') throw new Error(data.reason ?? 'Invoice error');
  if (!data || typeof data.pr !== 'string' || data.pr.length === 0) {
    throw new Error('Invoice response missing "pr" string.');
  }
  return data.pr;
}
