import crypto from 'crypto';
import { getEnvConfig } from '../config/env.ts';
import { BalanceTopUpProvider, BalanceTopUpStatus } from '../types.ts';

export interface ProviderMetadata {
  id: BalanceTopUpProvider;
  title: string;
  shortTitle: string;
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
    feePercent: 3,
    defaultCurrency: 'RUB',
    supportedCurrencies: ['RUB', 'USDT', 'TON', 'BTC', 'ETH', 'TRX', 'BNB', 'USDC', 'LTC'],
    supportedNetworks: [
      'TON (The Open Network)',
      'TRC-20 (TRON)',
      'ERC-20 (Ethereum)',
      'BEP-20 (BNB Smart Chain)',
      'Bitcoin Network',
      'Litecoin Network',
    ],
    minAmount: 10,
    maxAmount: 500000,
    presetAmounts: [100, 250, 500, 1000, 2500, 5000],
    apiBaseUrl: 'https://pay.crypt.bot/api',
    officialDocsUrl: 'https://help.send.tg/en/articles/10279948-crypto-pay-api',
    description:
      'Оплата криптовалютой (USDT, TON, BTC, ETH, TRX, BNB, USDC, LTC) через официальный Telegram-сервис @CryptoBot (с поддержкой автоконвертации из RUB).',
  },
  lolzteam: {
    id: 'lolzteam',
    title: 'Lolzteam Market (LZT)',
    shortTitle: 'Lolzteam',
    feePercent: 5,
    defaultCurrency: 'RUB',
    supportedCurrencies: ['RUB'],
    supportedNetworks: ['Lolzteam Market Balance / СБП / Карты / Криптовалюта через LZT'],
    minAmount: 10,
    maxAmount: 500000,
    presetAmounts: [100, 250, 500, 1000, 2500, 5000],
    apiBaseUrl: 'https://prod-api.lzt.market',
    officialDocsUrl: 'https://lzt-market.readme.io/reference/invoicecreate',
    description: 'Пополнение через официальный инвойс Lolzteam Market API (POST /invoice).',
  },
  xrocket: {
    id: 'xrocket',
    title: 'xRocket Pay (@xrocket)',
    shortTitle: 'xRocket',
    feePercent: 2,
    defaultCurrency: 'USDT',
    supportedCurrencies: ['USDT', 'TON', 'TONCOIN', 'BTC', 'ETH', 'TRX', 'BNB', 'USDC'],
    supportedNetworks: [
      'TON (The Open Network)',
      'TRC-20 (TRON)',
      'ERC-20 (Ethereum)',
      'BEP-20 (BNB Smart Chain)',
      'Bitcoin Network',
    ],
    minAmount: 1,
    maxAmount: 500000,
    presetAmounts: [100, 250, 500, 1000, 2500, 5000],
    apiBaseUrl: 'https://pay.xrocket.tg',
    officialDocsUrl: 'https://pay.xrocket.tg/api',
    description:
      'Прямая оплата криптовалютой (USDT, TONCOIN, BTC, ETH, TRX, BNB, USDC) с минимальной комиссией 2% через @xrocket.',
  },
};

export interface CreateProviderInvoiceInput {
  paymentId: string;
  provider: BalanceTopUpProvider;
  amountPaid: number;
  currency: string;
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
    cfg.lolzteamApiToken,
    cfg.lolzteamWebhookSecret,
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
 * Secret key = SHA256(Rocket-Pay-Key) (raw 32-byte digest).
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

/**
 * Official Lolzteam Market Invoice Webhook Verification:
 * Checks `x-secret-key` header against configured `LOLZTEAM_WEBHOOK_SECRET` (or `LOLZTEAM_API_TOKEN` fallback)
 * using constant-time comparison. Also supports HMAC-SHA256 hex of rawBody if signed with secret.
 */
export function computeLolzteamWebhookSignature(
  rawBody: string,
  secret: string,
): string {
  return crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

export function verifyLolzteamWebhookSignature(
  rawBody: string,
  secretHeader: string | undefined,
  configuredSecret?: string,
): boolean {
  const cfg = getEnvConfig();
  const secret = (
    configuredSecret ??
    (cfg.lolzteamWebhookSecret || cfg.lolzteamApiToken)
  ).trim();
  if (!secret || !secretHeader) return false;
  const cleanHeader = secretHeader.trim();
  if (safeTimingEqualHexOrUtf8(secret, cleanHeader)) {
    return true;
  }
  const expectedHmac = computeLolzteamWebhookSignature(rawBody, secret);
  return safeTimingEqualHexOrUtf8(expectedHmac.toLowerCase(), cleanHeader.toLowerCase());
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
  lolzteamApiToken?: string;
  lolzteamMerchantId?: string;
  lolzteamWebhookSecret?: string;
  lolzteamApiUrl?: string;
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
      lolzteamApiToken:
        this.credentialsOverride.lolzteamApiToken ?? cfg.lolzteamApiToken,
      lolzteamMerchantId:
        this.credentialsOverride.lolzteamMerchantId ?? cfg.lolzteamMerchantId,
      lolzteamWebhookSecret:
        this.credentialsOverride.lolzteamWebhookSecret ?? cfg.lolzteamWebhookSecret,
      lolzteamApiUrl:
        this.credentialsOverride.lolzteamApiUrl ?? cfg.lolzteamApiUrl,
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
    if (provider === 'lolzteam') {
      return Boolean(
        creds.lolzteamApiToken &&
          creds.lolzteamApiToken.trim().length > 0 &&
          creds.lolzteamMerchantId &&
          creds.lolzteamMerchantId.trim().length > 0,
      );
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
      lolzteam: {
        configured: this.isProviderConfigured('lolzteam'),
        feePercent: PAYMENT_PROVIDER_CATALOG.lolzteam.feePercent,
        maskedKey: maskSecret(creds.lolzteamApiToken),
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
    if (provider === 'lolzteam') {
      return verifyLolzteamWebhookSignature(
        rawBody,
        getHeader('x-secret-key') ?? getHeader('x-lolzteam-signature'),
        creds.lolzteamWebhookSecret || creds.lolzteamApiToken,
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
      // CryptoBot official webhook: { update_id, update_type: "invoice_paid", request_date, payload: { invoice_id, status, amount, asset, fiat, currency_type, payload } }
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

    if (provider === 'lolzteam') {
      // Lolzteam official webhook: { invoice_id, payment_id, amount, status, merchant_id, currency, ... } or { invoice: { ... } }
      const invObj =
        obj.invoice && typeof obj.invoice === 'object'
          ? (obj.invoice as Record<string, unknown>)
          : obj;
      const externalInvoiceId = String(invObj.invoice_id ?? invObj.id ?? '');
      if (!externalInvoiceId) {
        throw new Error('В вебхуке Lolzteam отсутствует invoice_id');
      }
      return {
        provider: 'lolzteam',
        externalInvoiceId,
        paymentId: invObj.payment_id ? String(invObj.payment_id) : undefined,
        status: normalizeProviderStatus(String(invObj.status ?? 'paid')),
        amountPaid: invObj.amount !== undefined ? Number(invObj.amount) : undefined,
        currency: normalizeCurrencyCode(String(invObj.currency ?? 'RUB')),
        recipientMerchantId:
          invObj.merchant_id !== undefined ? String(invObj.merchant_id) : undefined,
      };
    }

    if (provider === 'xrocket') {
      // xRocket official webhook: { type: "invoicePay", data: { id, amount, currency, status, payload, payment: ... } }
      const dataObj =
        obj.data && typeof obj.data === 'object'
          ? (obj.data as Record<string, unknown>)
          : obj;
      const externalInvoiceId = String(dataObj.id ?? dataObj.invoiceId ?? '');
      if (!externalInvoiceId) {
        throw new Error('В вебхуке xRocket отсутствует id инвойса');
      }
      return {
        provider: 'xrocket',
        externalInvoiceId,
        paymentId: dataObj.payload ? String(dataObj.payload) : undefined,
        status: normalizeProviderStatus(String(dataObj.status ?? 'paid')),
        amountPaid: dataObj.amount !== undefined ? Number(dataObj.amount) : undefined,
        currency: normalizeCurrencyCode(String(dataObj.currency ?? 'USDT')),
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

    if (input.provider === 'lolzteam') {
      const appUrl = (
        getEnvConfig().webhookUrl || 'http://localhost:3000'
      ).replace(/\/+$/, '');
      const bodyPayload = {
        currency: input.currency.trim().toLowerCase(),
        amount: input.amountPaid,
        payment_id: input.paymentId,
        comment: input.description,
        url_success: `${appUrl}/health`,
        merchant_id: Number(creds.lolzteamMerchantId) || creds.lolzteamMerchantId,
        lifetime: expiresInSeconds,
      };

      const res = await this.transport({
        url: `${creds.lolzteamApiUrl.replace(/\/+$/, '')}/invoice`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${creds.lolzteamApiToken}`,
        },
        body: JSON.stringify(bodyPayload),
      });

      const data = res.json as {
        invoice?: {
          invoice_id?: number | string;
          amount?: number | string;
          currency?: string;
          status?: string;
          url?: string;
          merchant_id?: number | string;
          expires_at?: number | string;
        };
        errors?: string[];
      } | null;

      if (!res.ok || !data?.invoice?.invoice_id || !data.invoice.url) {
        const errMsg = data?.errors?.join(', ') || `HTTP_${res.status}`;
        throw new Error(
          redactSecretsFromText(`Ошибка создания счёта Lolzteam Market: ${errMsg}`),
        );
      }

      const inv = data.invoice;
      const expiresAtIso =
        typeof inv.expires_at === 'number'
          ? new Date(inv.expires_at * 1000).toISOString()
          : typeof inv.expires_at === 'string'
            ? inv.expires_at
            : new Date(Date.now() + expiresInSeconds * 1000).toISOString();

      return {
        externalInvoiceId: String(inv.invoice_id),
        payUrl: inv.url!,
        status: normalizeProviderStatus(inv.status || 'pending'),
        amountPaid: Number(inv.amount ?? input.amountPaid),
        currency: normalizeCurrencyCode(String(inv.currency || input.currency)),
        recipientMerchantId: String(inv.merchant_id ?? creds.lolzteamMerchantId),
        expiresAt: expiresAtIso,
      };
    }

    if (input.provider === 'xrocket') {
      const apiCurrency =
        input.currency.trim().toUpperCase() === 'TON'
          ? 'TONCOIN'
          : input.currency.trim().toUpperCase();
      const bodyPayload = {
        amount: input.amountPaid,
        currency: apiCurrency,
        description: input.description,
        payload: input.paymentId,
        expiredIn: expiresInSeconds,
      };

      const res = await this.transport({
        url: `${creds.xrocketApiUrl.replace(/\/+$/, '')}/tg-invoices`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Rocket-Pay-Key': creds.xrocketApiKey,
        },
        body: JSON.stringify(bodyPayload),
      });

      const data = res.json as {
        success?: boolean;
        message?: string;
        data?: {
          id?: string | number;
          amount?: number | string;
          currency?: string;
          status?: string;
          link?: string;
          payload?: string;
        };
      } | null;

      if (!res.ok || !data?.success || !data.data?.id || !data.data.link) {
        const errMsg = data?.message || `HTTP_${res.status}`;
        throw new Error(
          redactSecretsFromText(`Ошибка создания счёта xRocket Pay: ${errMsg}`),
        );
      }

      const inv = data.data;
      return {
        externalInvoiceId: String(inv.id),
        payUrl: inv.link!,
        status: normalizeProviderStatus(inv.status || 'active'),
        amountPaid: Number(inv.amount ?? input.amountPaid),
        currency: normalizeCurrencyCode(String(inv.currency || input.currency)),
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      };
    }

    throw new Error(`Неподдерживаемый платёжный провайдер: ${String(input.provider)}`);
  }

  /**
   * Queries the provider's authoritative server-side API to verify the real status,
   * amount, currency, paymentId/payload, and merchantId of an invoice.
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

    if (params.provider === 'lolzteam') {
      const query = new URLSearchParams({
        invoice_id: params.externalInvoiceId,
        payment_id: params.paymentId,
      });
      const url = `${creds.lolzteamApiUrl.replace(/\/+$/, '')}/invoice?${query.toString()}`;
      const res = await this.transport({
        url,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${creds.lolzteamApiToken}`,
        },
      });

      const data = res.json as {
        invoice?: {
          invoice_id?: number | string;
          payment_id?: string;
          merchant_id?: number | string;
          amount?: number | string;
          currency?: string;
          status?: string;
          paid_at?: number | string;
        };
        errors?: string[];
      } | null;

      if (!res.ok || !data?.invoice) {
        throw new Error(
          redactSecretsFromText(
            `Ошибка проверки счёта Lolzteam Market: ${data?.errors?.join(', ') || res.status}`,
          ),
        );
      }

      const inv = data.invoice;
      const paidAtIso =
        typeof inv.paid_at === 'number'
          ? new Date(inv.paid_at * 1000).toISOString()
          : typeof inv.paid_at === 'string'
            ? inv.paid_at
            : undefined;

      return {
        externalInvoiceId: String(inv.invoice_id),
        paymentId: inv.payment_id ? String(inv.payment_id) : undefined,
        status: normalizeProviderStatus(inv.status),
        amountPaid: Number(inv.amount ?? 0),
        currency: normalizeCurrencyCode(String(inv.currency || 'RUB')),
        recipientMerchantId:
          inv.merchant_id !== undefined ? String(inv.merchant_id) : undefined,
        paidAt: paidAtIso,
      };
    }

    if (params.provider === 'xrocket') {
      const url = `${creds.xrocketApiUrl.replace(/\/+$/, '')}/tg-invoices/${encodeURIComponent(params.externalInvoiceId)}`;
      const res = await this.transport({
        url,
        method: 'GET',
        headers: {
          'Rocket-Pay-Key': creds.xrocketApiKey,
        },
      });

      const data = res.json as {
        success?: boolean;
        message?: string;
        data?: {
          id?: string | number;
          amount?: number | string;
          currency?: string;
          status?: string;
          payload?: string;
          paid?: string;
        };
      } | null;

      if (!res.ok || !data?.success || !data.data) {
        throw new Error(
          redactSecretsFromText(
            `Ошибка проверки счёта xRocket Pay: ${data?.message || res.status}`,
          ),
        );
      }

      const inv = data.data;
      return {
        externalInvoiceId: String(inv.id),
        paymentId: inv.payload ? String(inv.payload) : undefined,
        status: normalizeProviderStatus(inv.status),
        amountPaid: Number(inv.amount ?? 0),
        currency: normalizeCurrencyCode(String(inv.currency || 'USDT')),
        paidAt: inv.paid,
      };
    }

    throw new Error(`Неизвестный платёжный провайдер: ${String(params.provider)}`);
  }
}

export const paymentProviderGateway = new PaymentProviderGateway();
