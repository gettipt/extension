// Hardened JSON fetch helper used for any HTTP call to an untrusted
// endpoint (LNURL servers, CoinGecko, etc.). Defends the renderer / service
// worker against:
//   * hung connections — `AbortController` timeout closes the socket after
//     `timeoutMs`.
//   * unbounded responses — we cap by `Content-Length` when present and by
//     streaming-read byte count otherwise, so a hostile server can't OOM the
//     extension by sending megabytes of JSON.
//   * server-initiated redirects to internal hosts — `redirect: 'error'`
//     turns any 3xx into a network error. Callers are still expected to
//     validate the initial URL.

export interface SafeJsonFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 64 * 1024;

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export class ResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(`Response exceeded ${limit} bytes.`);
    this.name = 'ResponseTooLargeError';
  }
}

export async function safeJsonFetch<T = unknown>(
  url: string,
  options: SafeJsonFetchOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const response = await fetch(url, {
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new HttpError(response.status, `HTTP ${response.status}`);
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      const declared = Number(contentLength);
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new ResponseTooLargeError(maxBytes);
      }
      // Fast path: when the server advertises a small payload, skip the
      // stream-reader plumbing and just await `.text()`. Stream-reading a
      // chunked-decoder under WebStreams has measurable overhead (clone,
      // chunk concat, decoder); for the ~150-byte CoinGecko price response
      // it dominates the entire fetch cost.
      if (Number.isFinite(declared) && declared > 0 && declared <= 1024) {
        const text = await response.text();
        // UTF-16 code units (text.length) are always <= UTF-8 byte length
        // (a code unit can encode to 1-3 UTF-8 bytes, a surrogate pair to 4
        // bytes total / 2 code units = 2 bytes/unit minimum). So a length
        // exceeding maxBytes guarantees the byte count does too — no need
        // to allocate the encoder buffer before failing.
        if (text.length > maxBytes) throw new ResponseTooLargeError(maxBytes);
        const bytes = new TextEncoder().encode(text);
        if (bytes.length > maxBytes) throw new ResponseTooLargeError(maxBytes);
        return JSON.parse(text) as T;
      }
    }

    // Stream-read with a byte cap so chunked / no-Content-Length responses
    // can still be truncated before they exhaust memory.
    const reader = response.body?.getReader();
    let buffer: Uint8Array;
    if (!reader) {
      const text = await response.text();
      if (text.length > maxBytes) throw new ResponseTooLargeError(maxBytes);
      const bytes = new TextEncoder().encode(text);
      if (bytes.length > maxBytes) throw new ResponseTooLargeError(maxBytes);
      buffer = bytes;
    } else {
      const chunks: Uint8Array[] = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          try { await reader.cancel(); } catch { /* best-effort */ }
          throw new ResponseTooLargeError(maxBytes);
        }
        chunks.push(value);
      }
      buffer = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }

    const text = new TextDecoder().decode(buffer);
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timeoutId);
    if (options.signal) options.signal.removeEventListener('abort', onExternalAbort);
  }
}
