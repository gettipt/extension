const BRIDGE_EVENT = 'TIPT_PAGE_402';
type TiptWindow = Window & {
  __TIPT_402_HOOK_INSTALLED__?: boolean;
};

const win = window as TiptWindow;

if (!win.__TIPT_402_HOOK_INSTALLED__) {
  win.__TIPT_402_HOOK_INSTALLED__ = true;

  const report402 = () => {
    window.postMessage({ type: BRIDGE_EVENT }, '*');
  };

  const hasPaymentChallengeHeader = (headers: Headers): boolean => {
    const wwwAuth = headers.get('www-authenticate')?.toLowerCase() ?? '';
    return wwwAuth.includes('payment') || wwwAuth.includes('invoice') || wwwAuth.includes('challenge');
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

    if (status === 402 || status === '402') {
      return true;
    }

    return (
      title.includes('payment required') ||
      detail.includes('payment is required') ||
      type.includes('payment-required')
    );
  };

  const originalFetch = window.fetch;
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (response.status === 402 || hasPaymentChallengeHeader(response.headers)) {
      report402();
      return response;
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (contentType.includes('application/json')) {
      try {
        const body = await response.clone().json();
        if (bodyLooksLikePaymentRequired(body)) {
          report402();
        }
      } catch {
        // Ignore JSON parsing failures and preserve normal fetch behavior.
      }
    }

    return response;
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    this.addEventListener('loadend', function () {
      const headers = this.getAllResponseHeaders().toLowerCase();
      const hasChallengeHeader = headers.includes('www-authenticate:') &&
        (headers.includes('payment') || headers.includes('invoice') || headers.includes('challenge'));

      let bodySignals402 = false;
      const responseType = this.responseType;
      if (responseType === '' || responseType === 'text') {
        try {
          const parsed = JSON.parse(this.responseText) as unknown;
          bodySignals402 = bodyLooksLikePaymentRequired(parsed);
        } catch {
          bodySignals402 = false;
        }
      }

      if (this.status === 402 || hasChallengeHeader || bodySignals402) {
        report402();
      }
    });

    return originalSend.call(this, body);
  };
}