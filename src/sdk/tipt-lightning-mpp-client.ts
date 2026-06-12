import { charge as lightningChargeMethod } from '@buildonspark/lightning-mpp-sdk';
import { Mppx } from '@buildonspark/lightning-mpp-sdk/client';
import { Method, PaymentRequest } from 'mppx';

const MPP_EXTENSION_EVENT = 'mpp:extension';
const MPP_CHALLENGE_EVENT = 'mpp:challenge';
const MPP_CREDENTIAL_EVENT = 'mpp:credential';

const DEFAULT_PAYMENT_TIMEOUT_MS = 90_000;
const DEFAULT_EXTENSION_PROBE_TIMEOUT_MS = 1_500;

interface MppResponseDetail {
  type?: string;
  name?: string;
  paymentMethods?: string[];
  intents?: string[];
  supportsRequestedPaymentMethods?: boolean;
  supportsRequestedIntents?: boolean;
}

interface MppExtChallengeDetail {
  requestId: string;
  invoice: string;
  amountSats?: number;
  scheme: 'Payment';
  challenge: {
    id: string;
    realm: string;
    method: string;
    intent: string;
    request: string;
    expires?: string;
    opaque?: string;
  };
}

interface MppExtCredentialDetail {
  requestId?: string;
  approved?: boolean;
  credential?: string;
  error?: string;
}

function requirePageEventBridge(): void {
  if (typeof window === 'undefined') {
    throw new Error('TIPT Lightning SDK requires a browser window context.');
  }
}

function randomRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `tipt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function parseAmountSats(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function waitForExtensionResponse(timeoutMs: number): Promise<MppResponseDetail> {
  return new Promise<MppResponseDetail>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('TIPT extension was not detected on this page.'));
    }, timeoutMs);

    const onResponse = (event: Event) => {
      const detail = (event as CustomEvent<MppResponseDetail>).detail;
      if (detail?.type !== 'response' || detail?.name !== 'TIPT') return;
      if (detail.supportsRequestedPaymentMethods === false) {
        cleanup();
        reject(new Error('TIPT does not support the requested payment method(s).'));
        return;
      }
      if (detail.supportsRequestedIntents === false) {
        cleanup();
        reject(new Error('TIPT does not support the requested intent(s).'));
        return;
      }
      cleanup();
      resolve(detail);
    };

    const cleanup = () => {
      window.clearTimeout(timer);
      window.removeEventListener(MPP_EXTENSION_EVENT, onResponse as EventListener);
    };

    window.addEventListener(MPP_EXTENSION_EVENT, onResponse as EventListener);
    window.dispatchEvent(new CustomEvent(MPP_EXTENSION_EVENT, {
      detail: {
        type: 'request',
        paymentMethods: ['lightning'],
        intents: ['charge'],
      },
    }));
  });
}

function requestCredentialFromExtension(
  detail: MppExtChallengeDetail,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for TIPT payment approval.'));
    }, timeoutMs);

    const onPayResponse = (event: Event) => {
      const response = (event as CustomEvent<MppExtCredentialDetail>).detail;
      if (!response || response.requestId !== detail.requestId) return;

      cleanup();

      if (!response.approved) {
        reject(new Error(response.error ?? 'TIPT declined payment.'));
        return;
      }
      if (!response.credential) {
        reject(new Error('TIPT approved payment but returned no credential.'));
        return;
      }
      resolve(response.credential);
    };

    const cleanup = () => {
      window.clearTimeout(timer);
      window.removeEventListener(MPP_CREDENTIAL_EVENT, onPayResponse as EventListener);
    };

    window.addEventListener(MPP_CREDENTIAL_EVENT, onPayResponse as EventListener);
    window.dispatchEvent(new CustomEvent(MPP_CHALLENGE_EVENT, { detail }));
  });
}

export interface CreateTiptLightningClientOptions {
  fetch?: typeof globalThis.fetch;
  polyfill?: boolean;
  paymentTimeoutMs?: number;
  probeExtension?: boolean;
  extensionProbeTimeoutMs?: number;
}

/**
 * Creates an MPP Lightning client that routes 402 payment approvals through
 * the TIPT browser extension event bridge.
 */
export function createTiptLightningClient(options: CreateTiptLightningClientOptions = {}) {
  requirePageEventBridge();

  const paymentTimeoutMs = options.paymentTimeoutMs ?? DEFAULT_PAYMENT_TIMEOUT_MS;
  const extensionProbeTimeoutMs =
    options.extensionProbeTimeoutMs ?? DEFAULT_EXTENSION_PROBE_TIMEOUT_MS;

  const extensionBackedCharge = Method.toClient(lightningChargeMethod, {
    async createCredential({ challenge }) {
      if (options.probeExtension !== false) {
        await waitForExtensionResponse(extensionProbeTimeoutMs);
      }

      const invoice = challenge.request.methodDetails.invoice;
      const requestId = randomRequestId();
      const request = PaymentRequest.serialize(challenge.request);
      const opaque = challenge.opaque ? PaymentRequest.serialize(challenge.opaque) : undefined;

      return requestCredentialFromExtension(
        {
          requestId,
          invoice,
          amountSats: parseAmountSats(challenge.request.amount),
          scheme: 'Payment',
          challenge: {
            id: challenge.id,
            realm: challenge.realm,
            method: challenge.method,
            intent: challenge.intent,
            request,
            expires: challenge.expires,
            opaque,
          },
        },
        paymentTimeoutMs,
      );
    },
  });

  return Mppx.create({
    ...(options.fetch ? { fetch: options.fetch } : {}),
    polyfill: options.polyfill ?? true,
    methods: [extensionBackedCharge],
  });
}

export function restoreTiptLightningClientFetch(): void {
  Mppx.restore();
}
