const BRIDGE_EVENT = 'TIPT_PAGE_402';
const PAYMENT_REQUEST_EVENT = 'TIPT_402_PAYMENT_REQUEST';
const PAYMENT_RESPONSE_EVENT = 'TIPT_402_PAYMENT_RESPONSE';
const RETRY_HEADER = 'x-tipt-402-retry';

interface ChallengePayload {
  scheme: string;
  invoice: string;
  rawHeader?: string;
  macaroon?: string;
  token?: string;
  paymentChallenge?: {
    id: string;
    realm: string;
    method: string;
    intent: string;
    request: string;
    expires?: string;
    opaque?: string;
  };
}

interface PaymentRequestPayload {
  source: 'fetch' | 'xhr';
  url: string;
  method: string;
  challenge: ChallengePayload;
}

interface PaymentResponsePayload {
  approved: boolean;
  authorization?: string;
  error?: string;
}

interface TiptPatchedXhr extends XMLHttpRequest {
  __tiptMethod?: string;
  __tiptUrl?: string;
  __tiptAsync?: boolean;
  __tiptUser?: string | null;
  __tiptPassword?: string | null;
  __tiptHeaders?: Array<[string, string]>;
  __tiptBody?: Document | XMLHttpRequestBodyInit | null;
  __tiptRetried?: boolean;
  __tiptLoadendInstalled?: boolean;
}

type TiptWindow = Window & {
  __TIPT_402_HOOK_INSTALLED__?: boolean;
};

const win = window as TiptWindow;

if (!win.__TIPT_402_HOOK_INSTALLED__) {
  win.__TIPT_402_HOOK_INSTALLED__ = true;

  const report402 = (payload?: Record<string, unknown>) => {
    window.postMessage({ type: BRIDGE_EVENT, payload }, '*');
  };

  const hasPaymentChallengeHeaderText = (wwwAuthRaw: string): boolean => {
    const wwwAuth = wwwAuthRaw.toLowerCase();
    return wwwAuth.includes('payment') || wwwAuth.includes('invoice') || wwwAuth.includes('challenge') || wwwAuth.includes('l402');
  };

  // Wrap Headers.get() to suppress "Refused to get unsafe header" browser warnings
  // for CORS-restricted headers like www-authenticate.
  const safeGetHeader = (headers: Headers, name: string): string | null => {
    try {
      return headers.get(name);
    } catch {
      return null;
    }
  };

  // Parse a header value from the raw string returned by getAllResponseHeaders()
  // to avoid triggering browser "unsafe header" warnings via getResponseHeader().
  const parseHeaderFromRaw = (rawHeaders: string, headerName: string): string | null => {
    const prefix = headerName.toLowerCase() + ':';
    for (const line of rawHeaders.split('\r\n')) {
      if (line.toLowerCase().startsWith(prefix)) {
        return line.slice(prefix.length).trim();
      }
    }
    return null;
  };

  const hasPaymentChallengeHeader = (headers: Headers): boolean => {
    return hasPaymentChallengeHeaderText(safeGetHeader(headers, 'www-authenticate') ?? '');
  };

  const decodeBase64UrlJson = (value: string): Record<string, unknown> | null => {
    try {
      const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
      const decoded = atob(padded);
      return JSON.parse(decoded) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const extractInvoiceFromRequestToken = (requestToken: string | undefined): string | null => {
    if (!requestToken) {
      return null;
    }

    const requestObject = decodeBase64UrlJson(requestToken);
    if (!requestObject) {
      return null;
    }

    const methodDetails =
      requestObject.methodDetails && typeof requestObject.methodDetails === 'object'
        ? (requestObject.methodDetails as Record<string, unknown>)
        : null;

    const candidates = [
      methodDetails?.invoice,
      requestObject.invoice,
      requestObject.bolt11,
      requestObject.pr,
      requestObject.payment_request,
      requestObject.paymentRequest,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }

    return null;
  };

  const getHeaderValueFromObject = (headersObject: unknown, headerName: string): string | null => {
    if (!headersObject || typeof headersObject !== 'object') {
      return null;
    }

    const target = headerName.toLowerCase();
    for (const [key, value] of Object.entries(headersObject as Record<string, unknown>)) {
      if (key.toLowerCase() === target && typeof value === 'string') {
        return value;
      }
    }

    return null;
  };

  const extractInvoiceFromObject = (data: Record<string, unknown>): string | null => {
    const methodDetails =
      data.methodDetails && typeof data.methodDetails === 'object'
        ? (data.methodDetails as Record<string, unknown>)
        : null;

    const candidates = [
      data.invoice,
      data.bolt11,
      data.pr,
      data.payment_request,
      data.paymentRequest,
      methodDetails?.invoice,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }

    const requestToken = typeof data.request === 'string' ? data.request : undefined;
    return extractInvoiceFromRequestToken(requestToken);
  };

  const parseChallengeHeader = (wwwAuthenticateHeader: string | null): ChallengePayload | null => {
    if (!wwwAuthenticateHeader) {
      return null;
    }

    const raw = wwwAuthenticateHeader.trim();
    if (!raw || !hasPaymentChallengeHeaderText(raw)) {
      return null;
    }

    const firstSpaceIndex = raw.indexOf(' ');
    const scheme = (firstSpaceIndex > -1 ? raw.slice(0, firstSpaceIndex) : raw).trim();
    const paramsPart = firstSpaceIndex > -1 ? raw.slice(firstSpaceIndex + 1) : '';
    const params: Record<string, string> = {};
    const pairRegex = /(\w+)=("(?:[^"\\]|\\.)*"|[^,]*)/g;
    let match: RegExpExecArray | null;

    while ((match = pairRegex.exec(paramsPart)) !== null) {
      const key = match[1].toLowerCase();
      const rawValue = match[2].trim();
      const value = rawValue.startsWith('"') && rawValue.endsWith('"')
        ? rawValue.slice(1, -1)
        : rawValue;
      params[key] = value;
    }

    const requestToken = params.request;
    const invoice = params.invoice ?? params.bolt11 ?? params.pr ?? extractInvoiceFromRequestToken(requestToken) ?? '';
    if (!invoice) {
      return null;
    }

    const isPaymentScheme = scheme.toLowerCase() === 'payment';
    const paymentChallenge =
      isPaymentScheme && params.id && params.realm && params.method && params.intent && requestToken
        ? {
          id: params.id,
          realm: params.realm,
          method: params.method,
          intent: params.intent,
          request: requestToken,
          expires: params.expires,
          opaque: params.opaque,
        }
        : undefined;

    return {
      scheme: scheme || 'L402',
      invoice,
      rawHeader: raw,
      macaroon: params.macaroon,
      token: params.token,
      paymentChallenge,
    };
  };

  const extractInvoiceFromBody = (payload: unknown): string | null => {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const data = payload as Record<string, unknown>;
    const invoice = extractInvoiceFromObject(data);
    if (invoice) {
      return invoice;
    }

    const nestedHeader = getHeaderValueFromObject(data.headers, 'www-authenticate');
    const nestedFromHeader = parseChallengeHeader(nestedHeader);
    if (nestedFromHeader?.invoice) {
      return nestedFromHeader.invoice;
    }

    if (typeof data.body === 'string') {
      try {
        const nestedBody = JSON.parse(data.body) as Record<string, unknown>;
        console.log('[TIPT-PH] extractInvoiceFromBody: parsed nested body, keys:', Object.keys(nestedBody));

        const nestedInvoice = extractInvoiceFromObject(nestedBody);
        if (nestedInvoice) {
          return nestedInvoice;
        }
      } catch (e) {
        console.log('[TIPT-PH] extractInvoiceFromBody: failed to parse nested body string');
      }
    } else if (data.body && typeof data.body === 'object') {
      const nestedInvoice = extractInvoiceFromObject(data.body as Record<string, unknown>);
      if (nestedInvoice) {
        return nestedInvoice;
      }
    }

    console.log('[TIPT-PH] extractInvoiceFromBody: no invoice found in fields. Available keys:', Object.keys(data));
    return null;
  };

  const toAbsoluteUrl = (input: RequestInfo | URL): string => {
    if (typeof input === 'string') {
      return new URL(input, window.location.href).toString();
    }

    if (input instanceof URL) {
      return input.toString();
    }

    return input.url;
  };

  const randomId = () => {
    if (typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  };

  const request402Payment = (payload: PaymentRequestPayload): Promise<PaymentResponsePayload> => {
    const requestId = randomId();
    console.log('[TIPT-PH] Requesting 402 payment with requestId:', requestId, 'invoice:', payload.challenge.invoice?.slice(0, 20));

    return new Promise<PaymentResponsePayload>((resolve) => {
      const onMessage = (event: MessageEvent) => {
        if (event.source !== window) return;
        const data = event.data as {
          type?: string;
          requestId?: string;
          response?: PaymentResponsePayload;
        };

        if (!data || data.type !== PAYMENT_RESPONSE_EVENT || data.requestId !== requestId) {
          return;
        }

        console.log('[TIPT-PH] Received payment response:', data.response);
        window.removeEventListener('message', onMessage);
        resolve(data.response ?? { approved: false, error: 'No payment response received.' });
      };

      window.addEventListener('message', onMessage);
      console.log('[TIPT-PH] Posting payment request event to content script');
      window.postMessage({ type: PAYMENT_REQUEST_EVENT, requestId, payload }, '*');
    });
  };

  const isFetchRetryAttempt = (args: Parameters<typeof window.fetch>): boolean => {
    const input = args[0];
    const init = args[1];

    if (input instanceof Request) {
      return input.headers.get(RETRY_HEADER) === '1';
    }

    const headers = new Headers(init?.headers);
    return headers.get(RETRY_HEADER) === '1';
  };

  const buildFetchRetryArgs = (
    args: Parameters<typeof window.fetch>,
    requestClone: Request | null,
    authorization: string,
  ): Parameters<typeof window.fetch> | null => {
    const input = args[0];

    if (input instanceof Request) {
      if (!requestClone) {
        return null;
      }

      const headers = new Headers(requestClone.headers);
      headers.set('Authorization', authorization);
      headers.set(RETRY_HEADER, '1');
      return [new Request(requestClone, { headers })];
    }

    const init = args[1] ?? {};
    const headers = new Headers(init.headers);
    headers.set('Authorization', authorization);
    headers.set(RETRY_HEADER, '1');
    return [input, { ...init, headers }];
  };

  const getFetchMethod = (args: Parameters<typeof window.fetch>): string => {
    const initMethod = args[1]?.method;
    if (initMethod) {
      return initMethod.toUpperCase();
    }

    const input = args[0];
    if (input instanceof Request) {
      return input.method.toUpperCase();
    }

    return 'GET';
  };

  const challengeFromResponse = (headers: Headers, body: unknown): ChallengePayload | null => {
    const fromHeader = parseChallengeHeader(safeGetHeader(headers, 'www-authenticate'));
    if (fromHeader) {
      return fromHeader;
    }

    if (body && typeof body === 'object') {
      const bodyRecord = body as Record<string, unknown>;

      const wrappedHeader = getHeaderValueFromObject(bodyRecord.headers, 'www-authenticate');
      const wrappedFromHeader = parseChallengeHeader(wrappedHeader);
      if (wrappedFromHeader) {
        return wrappedFromHeader;
      }

      if (typeof bodyRecord.body === 'string') {
        try {
          const nestedBody = JSON.parse(bodyRecord.body) as Record<string, unknown>;
          const nestedHeader = getHeaderValueFromObject(nestedBody.headers, 'www-authenticate');
          const nestedFromHeader = parseChallengeHeader(nestedHeader);
          if (nestedFromHeader) {
            return nestedFromHeader;
          }
        } catch {
          // Ignore malformed wrapper payloads and fall back to field extraction.
        }
      }
    }

    const bodyInvoice = extractInvoiceFromBody(body);
    if (!bodyInvoice) {
      return null;
    }

    return {
      scheme: 'L402',
      invoice: bodyInvoice,
    };
  };

  const bodyLooksLikePaymentRequired = (payload: unknown): boolean => {
    if (!payload || typeof payload !== 'object') {
      return false;
    }

    const data = payload as Record<string, unknown>;
    const status = data.status;
    const title = typeof data.title === 'string' ? data.title.toLowerCase() : '';
    const type = typeof data.type === 'string' ? data.type.toLowerCase() : '';
    const detail = typeof data.detail === 'string' ? data.detail.toLowerCase() : '';
    const message = typeof data.message === 'string' ? data.message.toLowerCase() : '';
    const error = typeof data.error === 'string' ? data.error.toLowerCase() : '';

    if (status === 402 || status === '402') {
      return true;
    }

    const matched = (
      title.includes('payment required') ||
      detail.includes('payment is required') ||
      type.includes('payment-required') ||
      message.includes('payment required') ||
      message.includes('payment necessary') ||
      error.includes('payment required') ||
      error.includes('payment necessary')
    );
    
    if (matched) {
      console.log('[TIPT-PH] bodyLooksLikePaymentRequired: true. Full body:', data);
    }
    
    return matched;
  };

  const originalFetch = window.fetch;
  window.fetch = async (...args) => {
    let requestClone: Request | null = null;
    const input = args[0];

    if (input instanceof Request) {
      try {
        requestClone = input.clone();
      } catch {
        requestClone = null;
      }
    }

    const response = await originalFetch(...args);

    const isJson = (response.headers.get('content-type')?.toLowerCase() ?? '').includes('application/json');
    let body: unknown = null;
    if (isJson) {
      try {
        body = await response.clone().json();
      } catch {
        body = null;
      }
    }

    const hasHeaderChallenge = hasPaymentChallengeHeader(response.headers);
    const bodySignals402 = bodyLooksLikePaymentRequired(body);
    const challenge = challengeFromResponse(response.headers, body);

    if (response.status === 402 || hasHeaderChallenge || bodySignals402) {
      console.log('[TIPT-PH] Fetch detected 402, status:', response.status, 'hasHeaderChallenge:', hasHeaderChallenge, 'bodySignals402:', bodySignals402);
      console.log('[TIPT-PH] Response body:', body);
      console.log('[TIPT-PH] Challenge found:', challenge);
      report402({
        source: 'fetch',
        url: response.url || toAbsoluteUrl(args[0]),
        method: getFetchMethod(args),
        status: response.status,
      });

      if (!isFetchRetryAttempt(args) && challenge?.invoice) {
        console.log('[TIPT-PH] Fetch: requesting payment for invoice:', challenge.invoice.slice(0, 20));
        const paymentResult = await request402Payment({
          source: 'fetch',
          url: response.url || toAbsoluteUrl(args[0]),
          method: getFetchMethod(args),
          challenge,
        });

        console.log('[TIPT-PH] Fetch payment result:', paymentResult);
        if (paymentResult.approved && paymentResult.authorization) {
          console.log('[TIPT-PH] Fetch: retrying with authorization');
          // Decode and log the credential for debugging
          try {
            const tokenPart = paymentResult.authorization.split(' ')[1] ?? '';
            const pad = tokenPart + '='.repeat((4 - tokenPart.length % 4) % 4);
            const decoded = atob(pad.replace(/-/g, '+').replace(/_/g, '/'));
            console.log('[TIPT-PH] Credential JSON:', decoded);
          } catch { /* ignore */ }

          const retryArgs = buildFetchRetryArgs(args, requestClone, paymentResult.authorization);
          if (retryArgs) {
            const retryResponse = await originalFetch(...retryArgs);
            let retryBody: string | null = null;
            try { retryBody = await retryResponse.clone().text(); } catch { /* ignore */ }
            console.log('[TIPT-PH] Retry response status:', retryResponse.status, 'body:', retryBody);
            return retryResponse;
          }
        }
      } else {
        console.log('[TIPT-PH] Fetch: skipping payment (isRetry:', isFetchRetryAttempt(args), 'hasInvoice:', !!challenge?.invoice, ')');
      }
    }

    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (
    this: TiptPatchedXhr,
    method: string,
    url: string | URL,
    async?: boolean,
    user?: string | null,
    password?: string | null,
  ) {
    this.__tiptMethod = method.toUpperCase();
    this.__tiptUrl = typeof url === 'string' ? new URL(url, window.location.href).toString() : url.toString();
    this.__tiptAsync = async;
    this.__tiptUser = user ?? null;
    this.__tiptPassword = password ?? null;
    this.__tiptHeaders = [];
    this.__tiptRetried = false;

    return originalOpen.call(this, method, url, async ?? true, user ?? null, password ?? null);
  };

  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (this: TiptPatchedXhr, name: string, value: string) {
    if (!this.__tiptHeaders) {
      this.__tiptHeaders = [];
    }

    this.__tiptHeaders.push([name, value]);
    return originalSetRequestHeader.call(this, name, value);
  };

  const originalSend = XMLHttpRequest.prototype.send;

  const retryXmlHttpRequest = async (xhr: TiptPatchedXhr, challenge: ChallengePayload) => {
    if (xhr.__tiptRetried) {
      return;
    }

    const url = xhr.__tiptUrl;
    const method = xhr.__tiptMethod ?? 'GET';
    if (!url || !challenge.invoice) {
      return;
    }

    const paymentResult = await request402Payment({
      source: 'xhr',
      url,
      method,
      challenge,
    });

    if (!paymentResult.approved || !paymentResult.authorization) {
      return;
    }

    xhr.__tiptRetried = true;

    originalOpen.call(
      xhr,
      method,
      url,
      xhr.__tiptAsync ?? true,
      xhr.__tiptUser ?? null,
      xhr.__tiptPassword ?? null,
    );

    for (const [name, value] of xhr.__tiptHeaders ?? []) {
      if (name.toLowerCase() === 'authorization' || name.toLowerCase() === RETRY_HEADER) {
        continue;
      }
      originalSetRequestHeader.call(xhr, name, value);
    }

    originalSetRequestHeader.call(xhr, 'Authorization', paymentResult.authorization);
    originalSetRequestHeader.call(xhr, RETRY_HEADER, '1');
    originalSend.call(xhr, xhr.__tiptBody ?? null);
  };

  XMLHttpRequest.prototype.send = function (this: TiptPatchedXhr, body?: Document | XMLHttpRequestBodyInit | null) {
    this.__tiptBody = body ?? null;

    if (!this.__tiptLoadendInstalled) {
      this.__tiptLoadendInstalled = true;

      this.addEventListener('loadend', function (this: TiptPatchedXhr) {
        const rawHeaders = this.getAllResponseHeaders();
        const headersRaw = rawHeaders.toLowerCase();
        const hasChallengeHeader = headersRaw.includes('www-authenticate:') &&
          (headersRaw.includes('payment') || headersRaw.includes('invoice') || headersRaw.includes('challenge') || headersRaw.includes('l402'));

        // Only parse www-authenticate when we know it's present — avoids "unsafe header" browser warning.
        const responseHeader = hasChallengeHeader ? parseHeaderFromRaw(rawHeaders, 'www-authenticate') : null;

        let bodySignals402 = false;
        let parsedBody: unknown = null;
        const responseType = this.responseType;
        if (responseType === '' || responseType === 'text') {
          try {
            parsedBody = JSON.parse(this.responseText) as unknown;
            bodySignals402 = bodyLooksLikePaymentRequired(parsedBody);
          } catch {
            bodySignals402 = false;
          }
        }

        if (this.status === 402 || hasChallengeHeader || bodySignals402) {
          console.log('[TIPT-PH] XHR detected 402, status:', this.status, 'hasChallengeHeader:', hasChallengeHeader, 'bodySignals402:', bodySignals402);
          report402({
            source: 'xhr',
            url: this.__tiptUrl ?? window.location.href,
            method: this.__tiptMethod ?? 'GET',
            status: this.status,
          });

          const challenge = parseChallengeHeader(responseHeader)
            ?? (extractInvoiceFromBody(parsedBody)
              ? {
                scheme: 'L402',
                invoice: extractInvoiceFromBody(parsedBody) as string,
              }
              : null);

          console.log('[TIPT-PH] XHR challenge parsed:', !!challenge?.invoice ? challenge.invoice.slice(0, 20) : 'no invoice');
          if (!this.__tiptRetried && challenge?.invoice) {
            console.log('[TIPT-PH] XHR: requesting payment for invoice:', challenge.invoice.slice(0, 20));
            void retryXmlHttpRequest(this, challenge);
          }
        }
      });
    }

    return originalSend.call(this, body);
  };
}