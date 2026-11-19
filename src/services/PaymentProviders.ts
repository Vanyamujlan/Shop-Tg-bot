import crypto from 'crypto';
import { getEnvConfig } from '../config/env.ts';
import {
  BalanceTopUpProvider,
  BalanceTopUpStatus,
  XRocketErrorProblemDetails,
} from '../types.ts';

export interface XRocketAssetOption {
  code: string;
  label: string;
  networks: string[];
  defaultNetwork: string;
}

export const XROCKET_SUPPORTED_ASSETS: XRocketAssetOption[] = [
  {
    code: 'USDT',
    label: 'USDT',
    networks: ['TON', 'TRC-20', 'BEP-20', 'ERC-20'],
    defaultNetwork: 'TON',
  },
  {
    code: 'TON',
    label: 'TON',
    networks: ['TON'],
    defaultNetwork: 'TON',
  },
  {
    code: 'BTC',
    label: 'BTC',
    networks: ['Bitcoin'],
    defaultNetwork: 'Bitcoin',
  },
  {
    code: 'ETH',
    label: 'ETH',
    networks: ['ERC-20'],
    defaultNetwork: 'ERC-20',
  },
  {
    code: 'TRX',
    label: 'TRX',
    networks: ['TRC-20'],
    defaultNetwork: 'TRC-20',
  },
  {
    code: 'BNB',
    label: 'BNB',
    networks: ['BEP-20'],
    defaultNetwork: 'BEP-20',
  },
  {
    code: 'USDC',
    label: 'USDC',
    networks: ['ERC-20', 'BEP-20'],
    defaultNetwork: 'ERC-20',
  },
];

export interface ProviderMetadata {
  id: BalanceTopUpProvider;
  title: string;
  shortTitle: string;
  buttonLabel: string;
  feePercent: number;
  defaultCurrency: string;
  supportedCurrencies: string[];
  supportedNetworks: string[];
  minAmount: number;
  maxAmount: number;
  presetAmounts: number[];
  apiBaseUrl: string;
  officialDocsUrl: string;
  description: string;
}

export const PAYMENT_PROVIDER_CATALOG: Record<BalanceTopUpProvider, ProviderMetadata> = {
  cryptobot: {
    id: 'cryptobot',
    title: 'CryptoBot (@CryptoBot)',
    shortTitle: 'CryptoBot',
    buttonLabel: '💎 CryptoBot [3%]',
    feePercent: 3,
    defaultCurrency: 'USDT',
    supportedCurrencies: ['USDT', 'TON', 'BTC', 'ETH', 'TRX', 'BNB', 'USDC', 'LTC', 'RUB'],
    supportedNetworks: [
      'TON (The Open Network)',
      'TRC-20 (TRON)',
      'ERC-20 (Ethereum)',
      'BEP-20 (BNB Smart Chain)',
      'Bitcoin Network',
      'Litecoin Network',
    ],
    minAmount: 1,
    maxAmount: 500000,
    presetAmounts: [100, 250, 500, 1000, 2500, 5000],
    apiBaseUrl: 'https://pay.crypt.bot/api',
    officialDocsUrl: 'https://help.send.tg/en/articles/10279948-crypto-pay-api',
    description:
      'Оплата через официальный сервис @CryptoBot (комиссия магазина 3%).',
  },
  xrocket: {
    id: 'xrocket',
    title: 'xRocket Pay (@xrocket)',
    shortTitle: 'xRocket',
    buttonLabel: '🚀 xRocket [2%]',
    feePercent: 2,
    defaultCurrency: 'USDT',
    supportedCurrencies: ['USDT', 'TON', 'TONCOIN', 'BTC', 'ETH', 'TRX', 'BNB', 'USDC'],
    supportedNetworks: [
      'TON',
      'TRC-20',
      'BEP-20',
      'ERC-20',
      'Bitcoin',
    ],
    minAmount: 1,
    maxAmount: 500000,
    presetAmounts: [100, 250, 500, 1000, 2500, 5000],
    apiBaseUrl: 'https://pay.api.xrocket.exchange',
    officialDocsUrl: 'https://docs.xrocket.exchange/ru/api/pay/reference/pay-rest-api',
    description:
      'Оплата криптовалютой (USDT, TON, BTC, ETH, TRX, BNB, USDC) через xRocket Pay REST API v1 (комиссия магазина 2%).',
  },
};

export interface CreateProviderInvoiceInput {
  paymentId: string;
  provider: BalanceTopUpProvider;
  amountPaid: number;
  currency: string;
  network?: string;
  description: string;
  expiresInSeconds?: number;
}

export interface CreatedProviderInvoice {
  externalInvoiceId: string;
  payUrl: string;
  status: BalanceTopUpStatus;
  amountPaid: number;
  currency: string;
  recipientMerchantId?: string;
  expiresAt?: string;
}

export interface VerifiedProviderInvoice {
  externalInvoiceId: string;
  paymentId?: string;
  status: BalanceTopUpStatus;
  amountPaid: number;
  currency: string;
  recipientMerchantId?: string;
  paidAt?: string;
}

export interface ParsedWebhookNotification {
  provider: BalanceTopUpProvider;
  externalInvoiceId: string;
  paymentId?: string;
  status: BalanceTopUpStatus;
  amountPaid?: number;
  currency?: string;
  recipientMerchantId?: string;
}

export interface HttpTransportRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

export interface HttpTransportResponse {
  status: number;
  ok: boolean;
  json: unknown;
}

export type ProviderHttpTransport = (
  req: HttpTransportRequest,
) => Promise<HttpTransportResponse>;

export class XRocketApiError extends Error {
  public readonly httpStatus: number;
  public readonly problemDetails: XRocketErrorProblemDetails;

  constructor(
    message: string,
    httpStatus: number,
    problemDetails: XRocketErrorProblemDetails = {},
  ) {
    super(message);
    this.name = 'XRocketApiError';
    this.httpStatus = httpStatus;
    this.problemDetails = problemDetails;
  }
}

/**
 * Builds a canonical xRocket Pay REST API v1 URL without ever duplicating `/api/v1`.
 * Supports both Production (`https://pay.api.xrocket.exchange`) and
 * Testnet (`https://pay.api.testnet.xrocket.exchange`), as well as base URLs that
 * already include `/api/v1`.
 */
export function buildXRocketApiV1Url(baseUrl: string, endpointPath: string): string {
  const cleanBase = (baseUrl || 'https://pay.api.xrocket.exchange')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api\/v1$/i, '');
  const cleanPath = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;
  return `${cleanBase}/api/v1${cleanPath}`;
}

/**
 * Masks API tokens and secrets so they are never exposed in logs or error messages.
 */
export function maskSecret(value: string | undefined | null): string {
  if (!value) return '[NOT_SET]';
  const trimmed = value.trim();
  if (trimmed.length <= 6) return '***';
  return `${trimmed.slice(0, 3)}***${trimmed.slice(-2)}`;
}

/**
 * Redacts any configured payment provider secrets from log strings or error messages.
 */
export function redactSecretsFromText(text: string): string {
  if (!text) return text;
  const cfg = getEnvConfig();
  const secrets = [
    cfg.cryptobotApiToken,
    cfg.xrocketApiKey,
    cfg.telegramBotToken,
    cfg.webhookSecret,
  ].filter((s): s is string => Boolean(s && s.trim().length >= 4));

  let redacted = text;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join(maskSecret(secret));
  }
  return redacted;
}

function safeTimingEqualHexOrUtf8(expected: string, actual: string): boolean {
  if (!expected || !actual) return false;
  const bufA = Buffer.from(expected, 'utf8');
  const bufB = Buffer.from(actual, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Official CryptoBot Webhook Signature Verification:
 * Secret key = SHA256(Crypto-Pay-API-Token) (raw 32-byte digest).
 * Signature = HMAC-SHA256(rawBody, secretKey) in hex.
 * Header: `crypto-pay-api-signature`
 */
export function computeCryptoBotWebhookSignature(
  rawBody: string,
  apiToken: string,
): string {
  const secretKey = crypto.createHash('sha256').update(apiToken, 'utf8').digest();
  return crypto.createHmac('sha256', secretKey).update(rawBody, 'utf8').digest('hex');
}

export function verifyCryptoBotWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  apiToken?: string,
): boolean {
  const token = (apiToken ?? getEnvConfig().cryptobotApiToken).trim();
  if (!token || !signatureHeader) return false;
  const expected = computeCryptoBotWebhookSignature(rawBody, token);
  return safeTimingEqualHexOrUtf8(expected.toLowerCase(), signatureHeader.trim().toLowerCase());
}

/**
 * Official xRocket Pay Webhook Signature Verification:
 * Secret key = SHA256(XROCKET_API_KEY) (raw 32-byte digest).
 * Signature = HMAC-SHA256(rawBody, secretKey) in hex.
 * Header: `rocket-pay-signature`
 */
export function computeXRocketWebhookSignature(
  rawBody: string,
  apiKey: string,
): string {
  const secretKey = crypto.createHash('sha256').update(apiKey, 'utf8').digest();
  return crypto.createHmac('sha256', secretKey).update(rawBody, 'utf8').digest('hex');
}

export function verifyXRocketWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  apiKey?: string,
): boolean {
  const key = (apiKey ?? getEnvConfig().xrocketApiKey).trim();
  if (!key || !signatureHeader) return false;
  const expected = computeXRocketWebhookSignature(rawBody, key);
  return safeTimingEqualHexOrUtf8(expected.toLowerCase(), signatureHeader.trim().toLowerCase());
}

function normalizeProviderStatus(rawStatus: string | undefined): BalanceTopUpStatus {
  const s = (rawStatus || '').trim().toLowerCase();
  if (s === 'paid' || s === 'completed' || s === 'success') {
    return 'paid';
  }
  if (s === 'expired') {
    return 'expired';
  }
  if (s === 'cancelled' || s === 'canceled') {
    return 'cancelled';
  }
  if (s === 'failed' || s === 'error') {
    return 'failed';
  }
  return 'pending';
}

export function normalizeCurrencyCode(currency: string): string {
  const upper = (currency || '').trim().toUpperCase();
  if (upper === 'TONCOIN') return 'TON';
  return upper;
}

function parseXRocketErrorDetails(
  httpStatus: number,
  rawJson: unknown,
): { errorMessage: string; details: XRocketErrorProblemDetails } {
  const obj =
    rawJson && typeof rawJson === 'object'
      ? (rawJson as Record<string, unknown>)
      : {};

  const details: XRocketErrorProblemDetails = {
    status: typeof obj.status === 'number' ? obj.status : httpStatus,
    type: typeof obj.type === 'string' ? obj.type : undefined,
    title: typeof obj.title === 'string' ? obj.title : undefined,
    detail:
      typeof obj.detail === 'string'
        ? obj.detail
        : typeof obj.message === 'string'
          ? obj.message
          : undefined,
    instance: typeof obj.instance === 'string' ? obj.instance : undefined,
    kind: typeof obj.kind === 'string' ? obj.kind : undefined,
  };

  const parts: string[] = [`HTTP ${httpStatus}`];
  if (details.title) parts.push(details.title);
  if (details.detail && details.detail !== details.title) {
    parts.push(details.detail);
  }
  if (details.kind) parts.push(`kind=${details.kind}`);
  if (details.instance) parts.push(`instance=${details.instance}`);

  const formatted = redactSecretsFromText(
    `Ошибка xRocket Pay API (${parts.join(' | ')})`,
  );
  return { errorMessage: formatted, details };
}

const defaultFetchTransport: ProviderHttpTransport = async (req) => {
  const response = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return {
    status: response.status,
    ok: response.ok,
    json,
  };
};

export interface ProviderCredentialsOverride {
  cryptobotApiToken?: string;
  cryptobotApiUrl?: string;
  xrocketApiKey?: string;
  xrocketApiUrl?: string;
}

export class PaymentProviderGateway {
  private transport: ProviderHttpTransport;
  private credentialsOverride: ProviderCredentialsOverride;

  constructor(
    transport: ProviderHttpTransport = defaultFetchTransport,
    credentialsOverride: ProviderCredentialsOverride = {},
  ) {
    this.transport = transport;
    this.credentialsOverride = credentialsOverride;
  }

  public setTransport(transport: ProviderHttpTransport): void {
    this.transport = transport;
  }

  public setCredentialsOverride(override: ProviderCredentialsOverride): void {
    this.credentialsOverride = { ...override };
  }

  private getCredentials() {
    const cfg = getEnvConfig();
    return {
      cryptobotApiToken:
        this.credentialsOverride.cryptobotApiToken ?? cfg.cryptobotApiToken,
      cryptobotApiUrl:
        this.credentialsOverride.cryptobotApiUrl ?? cfg.cryptobotApiUrl,
      xrocketApiKey:
        this.credentialsOverride.xrocketApiKey ?? cfg.xrocketApiKey,
      xrocketApiUrl:
        this.credentialsOverride.xrocketApiUrl ?? cfg.xrocketApiUrl,
    };
  }

  public isProviderConfigured(provider: BalanceTopUpProvider): boolean {
    const creds = this.getCredentials();
    if (provider === 'cryptobot') {
      return Boolean(creds.cryptobotApiToken && creds.cryptobotApiToken.trim().length > 0);
    }
    if (provider === 'xrocket') {
      return Boolean(creds.xrocketApiKey && creds.xrocketApiKey.trim().length > 0);
    }
    return false;
  }

  public getProviderStatusSummary(): Record<
    BalanceTopUpProvider,
    { configured: boolean; feePercent: number; maskedKey: string }
  > {
    const creds = this.getCredentials();
    return {
      cryptobot: {
        configured: this.isProviderConfigured('cryptobot'),
        feePercent: PAYMENT_PROVIDER_CATALOG.cryptobot.feePercent,
        maskedKey: maskSecret(creds.cryptobotApiToken),
      },
      xrocket: {
        configured: this.isProviderConfigured('xrocket'),
        feePercent: PAYMENT_PROVIDER_CATALOG.xrocket.feePercent,
        maskedKey: maskSecret(creds.xrocketApiKey),
      },
    };
  }

  public verifyWebhookSignature(
    provider: BalanceTopUpProvider,
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): boolean {
    const creds = this.getCredentials();
    const getHeader = (name: string): string | undefined => {
      const lower = name.toLowerCase();
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === lower) {
          return Array.isArray(v) ? v[0] : v;
        }
      }
      return undefined;
    };

    if (provider === 'cryptobot') {
      return verifyCryptoBotWebhookSignature(
        rawBody,
        getHeader('crypto-pay-api-signature'),
        creds.cryptobotApiToken,
      );
    }
    if (provider === 'xrocket') {
      return verifyXRocketWebhookSignature(
        rawBody,
        getHeader('rocket-pay-signature'),
        creds.xrocketApiKey,
      );
    }
    return false;
  }

  /**
   * Parses webhook JSON payload into a normalized notification object.
   * Note: We NEVER trust the webhook payload alone to credit funds; `BalanceService`
   * always performs a subsequent server-side API query (`verifyInvoiceStatus`) to confirm.
   */
  public parseWebhookPayload(
    provider: BalanceTopUpProvider,
    body: unknown,
  ): ParsedWebhookNotification {
    if (!body || typeof body !== 'object') {
      throw new Error('Некорректный JSON-пейлоад вебхука');
    }
    const obj = body as Record<string, unknown>;

    if (provider === 'cryptobot') {
      const payloadObj =
        obj.payload && typeof obj.payload === 'object'
          ? (obj.payload as Record<string, unknown>)
          : obj;
      const externalInvoiceId = String(payloadObj.invoice_id ?? '');
      if (!externalInvoiceId) {
        throw new Error('В вебхуке CryptoBot отсутствует invoice_id');
      }
      const currencyRaw =
        payloadObj.currency_type === 'fiat'
          ? String(payloadObj.fiat ?? 'RUB')
          : String(payloadObj.asset ?? payloadObj.fiat ?? 'USDT');
      return {
        provider: 'cryptobot',
        externalInvoiceId,
        paymentId: payloadObj.payload ? String(payloadObj.payload) : undefined,
        status: normalizeProviderStatus(String(payloadObj.status ?? 'paid')),
        amountPaid:
          payloadObj.amount !== undefined ? Number(payloadObj.amount) : undefined,
        currency: normalizeCurrencyCode(currencyRaw),
      };
    }

    if (provider === 'xrocket') {
      const dataObj =
        obj.data && typeof obj.data === 'object'
          ? (obj.data as Record<string, unknown>)
          : obj;
      const externalInvoiceId = String(dataObj.id ?? dataObj.invoiceId ?? '');
      if (!externalInvoiceId) {
        throw new Error('В вебхуке xRocket отсутствует id инвойса');
      }
      const rawPaymentId =
        dataObj.clientInvoiceId ?? dataObj.payload ?? undefined;
      const rawAmount = dataObj.priceAmount ?? dataObj.amount;
      const rawCurrency = dataObj.priceCurrency ?? dataObj.currency ?? 'USDT';

      return {
        provider: 'xrocket',
        externalInvoiceId,
        paymentId: rawPaymentId ? String(rawPaymentId) : undefined,
        status: normalizeProviderStatus(String(dataObj.status ?? 'paid')),
        amountPaid: rawAmount !== undefined ? Number(rawAmount) : undefined,
        currency: normalizeCurrencyCode(String(rawCurrency)),
      };
    }

    throw new Error(`Неизвестный платёжный провайдер: ${String(provider)}`);
  }

  /**
   * Creates an invoice via the provider's official API.
   */
  public async createInvoice(
    input: CreateProviderInvoiceInput,
  ): Promise<CreatedProviderInvoice> {
    if (!this.isProviderConfigured(input.provider)) {
      throw new Error(
        `Платёжный провайдер ${PAYMENT_PROVIDER_CATALOG[input.provider].shortTitle} не настроен (отсутствует API-ключ в переменных окружения).`,
      );
    }

    const creds = this.getCredentials();
    const expiresInSeconds = input.expiresInSeconds ?? 1800; // 30 minutes default

    if (input.provider === 'cryptobot') {
      const upperCurr = input.currency.trim().toUpperCase();
      const isFiat = upperCurr === 'RUB' || upperCurr === 'USD' || upperCurr === 'EUR';
      const bodyPayload: Record<string, unknown> = isFiat
        ? {
            currency_type: 'fiat',
            fiat: upperCurr,
            accepted_assets: 'USDT,TON,BTC,ETH,LTC,BNB,TRX,USDC',
            amount: input.amountPaid.toFixed(2),
            description: input.description,
            payload: input.paymentId,
            expires_in: expiresInSeconds,
          }
        : {
            currency_type: 'crypto',
            asset: upperCurr,
            amount: String(input.amountPaid),
            description: input.description,
            payload: input.paymentId,
            expires_in: expiresInSeconds,
          };

      const res = await this.transport({
        url: `${creds.cryptobotApiUrl.replace(/\/+$/, '')}/createInvoice`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Crypto-Pay-API-Token': creds.cryptobotApiToken,
        },
        body: JSON.stringify(bodyPayload),
      });

      const data = res.json as {
        ok?: boolean;
        error?: { code?: number; name?: string };
        result?: {
          invoice_id?: number | string;
          status?: string;
          amount?: string | number;
          asset?: string;
          fiat?: string;
          currency_type?: string;
          bot_invoice_url?: string;
          pay_url?: string;
          mini_app_invoice_url?: string;
          expiration_date?: string;
        };
      } | null;

      if (!res.ok || !data?.ok || !data.result?.invoice_id) {
        const errName = data?.error?.name || `HTTP_${res.status}`;
        throw new Error(
          redactSecretsFromText(`Ошибка создания счёта CryptoBot: ${errName}`),
        );
      }

      const inv = data.result;
      const payUrl =
        inv.bot_invoice_url || inv.pay_url || inv.mini_app_invoice_url || '';
      if (!payUrl) {
        throw new Error('CryptoBot не вернул ссылку на оплату (bot_invoice_url)');
      }

      const resolvedCurr =
        inv.currency_type === 'fiat'
          ? String(inv.fiat || upperCurr)
          : String(inv.asset || upperCurr);

      return {
        externalInvoiceId: String(inv.invoice_id),
        payUrl,
        status: normalizeProviderStatus(inv.status || 'active'),
        amountPaid: Number(inv.amount ?? input.amountPaid),
        currency: normalizeCurrencyCode(resolvedCurr),
        expiresAt:
          inv.expiration_date ||
          new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      };
    }

    if (input.provider === 'xrocket') {
      // Official xRocket Pay REST API v1: POST /api/v1/invoices
      // Docs: https://docs.xrocket.exchange/ru/api/pay/reference/pay-rest-api
      const priceCurrency = normalizeCurrencyCode(input.currency);
      const expiresInMs = expiresInSeconds * 1000;
      const bodyPayload = {
        priceAmount: input.amountPaid.toFixed(2),
        priceCurrency,
        payCurrencies: [priceCurrency],
        clientInvoiceId: input.paymentId,
        description: input.description,
        expiresIn: expiresInMs,
      };

      const url = buildXRocketApiV1Url(creds.xrocketApiUrl, '/invoices');
      const res = await this.transport({
        url,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${creds.xrocketApiKey}`,
        },
        body: JSON.stringify(bodyPayload),
      });

      if (!res.ok) {
        const { errorMessage, details } = parseXRocketErrorDetails(
          res.status,
          res.json,
        );
        throw new XRocketApiError(errorMessage, res.status, details);
      }

      const rawObj =
        res.json && typeof res.json === 'object'
          ? (res.json as Record<string, unknown>)
          : {};
      const inv =
        rawObj.data && typeof rawObj.data === 'object'
          ? (rawObj.data as Record<string, unknown>)
          : rawObj;

      const linksObj =
        inv.links && typeof inv.links === 'object'
          ? (inv.links as Record<string, unknown>)
          : {};

      const externalId = inv.id !== undefined ? String(inv.id) : '';
      const payUrl = String(
        linksObj.telegramBotLink ??
          linksObj.webLink ??
          inv.telegramBotLink ??
          inv.link ??
          inv.payUrl ??
          '',
      );

      if (!externalId || !payUrl) {
        const { errorMessage, details } = parseXRocketErrorDetails(
          res.status,
          res.json,
        );
        throw new XRocketApiError(
          `${errorMessage} — ответ API не содержит id или links.telegramBotLink`,
          res.status,
          details,
        );
      }

      const resolvedAmount = Number(inv.priceAmount ?? inv.amount ?? input.amountPaid);
      const resolvedCurrency = normalizeCurrencyCode(
        String(inv.priceCurrency ?? inv.currency ?? priceCurrency),
      );
      const resolvedExpiresAt =
        typeof inv.expiresAt === 'string' && inv.expiresAt.length > 0
          ? inv.expiresAt
          : new Date(Date.now() + expiresInMs).toISOString();

      return {
        externalInvoiceId: externalId,
        payUrl,
        status: normalizeProviderStatus(String(inv.status ?? 'PENDING')),
        amountPaid: resolvedAmount,
        currency: resolvedCurrency,
        expiresAt: resolvedExpiresAt,
      };
    }

    throw new Error(`Неподдерживаемый платёжный провайдер: ${String(input.provider)}`);
  }

  /**
   * Queries the provider's authoritative server-side API to verify the real status,
   * amount, currency, and clientInvoiceId/payload of an invoice.
   */
  public async verifyInvoiceStatus(params: {
    provider: BalanceTopUpProvider;
    externalInvoiceId: string;
    paymentId: string;
  }): Promise<VerifiedProviderInvoice> {
    if (!this.isProviderConfigured(params.provider)) {
      throw new Error(
        `Платёжный провайдер ${PAYMENT_PROVIDER_CATALOG[params.provider].shortTitle} не настроен.`,
      );
    }

    const creds = this.getCredentials();

    if (params.provider === 'cryptobot') {
      const url = `${creds.cryptobotApiUrl.replace(/\/+$/, '')}/getInvoices?invoice_ids=${encodeURIComponent(params.externalInvoiceId)}`;
      const res = await this.transport({
        url,
        method: 'GET',
        headers: {
          'Crypto-Pay-API-Token': creds.cryptobotApiToken,
        },
      });

      const data = res.json as {
        ok?: boolean;
        error?: { name?: string };
        result?:
          | {
              items?: Array<{
                invoice_id?: number | string;
                status?: string;
                amount?: string | number;
                asset?: string;
                fiat?: string;
                currency_type?: string;
                payload?: string;
                paid_at?: string;
              }>;
            }
          | Array<{
              invoice_id?: number | string;
              status?: string;
              amount?: string | number;
              asset?: string;
              fiat?: string;
              currency_type?: string;
              payload?: string;
              paid_at?: string;
            }>;
      } | null;

      if (!res.ok || !data?.ok || !data.result) {
        throw new Error(
          redactSecretsFromText(
            `Ошибка проверки статуса счёта CryptoBot: ${data?.error?.name || res.status}`,
          ),
        );
      }

      const items = Array.isArray(data.result)
        ? data.result
        : data.result.items || [];
      const found = items.find(
        (item) => String(item.invoice_id) === String(params.externalInvoiceId),
      );
      if (!found) {
        throw new Error(
          `Счёт CryptoBot #${params.externalInvoiceId} не найден в ответе API`,
        );
      }

      const rawCurrency =
        found.currency_type === 'fiat'
          ? String(found.fiat || 'RUB')
          : String(found.asset || found.fiat || 'USDT');

      return {
        externalInvoiceId: String(found.invoice_id),
        paymentId: found.payload ? String(found.payload) : undefined,
        status: normalizeProviderStatus(found.status),
        amountPaid: Number(found.amount ?? 0),
        currency: normalizeCurrencyCode(rawCurrency),
        paidAt: found.paid_at,
      };
    }

    if (params.provider === 'xrocket') {
      // Official xRocket Pay REST API v1: GET /api/v1/invoices?ids=<id>
      const url = buildXRocketApiV1Url(
        creds.xrocketApiUrl,
        `/invoices?ids=${encodeURIComponent(params.externalInvoiceId)}`,
      );
      const res = await this.transport({
        url,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${creds.xrocketApiKey}`,
        },
      });

      if (!res.ok) {
        const { errorMessage, details } = parseXRocketErrorDetails(
          res.status,
          res.json,
        );
        throw new XRocketApiError(errorMessage, res.status, details);
      }

      const raw = res.json;
      let items: Array<Record<string, unknown>> = [];
      if (Array.isArray(raw)) {
        items = raw as Array<Record<string, unknown>>;
      } else if (raw && typeof raw === 'object') {
        const obj = raw as Record<string, unknown>;
        if (Array.isArray(obj.data)) {
          items = obj.data as Array<Record<string, unknown>>;
        } else if (Array.isArray(obj.items)) {
          items = obj.items as Array<Record<string, unknown>>;
        } else if (obj.data && typeof obj.data === 'object') {
          items = [obj.data as Record<string, unknown>];
        } else if (obj.id !== undefined) {
          items = [obj];
        }
      }

      const found = items.find(
        (item) => String(item.id) === String(params.externalInvoiceId),
      );
      if (!found) {
        throw new XRocketApiError(
          `Счёт xRocket Pay #${params.externalInvoiceId} не найден в ответе API v1`,
          404,
          {
            status: 404,
            title: 'Not Found',
            detail: `Invoice ${params.externalInvoiceId} not returned by GET /api/v1/invoices`,
            kind: 'invoice_not_found',
          },
        );
      }

      const resolvedPaymentId =
        found.clientInvoiceId !== undefined
          ? String(found.clientInvoiceId)
          : found.payload !== undefined
            ? String(found.payload)
            : undefined;

      return {
        externalInvoiceId: String(found.id),
        paymentId: resolvedPaymentId,
        status: normalizeProviderStatus(String(found.status ?? 'PENDING')),
        amountPaid: Number(found.priceAmount ?? found.amount ?? 0),
        currency: normalizeCurrencyCode(
          String(found.priceCurrency ?? found.currency ?? 'USDT'),
        ),
        paidAt:
          typeof found.paidAt === 'string'
            ? found.paidAt
            : typeof found.paid === 'string'
              ? found.paid
              : undefined,
      };
    }

    throw new Error(`Неизвестный платёжный провайдер: ${String(params.provider)}`);
  }
}

export const paymentProviderGateway = new PaymentProviderGateway();
