import { bech32 } from 'bech32';

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

  const res = await fetch(url);
  if (!res.ok) throw new Error(`LNURL fetch failed: ${res.status}`);
  const data = await res.json();
  if (data.status === 'ERROR') throw new Error(data.reason ?? 'LNURL error');

  let description = '';
  try {
    const meta: [string, string][] = JSON.parse(data.metadata);
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
  const url = `${callback}${callback.includes('?') ? '&' : '?'}amount=${amountMsats}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Invoice fetch failed: ${res.status}`);
  const data = await res.json();
  if (data.status === 'ERROR') throw new Error(data.reason ?? 'Invoice error');
  return data.pr;
}
